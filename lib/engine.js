/**
 * Node half of the engine bridge.
 *
 * The plugin keeps its cordis shape in JavaScript — registration, credential
 * resolution, the native-search fallback, diagnostics — and delegates everything
 * that speaks HTTP to a Rust sidecar: throttling, retry/backoff, deadlines,
 * cancellation, payload construction, and the response→seam mapping. That split
 * is deliberate: the interesting failure modes (rate limits, half-open sockets,
 * bodies that never end) are exactly the ones a managed runtime makes awkward and
 * a compiled one makes explicit.
 *
 * The two halves talk newline-delimited JSON over stdio: one request per line in,
 * one response per line out, plus unsolicited `event` frames. `ready` is the
 * handshake — "the process exists" and "the engine is usable" are different facts.
 *
 * @module dsh-web-tools-deepseek/engine
 */

import { spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebError } from './web-error.js'

/** Binary basename, before the platform tag. */
export const ENGINE_BIN_BASENAME = 'dsh-web-tools-deepseek'

/** Package root, derived from this module's location. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** How long the `ready` handshake may take before the engine is declared broken. */
export const READY_TIMEOUT_MS = 10_000

/** How long `dispose` waits for a graceful exit before it kills the process. */
export const SHUTDOWN_TIMEOUT_MS = 1_000

/**
 * Candidate binary paths, most specific first.
 *
 * `bin/<name>-<platform>-<arch>` is what the release workflow publishes, so a
 * repository checkout with every platform's binary staged still picks *this*
 * machine's build; the untagged name is what a locally built binary gets.
 *
 * `DSH_WEB_TOOLS_DEEPSEEK_BIN` is consulted here rather than by the caller so
 * that every consumer — the resolution itself and the error that reports what
 * was tried — sees the same list.
 *
 * @param {object} [options] - Overrides, for tests.
 * @param {string} [options.configured] - Explicit path. Empty means unset.
 * @param {object} [options.env] - Environment to read the override from.
 * @param {string} [options.root] - Package root.
 * @param {string} [options.platform] - `process.platform` override.
 * @param {string} [options.arch] - `process.arch` override.
 * @returns {string[]} Absolute candidates, in preference order.
 */
export function engineCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const root = options.root ?? PACKAGE_ROOT
  const env = options.env ?? process.env
  const extension = platform === 'win32' ? '.exe' : ''
  const tagged = `${ENGINE_BIN_BASENAME}-${platform}-${arch}${extension}`
  const plain = `${ENGINE_BIN_BASENAME}${extension}`

  const candidates = []
  // An explicit path wins, but an empty one means "unset": `Config.enginePath`
  // defaults to '', and treating that as a value would let the default shadow
  // `DSH_WEB_TOOLS_DEEPSEEK_BIN` completely.
  const explicit = typeof options.configured === 'string' ? options.configured.trim() : ''
  const override = explicit.length > 0 ? explicit : env.DSH_WEB_TOOLS_DEEPSEEK_BIN
  if (typeof override === 'string' && override.trim().length > 0) candidates.push(path.resolve(override.trim()))
  candidates.push(path.join(root, 'bin', tagged), path.join(root, 'bin', plain))

  // A source checkout that has been built but not staged: `cargo build --release`
  // followed by loading the plugin should be enough to try it out.
  if (existsSync(path.join(root, 'Cargo.toml'))) {
    candidates.push(path.join(root, 'target', 'release', plain), path.join(root, 'target', 'debug', plain))
  }
  return candidates
}

/**
 * First existing candidate.
 *
 * An empty `configured` means "unset", not "look for a file named ''" — which
 * matters because `Config.enginePath` defaults to the empty string, and `??`
 * would let that default shadow `DSH_WEB_TOOLS_DEEPSEEK_BIN` entirely.
 *
 * @param {object} [options] - As {@link engineCandidates}.
 * @returns {string | undefined} Absolute path, or `undefined` when nothing is built.
 */
export function resolveEnginePath(options = {}) {
  const candidates = engineCandidates(options)
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // An unreadable path is simply not a candidate.
    }
  }
  return undefined
}

/**
 * Map plugin settings onto the engine's `configure` frame.
 *
 * The keys must be spelled exactly as `crates/engine/src/config.rs` expects:
 * serde's `camelCase` turns `base_url` into `baseUrl`, not `baseURL`, so that one
 * field carries an explicit rename — and a frame that fails to parse is rejected
 * outright rather than silently falling back to the production defaults.
 *
 * @param {object} settings - Sanitized plugin settings.
 * @returns {object} Frame payload.
 */
export function toFrameConfig(settings) {
  return {
    baseURL: settings.baseURL,
    count: settings.count,
    snippetSource: settings.snippetSource,
    oriQuestion: settings.oriQuestion,
    localization: settings.localization,
    blockedAsResult: settings.blockedAsResult,
    includeTitle: settings.includeTitle,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    qps: settings.qps,
    userAgent: settings.userAgent,
  }
}

/**
 * Build the engine client.
 *
 * The process is started lazily and restarted after an unexpected exit, so a
 * crashed engine costs one slow call rather than the whole session. Startup
 * failures are never fatal to the plugin mount: `available()` reports whether a
 * binary was found at all, and a call on a missing binary throws the same
 * `WebError` shape as any other provider failure.
 *
 * @param {object} options - Wiring.
 * @param {object} options.config - Sanitized plugin settings.
 * @param {object} [options.diag] - Diagnostics sink.
 * @param {string} [options.enginePath] - Explicit binary path (config or env).
 * @param {Function} [options.spawnImpl] - `child_process.spawn` injection point, for tests.
 * @param {object} [options.env] - Environment override, for tests.
 * @returns {object} Engine client.
 */
export function createEngine(options) {
  const diag = options.diag
  const spawnImpl = options.spawnImpl ?? spawnChild
  const env = options.env ?? process.env
  const binaryPath = resolveEnginePath({
    configured: options.enginePath ?? options.config?.enginePath,
    env,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
  })

  /** @type {Map<number, {resolve: Function, reject: Function, detach: Function, method: string}>} */
  const pending = new Map()
  let settings = options.config
  let child
  let buffered = ''
  let nextId = 1
  let state = 'idle'
  let readyPromise
  let readySettle
  let disposed = false

  const log = (level, message) => {
    const sink = level === 'warn' ? diag?.warn : diag?.info
    try {
      sink?.(message)
    } catch {
      // Diagnostics never break a call.
    }
  }

  const missingBinaryError = () => new WebError(
    'the Rust engine binary was not found; build it with `cargo build --release` (or `pnpm run build:engine`),'
    + ' stage it under bin/, or point DSH_WEB_TOOLS_DEEPSEEK_BIN at it. Looked in: '
    + engineCandidates({ configured: options.enginePath ?? options.config?.enginePath, env }).join(', '),
    'WEB_PROVIDER_ERROR',
  )

  const write = (target, frame) => {
    try {
      target.stdin.write(`${JSON.stringify(frame)}\n`)
      return true
    } catch (error) {
      log('warn', `[web-tools-deepseek] writing to the engine failed: ${error?.message ?? error}`)
      return false
    }
  }

  const settleAll = (error) => {
    for (const [id, entry] of pending) {
      pending.delete(id)
      entry.detach()
      entry.reject(error)
    }
  }

  const route = (frame) => {
    if (typeof frame?.event === 'string') {
      if (frame.event === 'ready') {
        state = 'ready'
        readySettle?.resolve({ engine: frame.engine, version: frame.version })
      } else if (frame.event === 'log') {
        log(frame.level === 'warn' ? 'warn' : 'info', `[engine] ${frame.message}`)
      } else if (frame.event === 'call') {
        try {
          diag?.call(frame.record)
        } catch {
          // As above.
        }
      }
      return
    }
    if (typeof frame?.id !== 'number') return
    const entry = pending.get(frame.id)
    if (entry === undefined) return
    pending.delete(frame.id)
    entry.detach()
    if (frame.ok === true) entry.resolve(frame.result)
    else entry.reject(new WebError(frame.error?.message ?? 'the engine reported a failure', frame.error?.code ?? 'WEB_PROVIDER_ERROR'))
  }

  const onStdout = (chunk) => {
    buffered += typeof chunk === 'string' ? chunk : String(chunk)
    let index = buffered.indexOf('\n')
    while (index >= 0) {
      const line = buffered.slice(0, index).trim()
      buffered = buffered.slice(index + 1)
      if (line.length > 0) {
        try {
          route(JSON.parse(line))
        } catch {
          log('warn', `[web-tools-deepseek] dropped an unparsable engine frame: ${line.slice(0, 200)}`)
        }
      }
      index = buffered.indexOf('\n')
    }
  }

  const start = () => {
    if (binaryPath === undefined) {
      state = 'dead'
      readyPromise = Promise.reject(missingBinaryError())
      readyPromise.catch(() => {})
      return
    }
    state = 'starting'
    buffered = ''
    const settle = {}
    readyPromise = new Promise((resolve, reject) => {
      settle.resolve = resolve
      settle.reject = reject
    })
    readyPromise.catch(() => {})
    readySettle = settle

    let spawned
    try {
      spawned = spawnImpl(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      state = 'dead'
      settle.reject(new WebError(`the engine could not be started: ${error?.message ?? error}`, 'WEB_PROVIDER_ERROR'))
      return
    }
    child = spawned
    log('info', `[web-tools-deepseek] engine started (${binaryPath}, pid ${spawned.pid ?? '?'})`)

    const timer = setTimeout(() => {
      if (state !== 'starting') return
      state = 'dead'
      settle.reject(new WebError(`the engine did not announce readiness within ${READY_TIMEOUT_MS} ms`, 'WEB_PROVIDER_ERROR'))
      try {
        spawned.kill()
      } catch {
        // Nothing left to do.
      }
    }, READY_TIMEOUT_MS)
    timer.unref?.()

    spawned.stdout?.setEncoding?.('utf8')
    spawned.stdout?.on('data', onStdout)
    spawned.stderr?.setEncoding?.('utf8')
    spawned.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text.length > 0) log('warn', `[engine stderr] ${text}`)
    })
    spawned.on('error', (error) => {
      clearTimeout(timer)
      state = 'dead'
      child = undefined
      const failure = new WebError(`the engine process failed: ${error?.message ?? error}`, 'WEB_PROVIDER_ERROR')
      settle.reject(failure)
      settleAll(failure)
    })
    spawned.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (child === spawned) child = undefined
      if (state !== 'dead') {
        state = 'dead'
        const failure = new WebError(
          `the engine exited unexpectedly (${signal ?? `code ${code ?? '?'}`})`,
          'WEB_PROVIDER_ERROR',
        )
        settle.reject(failure)
        settleAll(failure)
      }
      if (disposed) return
      log('warn', `[web-tools-deepseek] engine exited (${signal ?? `code ${code ?? '?'}`}); it will be restarted on the next call`)
    })
  }

  const ensureStarted = async () => {
    if (disposed) throw new WebError('the engine bridge has been disposed', 'WEB_PROVIDER_ERROR')
    if (state === 'ready') return
    if (state !== 'starting') start()
    await readyPromise
  }

  const request = async (method, params, signal) => {
    // Checked before the handshake, not after: a caller that has already given up
    // must not be made to wait for an engine it no longer wants, nor start one.
    if (signal?.aborted === true) throw new WebError(`${method} was aborted before it was sent`, 'WEB_ABORTED')
    await ensureStarted()
    const target = child
    if (target === undefined) throw new WebError('the engine is not running', 'WEB_PROVIDER_ERROR')

    const id = nextId++
    const promise = new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        // Cancellation is a frame, not a kill: the engine owns the socket and has
        // to observe the token before it can unwind the call.
        write(target, { id: nextId++, method: 'cancel', params: { id } })
        reject(new WebError(`${method} was aborted`, 'WEB_ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve,
        reject,
        method,
        detach: () => signal?.removeEventListener('abort', onAbort),
      })
    })
    if (!write(target, { id, method, params })) {
      const entry = pending.get(id)
      pending.delete(id)
      entry?.detach()
      throw new WebError('the engine is not accepting requests', 'WEB_PROVIDER_ERROR')
    }
    return promise
  }

  return {
    /** Absolute path of the binary this client will run, when one was found. */
    path: binaryPath,
    /** Cheap, local: whether the engine can be used at all. */
    available: () => binaryPath !== undefined,
    /** `idle` | `starting` | `ready` | `dead`. */
    state: () => state,
    /** Send the effective configuration; resolves with the engine's ack. */
    configure: (next) => {
      if (next !== undefined) settings = next
      return request('configure', toFrameConfig(settings))
    },
    /** One search. `params` carries `query`, optional `maxResults`, and the key. */
    search: (params, signal) => request('search', params, signal),
    /** One fetch. `params` carries `url` and the key. */
    fetch: (params, signal) => request('fetch', params, signal),
    /** Ask the engine to exit, then make sure it did. */
    async dispose() {
      if (disposed) return
      disposed = true
      const target = child
      child = undefined
      if (target === undefined) return
      write(target, { id: nextId++, method: 'shutdown', params: {} })
      await new Promise((resolve) => {
        // Deliberately *not* unref'd: the caller is waiting for the shutdown to
        // complete, and an unref'd timer would let the event loop drain and the
        // process exit with the handshake half-finished.
        const timer = setTimeout(() => {
          try {
            target.kill()
          } catch {
            // Already gone.
          }
          resolve()
        }, SHUTDOWN_TIMEOUT_MS)
        target.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      state = 'dead'
    },
  }
}
