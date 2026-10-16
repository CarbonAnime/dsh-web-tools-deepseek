/**
 * DeepSeek native Search / Fetch API providers for the DSH web seam.
 *
 * Registers two providers on `ctx.web`:
 *   - `POST /v1/tools/search` → `WebSearchProvider`
 *   - `POST /v1/tools/fetch`  → `WebFetchProvider`
 *
 * They replace the previous pair (`deepseek-official`, which bills the *model*
 * for a server-side `web_search` tool, and `http`, an anonymous local fetcher);
 * the bundle's `cordis.patch.yml` points the `web` row at the new ids.
 *
 * Both are billed at **¥5 per 1,000 successful requests** (≈ ¥0.005 each, no
 * token usage). Only an HTTP 200 that actually produced a result counts, so a
 * 403 or a 404 costs nothing — but it still consumes rate-limit budget, and the
 * account allows **5 QPS per endpoint** independently of which key is used.
 *
 * The HTTP work itself lives in the Rust engine (`crates/engine`, spoken to over
 * NDJSON on stdio); see `lib/engine.js` for why. This module is the cordis
 * surface: configuration, credential access, registration, and the wiring check
 * that tells "registered" apart from "actually selected".
 *
 * @module dsh-web-tools-deepseek
 */

import z from '@deepseek-ai/schemastery'

import { WebError } from './web-error.js'
import { createCredentialAccess } from './credentials.js'
import { createSearchProvider, FALLBACK_MODES } from './search.js'
import { createFetchProvider } from './fetch.js'
import { createDiag } from './diag.js'
import { createEngine } from './engine.js'

/** Cordis plugin name; also the package name for diagnostics. */
export const name = 'web-tools-deepseek'

/** The seam is the only hard dependency; `credentials` is looked up defensively. */
export const inject = ['web']

/** Results requested when the caller does not pass `maxResults`; price-neutral. */
export const DEFAULT_COUNT = 10

/** Documented upper bound for `count`. */
export const MAX_COUNT = 50

/** Plugin version, used for the default `User-Agent`. */
export const VERSION = '0.2.0'

/** Plugin configuration. Every field has a working default, so an empty block is valid. */
export const Config = z.object({
  /** Literal API key. Prefer `apiKeyEnv`; a literal ends up in the config file. */
  apiKey: z.string().default(''),
  /** Credential reference resolved through the `credentials` service on every call. */
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  /** API origin. */
  baseURL: z.string().default('https://api.deepseek.com'),
  /** Id the search provider registers under, referenced by `web.searchProvider`. */
  searchProviderId: z.string().default('deepseek-tools-api'),
  /** Id the fetch provider registers under, referenced by `web.fetchProvider`. */
  fetchProviderId: z.string().default('deepseek-tools-api'),
  /** Results requested when the caller does not pass `maxResults` (1–50; price-neutral). */
  count: z.number().default(DEFAULT_COUNT),
  /**
   * Which API field becomes each source's `snippet`.
   *
   * The API documents `summary` (600–800 chars) as "for models to read" and
   * `snippet` (100–200 chars) as "for front-end display" — and the only consumer
   * here is a model, so `summary` is the faithful default. Set `snippet` to spend
   * less context per result.
   */
  snippetSource: z.string().default('summary'),
  /** Passed as `ori_question` (non-empty, ≤128 chars) when non-empty; longer values are truncated. */
  oriQuestion: z.string().default(''),
  /**
   * Passed as `localization` when non-empty: an **IP address** used to prefer
   * results local to that address. This is *not* a language tag — languages go
   * into the query itself, as `lang:zh,en`.
   */
  localization: z.string().default(''),
  /** Return fetch 403/404 as results (true) instead of throwing (false). */
  blockedAsResult: z.boolean().default(true),
  /** Prepend the API's `title` as an H1 when the Markdown does not already carry it. */
  includeTitle: z.boolean().default(true),
  /** Per-attempt request deadline in ms; `0` disables it. */
  timeoutMs: z.number().default(30_000),
  /** Extra attempts for 408 / 429 / 5xx / transport failures. */
  retries: z.number().default(1),
  /** Per-endpoint rate limit; the account allows 5. Search and fetch are limited independently. */
  qps: z.number().default(5),
  /** `User-Agent` sent with each request. */
  userAgent: z.string().default(`dsh-web-tools-deepseek/${VERSION}`),
  /**
   * Another registered search provider to retry on when the tools API fails or
   * returns nothing. Defaults to the model-backed `deepseek-official` provider
   * that ships with DSH; set it to an empty string to disable the fallback.
   */
  fallbackSearchProviderId: z.string().default('deepseek-official'),
  /** When the fallback runs: `never`, `error`, `empty`, or `both`. */
  fallbackOn: z.string().default('both'),
  /** Explicit engine binary path; normally resolved from `bin/` or the environment. */
  enginePath: z.string().default(''),
  /** Append one JSON line per HTTP attempt to the diagnostics log. */
  diag: z.boolean().default(true),
})

/** @param {unknown} value @param {string} fallback @returns {string} Trimmed non-empty string or the fallback. */
function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback @returns {number} Clamped integer. */
function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Normalize a resolved config, so a hand-written `cordis.patch.yml` entry that
 * omits a schema default (or a loader without schema support) still behaves.
 * @param {object} config - Plugin config as handed to `apply`.
 * @returns {object} Sanitized settings.
 */
export function sanitize(config) {
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
  return {
    ...config,
    apiKey: typeof config.apiKey === 'string' ? config.apiKey.trim() : '',
    apiKeyEnv: nonEmpty(config.apiKeyEnv, 'DEEPSEEK_API_KEY'),
    baseURL: nonEmpty(config.baseURL, 'https://api.deepseek.com').replace(/\/+$/, ''),
    searchProviderId: nonEmpty(config.searchProviderId, 'deepseek-tools-api'),
    fetchProviderId: nonEmpty(config.fetchProviderId, 'deepseek-tools-api'),
    count: clampInt(config.count, 1, MAX_COUNT, DEFAULT_COUNT),
    snippetSource: config.snippetSource === 'snippet' ? 'snippet' : 'summary',
    oriQuestion: typeof config.oriQuestion === 'string' ? config.oriQuestion : '',
    localization: typeof config.localization === 'string' ? config.localization : '',
    blockedAsResult: config.blockedAsResult !== false,
    includeTitle: config.includeTitle !== false,
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs >= 0 ? config.timeoutMs : 30_000,
    retries: clampInt(config.retries, 0, 5, 1),
    qps: positive(config.qps, 5),
    userAgent: nonEmpty(config.userAgent, `dsh-web-tools-deepseek/${VERSION}`),
    fallbackSearchProviderId: typeof config.fallbackSearchProviderId === 'string'
      ? config.fallbackSearchProviderId.trim()
      : 'deepseek-official',
    fallbackOn: FALLBACK_MODES.includes(config.fallbackOn) ? config.fallbackOn : 'both',
    enginePath: typeof config.enginePath === 'string' ? config.enginePath.trim() : '',
    diag: config.diag !== false,
  }
}

/** @param {object} ctx @returns {object | undefined} The cordis logger, when present. */
function readLogger(ctx) {
  try {
    return ctx.logger
  } catch {
    return undefined
  }
}

/**
 * Read which provider ids the seam row actually resolved to.
 *
 * `WebRuntime` keeps them in TypeScript-`private` fields, which are ordinary
 * runtime properties, so they can be read for diagnostics — but they are not
 * part of the public contract, hence the defensive access and the `undefined`
 * fallback. The point is that "plugin registered" and "plugin is the one being
 * used" are different facts, and only the second one matters.
 *
 * @param {object} ctx - Plugin context; `ctx.web` is guaranteed by `inject`.
 * @returns {{ search: string | undefined, fetch: string | undefined }} Resolved ids, when readable.
 */
export function readSeamSelection(ctx) {
  const read = (key) => {
    try {
      const value = ctx.web?.[key]
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
  return { search: read('searchProviderId'), fetch: read('fetchProviderId') }
}

/**
 * Register both providers. Registration is fiber-scoped via `ctx.effect`, so
 * unloading the plugin (or a config reload) removes them again.
 * @param {object} ctx - Plugin context; `ctx.web` is guaranteed by `inject`.
 * @param {object} config - Plugin config, already defaulted by `Config`.
 * @returns {void} Nothing.
 */
export function apply(ctx, config) {
  const settings = sanitize(config)
  const diag = createDiag({ enabled: settings.diag, logger: readLogger(ctx) })
  const credentials = createCredentialAccess({ ctx, config: settings })
  const engine = createEngine({ config: settings, diag, enginePath: settings.enginePath })

  const searchProvider = createSearchProvider({
    id: settings.searchProviderId,
    config: settings,
    ctx,
    credentials,
    engine,
    onCall: diag.call,
    onWarn: diag.warn,
  })
  const fetchProvider = createFetchProvider({ id: settings.fetchProviderId, credentials, engine })

  // Registered first so it is disposed *last*: the providers must be gone before
  // the process they talk to is.
  ctx.effect(() => () => {
    void engine.dispose()
  }, 'web-tools-deepseek: engine')

  ctx.effect(() => ctx.web.registerSearchProvider(searchProvider), 'web-tools-deepseek: search provider')
  ctx.effect(() => ctx.web.registerFetchProvider(fetchProvider), 'web-tools-deepseek: fetch provider')

  // A mount that cannot reach its engine must still leave the seam working: the
  // failure is reported, and every later call reports it again with the code the
  // seam already understands.
  engine.configure(settings).then(
    () => diag.info(`[web-tools-deepseek] engine configured (${engine.path})`),
    (error) => diag.warn(`[web-tools-deepseek] engine is not usable: ${error?.message ?? error}`),
  )

  diag.info(
    `[web-tools-deepseek] registered search="${settings.searchProviderId}" fetch="${settings.fetchProviderId}"`
    + ` baseURL=${settings.baseURL} key=${settings.apiKey.length > 0 ? 'literal' : `credential:${settings.apiKeyEnv}`}`
    + ` count=${settings.count} snippetSource=${settings.snippetSource} qps=${settings.qps}`
    + ` timeoutMs=${settings.timeoutMs} retries=${settings.retries} blockedAsResult=${settings.blockedAsResult}`
    + ` includeTitle=${settings.includeTitle}`
    + ` fallback=${settings.fallbackOn === 'never' ? 'off' : `${settings.fallbackSearchProviderId}:${settings.fallbackOn}`}`
    + ` engine=${engine.path ?? '(not built)'} diagFile=${diag.file}`,
  )

  // Registering is not the same as being selected: without the `- id: web`
  // override this plugin would sit there inert while `deepseek-official` / `http`
  // keep serving every call, which is invisible from the outside.
  const selected = readSeamSelection(ctx)
  const wired = [['search', selected.search, settings.searchProviderId], ['fetch', selected.fetch, settings.fetchProviderId]]
    .filter(([, actual, expected]) => actual !== expected)
  if (wired.length > 0) {
    diag.warn(
      `[web-tools-deepseek] registered but NOT selected for ${wired.map(([kind]) => kind).join(' + ')}:`
      + ` seam resolves ${wired.map(([kind, actual]) => `${kind}=${actual ?? '(unset)'}`).join(' ')}`
      + `, expected ${wired.map(([, , expected]) => expected).join(' + ')}.`
      + ' Add the `- id: web` override to a cordis.patch.yml at or after this bundle'
      + ' (`searchProvider` / `fetchProvider`), otherwise these providers are never called.',
    )
  } else {
    diag.info(`[web-tools-deepseek] seam row is wired to this plugin (search="${selected.search}", fetch="${selected.fetch}")`)
  }
}

export { WebError }
