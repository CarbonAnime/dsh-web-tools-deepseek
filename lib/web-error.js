/**
 * A `WebError`-shaped failure carrying a stable machine-routable `code`.
 *
 * The seam's own `WebError` lives in `@deepseek-ai/dsh-web`, which ships inside
 * the application archive and is **not** resolvable from a profile-local plugin
 * (the desktop profile's `node_modules/@deepseek-ai/` only contains `cosmokit`
 * and `schemastery`). Nothing in the seam narrows provider failures with
 * `instanceof WebError` — `tool-web` lets whatever the provider throws propagate
 * straight out of `execute()` — so a local subclass with the same `name` and
 * `code` fields behaves identically for every consumer.
 *
 * @module dsh-web-tools-deepseek/web-error
 */

/** Base failure class: `code` is the machine-routable field, `message` is for humans. */
export class WebError extends Error {
  /**
   * @param {string} message - Human-readable failure description.
   * @param {string} code - Stable failure class, e.g. `WEB_ABORTED`.
   * @param {ErrorOptions} [options] - Standard `cause` chaining.
   */
  constructor(message, code, options) {
    super(message, options)
    /** Stable machine-routable failure class. */
    this.code = code
    this.name = 'WebError'
  }
}
