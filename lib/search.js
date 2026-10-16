/**
 * The search provider registered on `ctx.web`.
 *
 * Two jobs, both thin:
 *
 *  1. Hand the query to the Rust engine and pass the normalized result back
 *     unchanged — the payload construction, the `summary`/`snippet` choice, the
 *     date shaping and the `maxResults` bound all live in Rust, next to the
 *     response they read from.
 *  2. If the primary call fails or comes back with nothing, fall back to another
 *     *already registered* search provider — by default `deepseek-official`, the
 *     model-backed provider this plugin replaces. That provider bills tokens
 *     instead of ¥0.005 per call, which is why it is a fallback and not the
 *     default, but a search that returns nothing at all is worth more than one
 *     that saves a fifth of a cent.
 *
 * The fallback target is resolved **per call**, from the live registry: plugin
 * load order is not guaranteed, and a config reload can replace the other
 * provider at any time. It is never `ctx.web.search()` — that would resolve back
 * to this very provider and recurse.
 *
 * @module dsh-web-tools-deepseek/search
 */

import { WebError } from './web-error.js'

/** Fallback policies accepted by `fallbackOn`. */
export const FALLBACK_MODES = ['never', 'error', 'empty', 'both']

/**
 * Read a private provider registry off the seam.
 *
 * `WebRuntime` keeps `searchProviders` in a TypeScript-`private` field, which is
 * an ordinary runtime property, so it can be read — but it is not part of the
 * public contract, hence the defensive access. There is no public way to look up
 * *another* provider, and the fallback must not go through `ctx.web.search()`.
 *
 * @param {object} ctx - Plugin context.
 * @param {string} key - `searchProviders` or `fetchProviders`.
 * @returns {Map<string, {id: string, available: () => boolean}> | undefined} Registry, when readable.
 */
export function readProviderRegistry(ctx, key) {
  try {
    const registry = ctx?.web?.[key]
    return typeof registry?.get === 'function' ? registry : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the provider to fall back to, or `undefined` when there is none.
 *
 * Refusing to return this provider itself is the load-bearing part: without it a
 * misconfigured `fallbackSearchProviderId` would re-enter the same function.
 *
 * @param {object} ctx - Plugin context.
 * @param {object} config - Sanitized plugin settings.
 * @param {string} ownId - This provider's id.
 * @returns {object | undefined} A different, registered, available provider.
 */
export function resolveFallbackSearch(ctx, config, ownId) {
  const wanted = typeof config.fallbackSearchProviderId === 'string' ? config.fallbackSearchProviderId.trim() : ''
  if (wanted.length === 0 || wanted === ownId) return undefined
  const registry = readProviderRegistry(ctx, 'searchProviders')
  const provider = registry?.get(wanted)
  if (provider === undefined || provider === null || provider.id === ownId) return undefined
  try {
    if (typeof provider.available === 'function' && provider.available() === false) return undefined
  } catch {
    return undefined
  }
  return provider
}

/**
 * Whether a policy covers a failure kind.
 * @param {string} mode - `fallbackOn`.
 * @param {'error' | 'empty'} kind - What happened to the primary call.
 * @returns {boolean} True when the fallback should run.
 */
function covers(mode, kind) {
  return mode === 'both' || mode === kind
}

/** @param {unknown} value @returns {number | undefined} A positive integer, or undefined. */
function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** @param {string} query @param {number} [limit] @returns {string} A short, log-safe query. */
function preview(query, limit = 80) {
  const flat = query.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * Build the search provider.
 * @param {object} options - Wiring.
 * @param {string} options.id - Registration id.
 * @param {object} options.config - Sanitized plugin settings.
 * @param {object} options.ctx - Plugin context, for the fallback lookup.
 * @param {{ available: () => boolean, resolve: (signal?: AbortSignal) => Promise<string> }} options.credentials - Key access.
 * @param {{ available: () => boolean, search: Function }} options.engine - Engine client.
 * @param {Function} [options.onCall] - Per-attempt diagnostics.
 * @param {Function} [options.onWarn] - Diagnostic warnings.
 * @returns {object} A `WebSearchProvider`.
 */
export function createSearchProvider(options) {
  const { id, config, ctx, credentials, engine, onCall, onWarn } = options

  return {
    id,

    /** Cheap and local: a key is reachable and the engine binary exists. */
    available() {
      try {
        return credentials.available() === true && engine.available() === true
      } catch {
        return false
      }
    },

    /**
     * Run one search, falling back when the policy says so.
     * @param {{ query?: string, maxResults?: number }} request - Seam request.
     * @param {AbortSignal} [signal] - Cancellation.
     * @returns {Promise<{ sources: any[], truncated: boolean }>} Seam result.
     */
    async search(request, signal) {
      const query = typeof request?.query === 'string' ? request.query : ''
      const maxResults = positiveInteger(request?.maxResults)
      const mode = config.fallbackOn

      let primary
      let failure
      try {
        const apiKey = await credentials.resolve(signal)
        primary = await engine.search(
          maxResults === undefined ? { query, apiKey } : { query, maxResults, apiKey },
          signal,
        )
        const sources = Array.isArray(primary?.sources) ? primary.sources : []
        if (sources.length > 0 || !covers(mode, 'empty')) return primary
        onWarn?.(`[web-tools-deepseek] search returned no sources for "${preview(query)}"`)
      } catch (error) {
        // Cancellation is the caller's decision, never a reason to spend money
        // on a second provider.
        if (signal?.aborted === true || error?.code === 'WEB_ABORTED') throw error
        if (!covers(mode, 'error')) throw error
        failure = error
        onWarn?.(`[web-tools-deepseek] search failed for "${preview(query)}": ${error?.message ?? error}`)
      }

      const fallback = resolveFallbackSearch(ctx, config, id)
      if (fallback === undefined) {
        if (failure !== undefined) throw failure
        return primary
      }

      onWarn?.(`[web-tools-deepseek] falling back to search provider "${fallback.id}"`)
      try {
        const result = await fallback.search(
          maxResults === undefined ? { query } : { query, maxResults },
          signal,
        )
        onCall?.({
          path: 'fallback',
          provider: fallback.id,
          query: preview(query),
          sources: Array.isArray(result?.sources) ? result.sources.length : 0,
        })
        return result
      } catch (error) {
        if (failure !== undefined) {
          // Report the primary failure: it is the one that describes why this call
          // was unusual in the first place.
          onWarn?.(`[web-tools-deepseek] fallback "${fallback.id}" failed too: ${error?.message ?? error}`)
          throw failure
        }
        onWarn?.(`[web-tools-deepseek] fallback "${fallback.id}" failed: ${error?.message ?? error}; returning the empty primary result`)
        if (signal?.aborted === true) throw error
        return primary
      }
    },
  }
}

export { WebError }
