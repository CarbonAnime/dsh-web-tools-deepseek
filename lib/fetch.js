/**
 * The fetch provider registered on `ctx.web`.
 *
 * Thin on purpose. URL validation, the 403/404-as-a-result policy, title
 * de-duplication and the failure note all live in the Rust engine, immediately
 * next to the response they interpret — having two opinions about what a 403
 * means is how the two halves drift apart.
 *
 * What stays here is only what the engine cannot know: which API key to send
 * (resolved per call through the `credentials` service, so a rotated key needs no
 * reload) and whether the plugin is usable at all.
 *
 * @module dsh-web-tools-deepseek/fetch
 */

import { WebError } from './web-error.js'

/**
 * Build the fetch provider.
 * @param {object} options - Wiring.
 * @param {string} options.id - Registration id.
 * @param {{ available: () => boolean, resolve: (signal?: AbortSignal) => Promise<string> }} options.credentials - Key access.
 * @param {{ available: () => boolean, fetch: Function }} options.engine - Engine client.
 * @returns {object} A `WebFetchProvider`.
 */
export function createFetchProvider(options) {
  const { id, credentials, engine } = options

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
     * Retrieve one URL.
     * @param {{ url?: string }} request - Seam request.
     * @param {AbortSignal} [signal] - Cancellation.
     * @returns {Promise<{ url: string, statusCode: number, body: object, truncated: boolean }>} Seam result.
     */
    async fetch(request, signal) {
      const url = typeof request?.url === 'string' ? request.url.trim() : ''
      if (url.length === 0) {
        throw new WebError('the fetch request needs a URL', 'WEB_PROVIDER_ERROR')
      }
      const apiKey = await credentials.resolve(signal)
      return engine.fetch({ url, apiKey }, signal)
    },
  }
}

export { WebError }
