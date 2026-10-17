# Security policy / 安全策略

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅        |
| < 0.2   | ❌        |

## Reporting a vulnerability / 报告漏洞

Please **do not** open a public issue. Use GitHub's private reporting:

➡️ <https://github.com/CarbonAnime/dsh-web-tools-deepseek/security/advisories/new>

Include the plugin version, the DSH version, reproduction steps, and what an
attacker gains. A first reply usually comes within a few days.

请不要开公开 issue，请走上面的 GitHub 私密报告入口。

## What is in scope

This plugin sits between DSH's `web_search` / `web_fetch` tools and DeepSeek's
native tools APIs, and it ships a small Rust sidecar that it spawns as a child
process. Worth reporting:

- **Credential exposure** — the API key showing up in diagnostics, logs, error
  messages, or the engine's stdout/stderr. The key is resolved from the DSH
  credential store at call time and handed to the engine over its stdin pipe; it
  must never reach a file, a diagnostics line, or any HTTP header except
  `Authorization`.
- **Process boundary** — the engine binary being resolved from an
  attacker-controlled path, arguments being injected into the spawn, or the
  sidecar escaping its intended lifecycle (surviving disposal, spawning extra
  processes, outliving a crashed parent without exiting).
- **Request smuggling / SSRF** — `web_fetch` accepting a URL it should refuse
  (non-`http(s)` scheme, credentials in the authority, malformed host), or a URL
  reaching an origin the plugin claims to block.
- **Resource exhaustion** — a response buffered past the declared size cap, a
  retry loop that never terminates, or an unbounded queue of in-flight calls.

## What is not in scope

- Which URLs DeepSeek's own API refuses, or how it ranks results. That is
  server-side policy, not this plugin.
- The cost of using the API (¥0.005 per successful call). See the README.
- Vulnerabilities in DSH itself, or in another plugin loaded alongside this one.
- Anything that requires an already-compromised profile directory.

## How the plugin tries to be safe

- The engine is spawned from a path resolved by a fixed candidate order, never
  through a shell; its arguments are constant, not interpolated.
- Both endpoints are read-only POSTs. The plugin never writes upstream and never
  follows a link out of a response.
- A fetch refusal (`403` / `404`) is surfaced as a *result* tagged
  `[FETCH FAILED — NOT PAGE CONTENT]`, so a refused page cannot masquerade as
  page content in the model's context.
- Response bodies are capped (32 MiB) while streaming, and retries are bounded
  (`retries` ≤ 5, only `408` / `429` / `5xx`, `Retry-After` honoured up to 30 s).
- The API key is never placed on a command line, never written to the
  diagnostics file, and never included in an error message.
