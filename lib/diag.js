/**
 * Diagnostics for the plugin.
 *
 * One JSON line per HTTP attempt (and a few lifecycle lines) is appended to
 * `%TEMP%/dsh-web-tools-deepseek.log`, and echoed to the cordis logger. This is
 * the same shape the local `qq-mode-console` plugin uses: it keeps request
 * evidence — status, latency, attempt count — readable from outside the running
 * application, which matters because profile-local plugin logs are otherwise
 * buried in the desktop process.
 *
 * Diagnostics must never break a fetch, so every write is guarded.
 *
 * @module dsh-web-tools-deepseek/diag
 */

import os from 'node:os'
import path from 'node:path'
import { appendFileSync } from 'node:fs'

/** Default log location; override with `DSH_WEB_TOOLS_DEEPSEEK_DIAG_FILE`. */
export const DEFAULT_DIAG_FILE = path.join(os.tmpdir(), 'dsh-web-tools-deepseek.log')

/**
 * Decide whether diagnostics are on.
 * @param {boolean} configured - `config.diag`.
 * @returns {boolean} Enabled unless config or `DSH_WEB_TOOLS_DEEPSEEK_DIAG=0` says otherwise.
 */
function enabled(configured) {
  const env = process.env.DSH_WEB_TOOLS_DEEPSEEK_DIAG
  if (env === '0' || env === 'false' || env === 'off') return false
  return configured
}

/**
 * Build the diagnostics sink.
 * @param {object} options - Wiring.
 * @param {boolean} options.enabled - `config.diag`.
 * @param {{ info: (message: string) => void, warn: (message: string) => void } | undefined} options.logger - cordis logger.
 * @returns {{
 *   file: string,
 *   info: (message: string) => void,
 *   warn: (message: string) => void,
 *   call: (record: object) => void,
 * }} Sink.
 */
export function createDiag(options) {
  const file = process.env.DSH_WEB_TOOLS_DEEPSEEK_DIAG_FILE || DEFAULT_DIAG_FILE
  const on = enabled(options.enabled)
  const logger = options.logger

  const write = (level, message) => {
    if (!on) return
    try {
      appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`)
    } catch {
      // A read-only or full temp directory must not fail a search.
    }
  }

  return {
    file,
    info(message) {
      write('info', message)
      try {
        logger?.info(message)
      } catch {
        // Logger failures are never fatal.
      }
    },
    warn(message) {
      write('warn', message)
      try {
        logger?.warn(message)
      } catch {
        // Logger failures are never fatal.
      }
    },
    call(record) {
      write('call', JSON.stringify(record))
    },
  }
}
