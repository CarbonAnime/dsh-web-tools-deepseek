/**
 * API-key access for the DeepSeek tools API.
 *
 * The key is resolved through the `credentials` service on **every call**, never
 * cached at mount time: that is the seam's stated intent (a rotated key must not
 * require reloading the plugin), and it is also what makes `available()` a
 * genuinely local, network-free check.
 *
 * `credentialRef(value)` in `@deepseek-ai/dsh-credentials` validates the name and
 * then `brandString`s it, so at runtime a credential reference is just the plain
 * string — the plugin can pass `'DEEPSEEK_API_KEY'` without importing the package
 * (which is not resolvable from this profile anyway).
 *
 * @module dsh-web-tools-deepseek/credentials
 */

import { WebError } from './web-error.js'

/**
 * Whether a string parses as an absolute URL.
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True when `new URL(value)` succeeds.
 */
export function canParseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * Build the key accessor shared by both providers.
 * @param {object} options - Wiring.
 * @param {{ get: (name: string) => any }} options.ctx - Plugin context (for `ctx.get('credentials')`).
 * @param {{ apiKey: string, apiKeyEnv: string, baseURL: string }} options.config - Resolved plugin config.
 * @returns {{
 *   available: () => boolean,
 *   resolve: (signal?: AbortSignal) => Promise<string>,
 * }} Key accessor.
 */
export function createCredentialAccess(options) {
  const { ctx, config } = options
  const readCredentials = () => {
    try {
      return ctx.get('credentials')
    } catch {
      return undefined
    }
  }
  const literal = typeof config.apiKey === 'string' && config.apiKey.length > 0

  return {
    /**
     * Cheap local usability check — never touches the network.
     * @returns {boolean} True when a key is configured or resolvable.
     */
    available() {
      if (literal) return true
      return readCredentials() !== undefined && canParseUrl(config.baseURL)
    },

    /**
     * Resolve the bearer token for one call.
     * @param {AbortSignal} [signal] - Caller cancellation.
     * @returns {Promise<string>} The API key.
     */
    async resolve(signal) {
      if (signal?.aborted === true) {
        throw new WebError('deepseek web tools aborted before resolving the API key', 'WEB_ABORTED', { cause: signal.reason })
      }
      if (literal) return config.apiKey
      const credentials = readCredentials()
      if (credentials === undefined) {
        throw new WebError(
          `no DeepSeek API key available: the "credentials" service is absent and config.apiKey is empty`,
          'WEB_MISSING_CREDENTIAL',
        )
      }
      const hit = await credentials.resolve(config.apiKeyEnv)
      const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
      if (value.length === 0) {
        throw new WebError(
          `no DeepSeek API key available: credential "${config.apiKeyEnv}" is not set`,
          'WEB_MISSING_CREDENTIAL',
        )
      }
      return value
    },
  }
}
