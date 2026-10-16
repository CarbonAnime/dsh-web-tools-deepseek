# dsh-web-tools-deepseek

**English** · [简体中文](./README.zh-CN.md)

[![engine](https://github.com/CarbonAnime/dsh-web-tools-deepseek/actions/workflows/engine.yml/badge.svg)](https://github.com/CarbonAnime/dsh-web-tools-deepseek/actions/workflows/engine.yml)
![license](https://img.shields.io/badge/license-MIT-blue)

A provider bundle for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (**DSH**) `ctx.web` seam. It routes `web_search` and `web_fetch` to DeepSeek's own **native Search and Fetch APIs** instead of the model-backed web-search tool, and falls back to the native provider when the tools API fails or returns nothing.

The HTTP work lives in a small **Rust engine** (`crates/engine`, ~900 KiB) spoken to over NDJSON on stdio; the cordis plugin is a thin JavaScript bridge around it.

```text
tool-web ──▶ ctx.web ──▶ this bundle ──┬─▶ WebSearchProvider ─┐
                                       └─▶ WebFetchProvider  ─┤ NDJSON/stdio
                                                              ▼
                                          dsh-web-tools-deepseek(.exe)   (Rust)
                                                              │
                                        POST /v1/tools/search │ POST /v1/tools/fetch
                                                              ▼
                                                    https://api.deepseek.com
```

---

## Why — and what it costs

DSH ships two web providers by default:

| | provider | how it works | billed |
| --- | --- | --- | --- |
| search | `deepseek-official` | a **server-side tool** (`web_search_20250305`) run inside the model call | **tokens** — the results land in your context |
| fetch | `http` | fetches the URL locally, anonymously | free |

This bundle replaces both with DeepSeek's dedicated endpoints:

| | endpoint | billed |
| --- | --- | --- |
| search | `POST /v1/tools/search` | **¥5 per 1,000 successful requests** (≈ ¥0.005 each) |
| fetch | `POST /v1/tools/fetch` | **¥5 per 1,000 successful requests** (≈ ¥0.005 each) |

> **Only successful requests are billed.** A request counts when it returns HTTP 200 *and* produced a result — for search a non-empty `results`, for fetch page content. A 403, a 404, an empty result set, a timeout and a failed call are all **free**. `count` changes how many results you get, never the price. See [Pricing and limits](#pricing-and-limits).

The trade: **a predictable per-call price instead of token cost**, plus search results that arrive as clean structured fields (`title` / `url` / `summary` / `date`) rather than as text the model has to parse out of its own tool output. To go back, see [Rolling back](#rolling-back).

---

## Install

### From a clone or directory

```bash
git clone https://github.com/CarbonAnime/dsh-web-tools-deepseek.git
dsh plugin --profile desktop add "/absolute/path/to/dsh-web-tools-deepseek"
```

### From GitHub

```bash
dsh plugin --profile desktop add "github:CarbonAnime/dsh-web-tools-deepseek"
```

### What the install does

The package declares `dsh.bundle.patch`, so adding it appends to `dsh.profile.bundles` and its [`cordis.patch.yml`](./cordis.patch.yml) is applied. That patch:

1. **inserts** the plugin row (registering `deepseek-tools-api` for both search and fetch), and
2. **overrides the `web` row** so `searchProvider` and `fetchProvider` point at it.

Both halves are required. A patch entry **replaces that row's whole `config`** rather than deep-merging it, so the override must restate *both* keys; and because three providers are then registered (`deepseek-official`, `http`, `deepseek-tools-api`) the seam would otherwise refuse to guess and raise `WEB_PROVIDER_AMBIGUOUS`.

**Restart DSH after installing.** Cordis re-runs `apply()` on a config reload, but the plugin *module* is ESM-cached — code edits and a first mount need a process restart (verified experimentally; see [Troubleshooting](#troubleshooting)).

### Requirements

| | |
| --- | --- |
| DSH | `@deepseek-ai/dsh-desktop` 0.2.x (targets the `ctx.web` provider seam) |
| Node | ≥ 18.17 |
| Credential | `DEEPSEEK_API_KEY` in `$DSH_HOME/.credentials.yaml`, or a literal `apiKey` |
| Rust | **not needed** — `bin/dsh-web-tools-deepseek-win32-x64.exe` is committed. Build it for Linux/macOS, or take a release asset. |

### Building the engine

```bash
cargo build --release          # or: npm run build:engine
node scripts/stage-engine.mjs  # → bin/dsh-web-tools-deepseek-<platform>-<arch>
```

The engine is resolved in this order, so a source checkout, an installed copy and a packed tarball all work:

1. `$DSH_WEB_TOOLS_DEEPSEEK_BIN`
2. the `enginePath` config field
3. `bin/dsh-web-tools-deepseek-<platform>-<arch>[.exe]`
4. `bin/dsh-web-tools-deepseek[.exe]`
5. `target/release/…`, then `target/debug/…` (an unstaged checkout)

---

## Configuration

Every field has a working default, so an empty config block is valid. Override fields on the plugin row in a `cordis.patch.yml` at or after this bundle:

```yaml
- id: web-tools-deepseek
  name: dsh-web-tools-deepseek
  config:
    count: 8
    qps: 4
```

| field | default | meaning |
| --- | --- | --- |
| `apiKey` | `''` | Literal API key. Prefer `apiKeyEnv` — a literal ends up in the config file. |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference, resolved through the `credentials` service **on every call**, so a rotated key is picked up without a restart. |
| `baseURL` | `https://api.deepseek.com` | API origin. |
| `searchProviderId` | `deepseek-tools-api` | Id the search provider registers under; must match `web.searchProvider`. |
| `fetchProviderId` | `deepseek-tools-api` | Id the fetch provider registers under; must match `web.fetchProvider`. |
| `count` | `10` | Results requested when the caller passes no `maxResults` (1–50). Price-neutral. |
| `snippetSource` | `summary` | Which API field becomes each source's `snippet`: `summary` (600–800 chars, *"for models to read"*) or `snippet` (100–200 chars, *"for front-end display"*). See below. |
| `oriQuestion` | `''` | Sent as `ori_question` when non-empty; over 128 characters is truncated with a warning. |
| `localization` | `''` | Sent as `localization` when non-empty. This is an **IP address** used to prefer results local to it — *not* a language tag. For language, put `lang:zh,en` in the query. |
| `blockedAsResult` | `true` | Return fetch 403/404 as a *result* carrying a clear non-content notice (`true`), instead of throwing (`false`). |
| `includeTitle` | `true` | Prepend the API's `title` as an H1 when the Markdown does not already carry it. |
| `timeoutMs` | `30000` | Per-attempt deadline; `0` disables it. |
| `retries` | `1` | Extra attempts for `408` / `429` / `5xx` **and transport failures** (DNS, TLS, socket). |
| `qps` | `5` | Per-endpoint rate limit. Search and fetch are limited independently. |
| `userAgent` | `dsh-web-tools-deepseek/<version>` | `User-Agent` header. |
| `fallbackSearchProviderId` | `deepseek-official` | Another **already registered** provider to retry on when the tools API fails or returns nothing. Empty string disables the fallback. |
| `fallbackOn` | `both` | When the fallback runs: `never`, `error`, `empty`, or `both`. |
| `enginePath` | `''` | Explicit engine binary path; overrides the `bin/` lookup. |
| `diag` | `true` | Append one JSON line per HTTP attempt to the diagnostics log. |

### Why `snippetSource` defaults to `summary`

DeepSeek's documentation labels the two fields by consumer:

> `snippet` — short summary, relevant to the query, usually 100–200 characters, **suitable for front-end display**.
> `summary` — long summary, relevant to the query, usually 600–800 characters, **suitable for models to read**.

The only consumer of a DSH `WebSource` is a model, so `summary` is the faithful default even though it costs several times the context (8 results ≈ 5K characters ≈ 2K tokens). Set `snippetSource: snippet` to spend less.

### Why `need_content` is never sent

`need_content: true` makes the API return each result's full page body in that result's `content` field — a payload the seam's closed `WebSource` type has nowhere to put, so it would be bytes paid for and thrown away. (The API's own `curl` example includes `need_content: true`, which is easy to misread as required; it is not.) Full page text comes from `web_fetch`, which is what it is for.

---

## What it does

### `web_search` → `POST /v1/tools/search`

* Sends `query` and `count` (from `maxResults` when given, otherwise the `count` field), plus `ori_question` / `localization` when non-empty.
* Rejects a blank query and a query longer than the documented 128 characters **locally**, spending no request. Counting is by Unicode code point, so an emoji is never split.
* Maps each result onto the seam's `WebSource` and **drops what the type cannot carry** (`rerank_score`, `authority`, `site_name`, `site_icon`, `content`) rather than smuggling it into `snippet`.
* Validates `date` into `publishedAt` (`YYYY-MM-DD`); a `null` date produces no `publishedAt` at all.
* Never sets the top-level `content`: `WebSearchResult.content` is a prose answer for the model, and stitching N summaries together to fake one would be fabrication.
* Reports `truncated: false` — one request, no pagination, no invented truncation.

**Search syntax** passes through verbatim (the API applies it; this plugin never rewrites the query):

| operator | example | meaning |
| --- | --- | --- |
| `site:` | `DeepSeek site:github.com` | restrict to a site; several OR-joined: `site:github.com OR site:huggingface.co` |
| `-site:` | `DeepSeek -site:example.com` | exclude a site |
| `-` | `DeepSeek -广告` | exclude pages containing a term |
| `-"…"` | `DeepSeek -"release notes"` | exclude a phrase |
| `"…"` | `DeepSeek "exact phrase"` | exact phrase |
| `lang:` | `DeepSeek lang:zh,en` | restrict language |
| `after:` | `after:2025` / `after:2025-01-01` | published after |
| `before:` | `before:2026` / `before:2026-06-01` | published before |

### `web_fetch` → `POST /v1/tools/fetch`

* Validates the URL locally first — non-empty, ≤ 8192 characters, parseable, `http`/`https`, has a host, carries no credentials — and passes the string through unchanged when it does.
* On 200: `{url, statusCode: 200, body: {kind: 'text', content}}`, with the API's `title` prepended as an H1 unless the Markdown already carries it. The comparison strips Markdown escapes, because the API escapes `#` and `-`.
* On **403 / 404** — the API's verdicts for *"refused by safety policy"* and *"could not obtain usable page content"* — returns them as results whose body opens with `[FETCH FAILED — NOT PAGE CONTENT]` and states the URL, the status and the API's own message. A fetch verdict is a **result, not an exception**: a model that asked to read a page should be told the page was refused, not handed a stack trace.
* Every other non-2xx becomes a `WebError` carrying the API's `code`.

### Fallback to the native provider

A search that fails or returns nothing can fall back to another registered provider (`deepseek-official` by default):

| `fallbackOn` | runs when |
| --- | --- |
| `never` | never (pure tools-API behaviour) |
| `error` | the tools API call failed |
| `empty` | the tools API returned zero sources |
| `both` (default) | either |

The target is resolved **per call** from the live registry — plugin load order is not guaranteed and a config reload can replace the other provider — never through `ctx.web.search()`, which would resolve back to this provider and recurse. Cancellation is never a reason to spend money: an aborted call throws instead of falling back, and a fallback that also fails reports the *primary* failure, because that is what made the call unusual.

### Concurrency, retries and cancellation

* Search and fetch each hold their **own** throttle (the account allows 5 QPS per endpoint), as a **fixed interval** (`ceil(1000 / qps)` ms), not a token bucket — a bucket permits a burst of `qps` requests inside one second, which is exactly the sliding window the server answers with `429`.
* `408` / `429` / `5xx` are retried, honouring `Retry-After` (capped at 30 s) and using exponential backoff otherwise. Transport failures are retried too: no response arrived, so nothing about the request was rejected.
* `400` / `401` / `402` / `403` / `404` / `413` are **never** retried, matching DeepSeek's guidance: *"for other 4xx errors, do not retry unless you modify the request."*
* `timeoutMs` applies per attempt. A caller abort cancels the in-flight request through a `cancel` frame and surfaces `WEB_ABORTED`.
* Response bodies are read incrementally and abandoned as soon as they exceed 32 MiB, so a broken or hostile endpoint cannot exhaust memory.

---

## Architecture

```text
lib/index.js        cordis entry: config schema, registration, wiring self-check
lib/engine.js       spawn + NDJSON framing + request/response correlation + restart
lib/search.js       search provider: engine call, native-provider fallback
lib/fetch.js        fetch provider: engine call
lib/credentials.js  credential resolution (re-read on every call)
lib/diag.js         one JSON line per HTTP attempt
lib/web-error.js    a WebError-shaped error for the seam
crates/engine/      the Rust engine: HTTP, throttle, retry, deadline, mapping
test/unit.mjs       32 checks — JS bridge, fake child process, no cost
test/engine.mjs     29 checks — real binary, mock HTTP server, no cost
test/smoke.mjs      33 checks — the real API, ~¥0.02
```

**Why split it?** The seam is a cordis (TypeScript/JavaScript) extension point, so the plugin must be JS. Everything that has nothing to do with cordis — the HTTP client, the rate limiter, the retry policy, the deadline, the cancellation, the request payloads and the response mapping — lives in Rust instead: one binary, no runtime dependencies to keep current, and the mapping sits next to the response it reads.

### The engine protocol

Newline-delimited JSON over stdio. The bridge writes:

```json
{"id":1,"method":"configure","params":{"baseURL":"https://api.deepseek.com","count":10}}
{"id":2,"method":"search","params":{"query":"…","maxResults":8,"apiKey":"sk-…"}}
{"id":3,"method":"fetch","params":{"url":"https://…","apiKey":"sk-…"}}
{"id":4,"method":"cancel","params":{"id":2}}
{"id":5,"method":"ping","params":{}}
{"id":6,"method":"shutdown","params":{}}
```

The engine answers `{"id":N,"ok":true,"result":…}` or `{"id":N,"ok":false,"error":{"code":"WEB_…","message":"…"}}`, plus unsolicited `{"event":"ready"|"log"|"call",…}` frames. The bridge resolves a call only after `ready`, and a `call` event becomes a diagnostics line — which is why the engine never writes logs by hand.

If the engine dies, every in-flight call is rejected and the next call starts a fresh one. A missing binary is reported as `WEB_PROVIDER_ERROR` listing the paths that were tried, not as a crash.

---

## Pricing and limits

Official documentation: [Search guide](https://api-docs.deepseek.com/zh-cn/guides/search) · [Search API](https://api-docs.deepseek.com/zh-cn/api/search) · [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch)

| | |
| --- | --- |
| Price | ¥5 per 1,000 **successful** requests per endpoint (≈ ¥0.005 each). No token usage. |
| Billed when | HTTP 200 **and** a result was produced (non-empty `results` for search, page content for fetch). |
| Not billed | failures, empty results, timeouts, 4xx/5xx. |
| Rate limit | 5 QPS per account, **independently** for search and fetch, regardless of which API key is used, and independent of model concurrency. Fetch additionally has a per-target-domain limit. Exceeding either returns `429`. |
| Settlement | Usage appears on the console usage page as separate `tool-search` / `tool-fetch` entries, after a **5–15 minute** delay. |

Errors use the OpenAI-compatible shape with `param` always `null`:

| status | meaning (search / fetch) | retried here |
| --- | --- | --- |
| `400` | malformed headers or body | no |
| `401` | missing or invalid key | no |
| `402` | insufficient balance | no |
| `403` | fetch refused by safety policy | no |
| `404` | fetch could not obtain usable content | no |
| `408` | read timeout | yes |
| `413` | request body too large | no |
| `429` | QPS exceeded | yes, `Retry-After` first |
| `500` | server error | yes |
| `504` | downstream timeout | yes |

---

## Testing

```bash
npm run test:unit     # 32 checks — no engine, no network, no cost
npm run test:engine   # 29 checks — real engine, local mock server, no cost
npm run test:smoke    # 33 checks — the real API, ~¥0.02
```

* **`test/unit.mjs`** drives the JS bridge with a fake child process: config sanitizing, engine-path resolution, NDJSON framing (split frames, unparsable lines, correlation), cancellation, crash-and-restart, and the fallback matrix — including that a cancelled call never spends a fallback.
* **`test/engine.mjs`** spawns the built binary against a mock HTTP server and asserts the documented contract: request payloads (no `need_content`, `count` from `maxResults`), the `2xx`/`403`/`404` mapping, retry and `Retry-After` behaviour, the fixed-interval throttle, cancellation, `maxResults` clamping, and a clean `shutdown`.
* **`test/smoke.mjs`** runs the plugin end-to-end against `api.deepseek.com` through a stub cordis context, cross-checking every mapped value against a raw HTTP call made in the same script, so a mapping bug cannot hide behind a passing assertion. The fallback path is proved for free by pointing the primary at a closed port.

`test/smoke.mjs` needs `DEEPSEEK_API_KEY` (or `$DSH_HOME/.credentials.yaml`) and never prints the key.

---

## Diagnostics

One line per HTTP attempt is appended to `%TEMP%/dsh-web-tools-deepseek.log` (or `$TMPDIR`), and echoed to the cordis logger:

```text
2026-10-17T02:20:11.402Z [info] [web-tools-deepseek] registered search="deepseek-tools-api" fetch="deepseek-tools-api" baseURL=https://api.deepseek.com key=credential:DEEPSEEK_API_KEY count=10 snippetSource=summary qps=5 timeoutMs=30000 retries=1 blockedAsResult=true includeTitle=true fallback=deepseek-official:both engine=… diagFile=…
2026-10-17T02:20:11.405Z [info] [web-tools-deepseek] seam row is wired to this plugin (search="deepseek-tools-api", fetch="deepseek-tools-api")
2026-10-17T02:20:11.899Z [call] {"label":"deepseek search","endpoint":"https://api.deepseek.com/v1/tools/search","status":200,"ok":true,"ms":412,"attempts":1}
```

| variable | effect |
| --- | --- |
| `DSH_WEB_TOOLS_DEEPSEEK_DIAG_FILE` | write the log elsewhere |
| `DSH_WEB_TOOLS_DEEPSEEK_DIAG=0` | turn the log off |
| `DSH_WEB_TOOLS_DEEPSEEK_BIN` | use a specific engine binary |

The second startup line is the one to read first. **"Registered" and "selected" are different facts**: without the `- id: web` override this plugin sits inert while `deepseek-official` and `http` keep serving every call, which is invisible from the outside. If the log says *"registered but NOT selected"*, that override is missing. (The check reads `WebRuntime`'s TypeScript-`private` fields, which are ordinary runtime properties; it is diagnostics-only and degrades to `(unset)`.)

---

## Troubleshooting

| symptom | cause |
| --- | --- |
| `WEB_PROVIDER_AMBIGUOUS` | more than one provider is registered and the `web` row names none. Add the `- id: web` override. |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | the `web` row names this provider but `available()` is false: no resolvable credential, or the engine binary is missing. |
| `[web-tools-deepseek] engine is not usable: …` | the engine could not start; the message lists the paths that were tried. |
| `WEB_MISSING_CREDENTIAL` | `apiKeyEnv` does not resolve to a value in `$DSH_HOME/.credentials.yaml`. |
| Edits to `lib/*.js` have no effect | the plugin module is ESM-cached; restart DSH. Config reloads *do* re-run `apply()` — proven by adding a real override (`qps: 4`) and watching the startup line change — but the module itself is not re-imported. A comment-only edit does not even trigger that much, because the parsed config is unchanged. |
| Usage page shows no `tool-search` / `tool-fetch` | settlement takes 5–15 minutes. |

## Rolling back

1. Point the `web` row back at the defaults and drop the plugin row, then restart:

   ```yaml
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: deepseek-official
       fetchProvider: http
   ```

   Both keys must be written together: a patch replaces the whole `config` block, so changing one would drop the other. And do not leave the `web` row pointing at `deepseek-tools-api` after removing the plugin — that raises `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.

2. Or remove the bundle:

   ```bash
   dsh plugin --profile desktop remove dsh-web-tools-deepseek
   ```

3. Or disable it in the plugin manager.

## Known limitations

* **Fetch 403 is common**, including for DeepSeek's own documentation site (measured: `api-docs.deepseek.com` → `403 URL access denied`); `zh.wikipedia.org` and `news.ycombinator.com` measured `404 failed to fetch URL`. DeepSeek states that fetch results depend on the target site's availability and access policy — this is the service's verdict, not a plugin bug. Switch `fetchProvider` back to `http` to fetch those sites.
* **No pagination** — one request returns at most 50 results and `truncated` is always `false`.
* **No streaming or progress events** — a call resolves when the API answers.
* **`need_content` is deliberately unused**, so page text always needs a second `fetch` call (and its own ¥0.005).
* **The fallback target is read from a private seam field** (`ctx.web.searchProviders`). There is no public way to look up another provider, and `ctx.web.search()` would recurse. If the seam renames that field the fallback degrades to "no fallback", with a warning, rather than breaking search.
* **The committed binary is Windows x64.** Other platforms build their own or take a release asset; the workflow covers Windows, Linux and both macOS architectures.
* **HTTP uses `reqwest` with `default-tls`** (schannel on Windows), not rustls: a rustls crypto provider needs a C toolchain and NASM to build, which would make `cargo build` fail on an ordinary machine.
* **`dsh --profile desktop --dump-config` is unavailable** (`profile "desktop" is managed exclusively by the Electron application`), so acceptance evidence comes from live behaviour plus the wiring self-check log.

## License

[MIT](./LICENSE) © CarbonAnime

Not affiliated with DeepSeek. The Search and Fetch APIs, their pricing and their limits are DeepSeek's and may change; check the [official documentation](https://api-docs.deepseek.com/zh-cn/guides/search).
