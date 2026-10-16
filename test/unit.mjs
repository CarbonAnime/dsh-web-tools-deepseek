/**
 * Unit tests for the JavaScript half of the plugin.
 *
 * Everything that talks HTTP now lives in Rust and is covered by
 * `test/engine.mjs`, which drives the real binary against a local mock server.
 * What is left here is the cordis surface: configuration normalization, the
 * fallback policy, and the stdio bridge — the last one against a fake child
 * process, so a transport bug is caught without spawning anything.
 *
 * Two tests do mount for real, and therefore do start the built engine: the
 * handshake is only meaningful end to end.
 *
 * Run with `node test/unit.mjs`. No network, no API cost.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Config, apply, readSeamSelection, sanitize, VERSION } from '../lib/index.js'
import { createSearchProvider, readProviderRegistry, resolveFallbackSearch } from '../lib/search.js'
import { createFetchProvider } from '../lib/fetch.js'
import { engineCandidates, resolveEnginePath, toFrameConfig, createEngine } from '../lib/engine.js'
import { WebError } from '../lib/web-error.js'

let passed = 0
const failures = []
const running = []

/**
 * Register one test. The body is awaited, so an async assertion failure is a
 * real failure rather than a line printed after the summary.
 * @param {string} label - Test name.
 * @param {() => any} body - Test body.
 */
function it(label, body) {
  running.push((async () => {
    try {
      await body()
      passed += 1
      console.log(`PASS  ${label}`)
    } catch (error) {
      failures.push(label)
      console.error(`FAIL  ${label}\n      ${error?.stack ?? error}`)
    }
  })())
}

/** Let every pending microtask and I/O callback settle. */
async function tick(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** A `child_process.spawn` stand-in: no process, full stdio surface. */
class FakeChild extends EventEmitter {
  /** @param {string} binary - Path the client asked for. */
  constructor(binary) {
    super()
    this.binary = binary
    this.pid = 4242
    this.sent = []
    this.killed = false
    this.stdout = new EventEmitter()
    this.stdout.setEncoding = () => {}
    this.stderr = new EventEmitter()
    this.stderr.setEncoding = () => {}
    this.stdin = {
      write: (line) => {
        const frame = JSON.parse(line.trim())
        this.sent.push(frame)
        // The real engine answers `shutdown` by exiting, so the fake must too:
        // otherwise every dispose() would wait out the kill timeout.
        if (frame.method === 'shutdown') setImmediate(() => this.emit('exit', 0, null))
        return true
      },
    }
  }

  /** Push one frame into the client, as the engine would. */
  emitFrame(frame) {
    this.stdout.emit('data', `${JSON.stringify(frame)}\n`)
  }

  /** Deliver a response to the nth frame received. */
  answer(index, result) {
    this.emitFrame({ id: this.sent[index].id, ok: true, result })
  }

  /** Deliver an error response to the nth frame received. */
  failFrame(index, code, message) {
    this.emitFrame({ id: this.sent[index].id, ok: false, error: { code, message } })
  }

  kill() {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
  }
}

/** Collects diagnostics instead of writing them. */
function memoryDiag() {
  const lines = []
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    call: (record) => lines.push(`call ${JSON.stringify(record)}`),
  }
}

/** A client whose spawn is captured. */
function fakeEngine(options = {}) {
  const children = []
  const diag = options.diag ?? memoryDiag()
  const engine = createEngine({
    config: options.config ?? sanitize({}),
    diag,
    spawnImpl: (binary) => {
      const child = new FakeChild(binary)
      children.push(child)
      return child
    },
    env: {},
    ...options.createOptions,
  })
  return { engine, children, diag, last: () => children[children.length - 1] }
}

/** A context with just enough seam to be read. */
function fakeContext(options = {}) {
  const effects = []
  const providers = options.providers ?? new Map()
  return {
    effects,
    web: {
      searchProviders: providers,
      fetchProviders: new Map(),
      ...(options.searchProviderId === undefined ? {} : { searchProviderId: options.searchProviderId }),
      ...(options.fetchProviderId === undefined ? {} : { fetchProviderId: options.fetchProviderId }),
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'test-key', source: 'env' }) } : undefined),
  }
}

const credentials = () => ({ available: () => true, resolve: async () => 'test-key' })

// --- configuration ---------------------------------------------------------

it('Config exposes the documented defaults, including the fallback fields', () => {
  const resolved = new Config({})
  assert.equal(resolved.baseURL, 'https://api.deepseek.com')
  assert.equal(resolved.count, 10)
  assert.equal(resolved.snippetSource, 'summary', 'summary is the model-facing field')
  assert.equal(resolved.qps, 5)
  assert.equal(resolved.fallbackSearchProviderId, 'deepseek-official')
  assert.equal(resolved.fallbackOn, 'both')
  assert.equal(resolved.enginePath, '')
  assert.equal(resolved.userAgent, `dsh-web-tools-deepseek/${VERSION}`)
})

it('sanitize repairs a hand-written config and clamps hostile values', () => {
  const settings = sanitize({
    apiKey: '  sk-x  ',
    apiKeyEnv: '   ',
    baseURL: 'https://example.test///',
    count: 999,
    snippetSource: 'nope',
    retries: -3,
    qps: 0,
    timeoutMs: -1,
    fallbackOn: 'sometimes',
    fallbackSearchProviderId: '  native  ',
    enginePath: '  /opt/engine  ',
    blockedAsResult: 'yes',
  })
  assert.equal(settings.apiKey, 'sk-x')
  assert.equal(settings.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(settings.baseURL, 'https://example.test')
  assert.equal(settings.count, 50, 'count is clamped to the documented maximum')
  assert.equal(settings.snippetSource, 'summary')
  assert.equal(settings.retries, 0, 'a negative retry budget clamps to none, not to a retry')
  assert.equal(settings.qps, 5)
  assert.equal(settings.timeoutMs, 30_000)
  assert.equal(settings.fallbackOn, 'both', 'an unknown policy is not accepted')
  assert.equal(settings.fallbackSearchProviderId, 'native')
  assert.equal(settings.enginePath, '/opt/engine')
  assert.equal(settings.blockedAsResult, true, 'anything but an explicit false means true')
})

it('sanitize keeps every accepted fallback policy', () => {
  for (const mode of ['never', 'error', 'empty', 'both']) {
    assert.equal(sanitize({ fallbackOn: mode }).fallbackOn, mode)
  }
})

it('readSeamSelection survives a seam that throws', () => {
  assert.deepEqual(readSeamSelection({ web: {} }), { search: undefined, fetch: undefined })
  assert.deepEqual(readSeamSelection({}), { search: undefined, fetch: undefined })
  assert.deepEqual(readSeamSelection({ web: { searchProviderId: 'a', fetchProviderId: 'b' } }), { search: 'a', fetch: 'b' })
  const hostile = {
    web: {
      get searchProviderId() {
        throw new Error('nope')
      },
    },
  }
  assert.equal(readSeamSelection(hostile).search, undefined)
})

// --- engine location and framing -------------------------------------------

it('engineCandidates prefers the platform-tagged binary over the plain one', () => {
  const candidates = engineCandidates({ root: 'pkg', platform: 'win32', arch: 'arm64', configured: 'D:/custom.exe' })
  assert.equal(candidates[0], path.resolve('D:/custom.exe'), 'an explicit path wins outright')
  assert.ok(candidates[1].endsWith(path.join('bin', 'dsh-web-tools-deepseek-win32-arm64.exe')))
  assert.ok(candidates[2].endsWith(path.join('bin', 'dsh-web-tools-deepseek.exe')))
  const linux = engineCandidates({ root: 'pkg', platform: 'linux', arch: 'x64' })
  assert.equal(linux[0], path.join('pkg', 'bin', 'dsh-web-tools-deepseek-linux-x64'))
})

it('resolveEnginePath honours the environment override', () => {
  const found = resolveEnginePath({ env: { DSH_WEB_TOOLS_DEEPSEEK_BIN: process.execPath }, root: '/nowhere' })
  assert.equal(found, path.resolve(process.execPath))
  assert.equal(resolveEnginePath({ env: {}, root: '/nowhere-does-not-exist' }), undefined)
})

it('toFrameConfig uses the exact keys the engine deserializes', () => {
  const frame = toFrameConfig(sanitize({}))
  assert.deepEqual(Object.keys(frame).sort(), [
    'baseURL', 'blockedAsResult', 'count', 'includeTitle', 'localization',
    'oriQuestion', 'qps', 'retries', 'snippetSource', 'timeoutMs', 'userAgent',
  ])
  // serde's camelCase would spell this `baseUrl`, and a frame it cannot parse is
  // rejected outright — so the spelling is load-bearing, not cosmetic.
  assert.equal(frame.baseURL, 'https://api.deepseek.com')
})

// --- the stdio bridge ------------------------------------------------------

it('waits for the ready handshake before it sends anything', async () => {
  const { engine, last } = fakeEngine()
  const configured = engine.configure(sanitize({}))
  const child = last()
  await tick()
  assert.equal(child.sent.length, 0, 'nothing is written before the engine announces readiness')
  child.emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  await tick()
  assert.equal(child.sent.length, 1)
  assert.equal(child.sent[0].method, 'configure')
  child.answer(0, { baseURL: 'https://api.deepseek.com' })
  assert.equal((await configured).baseURL, 'https://api.deepseek.com')
  await engine.dispose()
})

it('routes engine events to diagnostics', async () => {
  const { engine, last, diag } = fakeEngine()
  const configured = engine.configure(sanitize({}))
  const child = last()
  await tick()
  child.emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  child.emitFrame({ event: 'log', level: 'warn', message: 'careful' })
  child.emitFrame({ event: 'call', record: { status: 200, path: '/v1/tools/search' } })
  await tick()
  child.answer(0, {})
  await configured
  assert.ok(diag.lines.some((line) => line.includes('[engine] careful')), 'log events reach the sink')
  assert.ok(diag.lines.some((line) => line.includes('"status":200')), 'call records reach the sink')
  await engine.dispose()
})

it('rejects with the engine error code and message', async () => {
  const { engine, last } = fakeEngine()
  const call = engine.search({ query: 'x', apiKey: 'k' })
  const child = last()
  await tick()
  child.emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  await tick()
  child.failFrame(0, 'WEB_MISSING_CREDENTIAL', 'credential "DEEPSEEK_API_KEY" is not set')
  const error = await call.then(() => undefined, (thrown) => thrown)
  assert.ok(error instanceof WebError)
  assert.equal(error.code, 'WEB_MISSING_CREDENTIAL')
  assert.match(error.message, /DEEPSEEK_API_KEY/)
  await engine.dispose()
})

it('drops an unparsable line without losing the next frame', async () => {
  const { engine, last, diag } = fakeEngine()
  const call = engine.search({ query: 'x', apiKey: 'k' })
  const child = last()
  await tick()
  child.stdout.emit('data', 'not json at all\n')
  child.emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  await tick()
  child.answer(0, { sources: [{ url: 'https://a.test' }], truncated: false })
  const result = await call
  assert.equal(result.sources.length, 1)
  assert.ok(diag.lines.some((line) => line.includes('unparsable engine frame')))
  await engine.dispose()
})

it('reassembles a ready frame split across two chunks', async () => {
  const { engine, last } = fakeEngine()
  const call = engine.search({ query: 'x', apiKey: 'k' })
  const child = last()
  await tick()
  const ready = `${JSON.stringify({ event: 'ready', engine: 'rust', version: '0.2.0' })}\n`
  child.stdout.emit('data', ready.slice(0, 20))
  await tick(1)
  assert.equal(child.sent.length, 0, 'a partial line is buffered, not parsed')
  child.stdout.emit('data', ready.slice(20))
  await tick()
  assert.equal(child.sent.length, 1, 'the reassembled ready frame completed the handshake')
  child.answer(0, { sources: [], truncated: false })
  assert.equal((await call).sources.length, 0)
  await engine.dispose()
})

it('sends a cancel frame and rejects with WEB_ABORTED', async () => {
  const { engine, last } = fakeEngine()
  const controller = new AbortController()
  const call = engine.search({ query: 'x', apiKey: 'k' }, controller.signal)
  const child = last()
  await tick()
  child.emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  await tick()
  const searchId = child.sent[0].id
  controller.abort()
  const error = await call.then(() => undefined, (thrown) => thrown)
  assert.equal(error.code, 'WEB_ABORTED')
  assert.equal(child.sent.length, 2)
  assert.equal(child.sent[1].method, 'cancel')
  assert.equal(child.sent[1].params.id, searchId, 'the cancel targets the in-flight request, not the cancel frame itself')
  await engine.dispose()
})

it('sends nothing, and starts nothing, when the signal is already aborted', async () => {
  const { engine, children } = fakeEngine()
  const controller = new AbortController()
  controller.abort()
  const error = await engine.search({ query: 'x', apiKey: 'k' }, controller.signal).then(() => undefined, (thrown) => thrown)
  assert.equal(error.code, 'WEB_ABORTED')
  assert.equal(children.length, 0, 'an aborted caller must not even start the engine')
  await engine.dispose()
})

it('reports a missing binary instead of spawning one', async () => {
  const { engine, children } = fakeEngine({ createOptions: { root: '/nowhere-at-all' } })
  assert.equal(engine.available(), false)
  assert.equal(engine.path, undefined)
  const error = await engine.search({ query: 'x', apiKey: 'k' }).then(() => undefined, (thrown) => thrown)
  assert.equal(error.code, 'WEB_PROVIDER_ERROR')
  assert.match(error.message, /engine binary was not found/)
  assert.match(error.message, /DSH_WEB_TOOLS_DEEPSEEK_BIN/)
  assert.equal(children.length, 0)
})

it('rejects every in-flight call when the engine dies, then restarts', async () => {
  const { engine, children, last, diag } = fakeEngine()
  const first = engine.search({ query: 'x', apiKey: 'k' })
  await tick()
  last().emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  await tick()
  last().emit('exit', 3, null)
  const error = await first.then(() => undefined, (thrown) => thrown)
  assert.equal(error.code, 'WEB_PROVIDER_ERROR')
  assert.match(error.message, /exited unexpectedly \(code 3\)/)
  assert.ok(diag.lines.some((line) => line.includes('restarted on the next call')))

  const second = engine.search({ query: 'y', apiKey: 'k' })
  await tick()
  assert.equal(children.length, 2, 'the next call starts a fresh engine')
  last().emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  await tick()
  last().answer(0, { sources: [], truncated: false })
  assert.equal((await second).sources.length, 0)
  await engine.dispose()
})

it('shuts the engine down through the protocol', async () => {
  const { engine, last } = fakeEngine()
  const configured = engine.configure(sanitize({}))
  const child = last()
  await tick()
  child.emitFrame({ event: 'ready', engine: 'rust', version: '0.2.0' })
  await tick()
  child.answer(0, {})
  await configured
  const disposed = engine.dispose()
  await tick()
  const shutdown = child.sent.find((frame) => frame.method === 'shutdown')
  assert.ok(shutdown !== undefined, 'shutdown is announced before the process is killed')
  child.emit('exit', 0, null)
  await disposed
  assert.equal(engine.state(), 'dead')
})

// --- the fallback policy ---------------------------------------------------

/** A stand-in for the model-backed provider this plugin replaces. */
function nativeProvider(overrides = {}) {
  return {
    id: 'deepseek-official',
    calls: 0,
    available: () => true,
    async search() {
      this.calls += 1
      return { sources: [{ url: 'https://native.test/a' }], truncated: false }
    },
    ...overrides,
  }
}

/** Build a search provider around a scripted engine. */
function searchWith(engine, options = {}) {
  const config = sanitize({ fallbackOn: 'both', ...options.config })
  const native = options.native ?? nativeProvider()
  const ctx = fakeContext({ providers: new Map([[native.id, native]]), ...options.ctx })
  const diagnostics = []
  const provider = createSearchProvider({
    id: config.searchProviderId,
    config,
    ctx,
    credentials: options.credentials ?? credentials(),
    engine,
    onWarn: (message) => diagnostics.push(message),
    onCall: (record) => diagnostics.push(JSON.stringify(record)),
  })
  return { provider, native, diagnostics }
}

it('falls back when the primary search fails', async () => {
  const engine = { available: () => true, search: async () => { throw new WebError('boom', 'WEB_PROVIDER_ERROR') } }
  const { provider, native, diagnostics } = searchWith(engine)
  const result = await provider.search({ query: 'q', maxResults: 3 })
  assert.equal(result.sources[0].url, 'https://native.test/a')
  assert.equal(native.calls, 1)
  assert.ok(diagnostics.some((line) => line.includes('"path":"fallback"')))
  assert.ok(diagnostics.some((line) => line.includes('deepseek-official')))
})

it('falls back when the primary search returns nothing', async () => {
  const engine = { available: () => true, search: async () => ({ sources: [], truncated: false }) }
  const { provider, native } = searchWith(engine)
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources.length, 1)
  assert.equal(native.calls, 1)
})

it('passes maxResults through to the fallback, and omits it when unset', async () => {
  const seen = []
  const engine = { available: () => true, search: async () => ({ sources: [], truncated: false }) }
  const native = nativeProvider({
    async search(request) {
      seen.push(request)
      return { sources: [{ url: 'https://native.test' }], truncated: false }
    },
  })
  const { provider } = searchWith(engine, { native })
  await provider.search({ query: 'a', maxResults: 4 })
  await provider.search({ query: 'b', maxResults: 0 })
  assert.deepEqual(seen, [{ query: 'a', maxResults: 4 }, { query: 'b' }])
})

it('honours fallbackOn=never and fallbackOn=empty', async () => {
  const failing = { available: () => true, search: async () => { throw new WebError('boom', 'WEB_PROVIDER_ERROR') } }
  const never = searchWith(failing, { config: { fallbackOn: 'never' } })
  await assert.rejects(never.provider.search({ query: 'q' }), /boom/)
  assert.equal(never.native.calls, 0)

  const emptyOnly = searchWith(failing, { config: { fallbackOn: 'empty' } })
  await assert.rejects(emptyOnly.provider.search({ query: 'q' }), /boom/)
  assert.equal(emptyOnly.native.calls, 0, 'an error is not an empty result')
})

it('does not fall back on an empty result when only errors are covered', async () => {
  const engine = { available: () => true, search: async () => ({ sources: [], truncated: false }) }
  const { provider, native } = searchWith(engine, { config: { fallbackOn: 'error' } })
  const result = await provider.search({ query: 'q' })
  assert.deepEqual(result.sources, [])
  assert.equal(native.calls, 0)
})

it('never falls back to itself', async () => {
  const engine = { available: () => true, search: async () => { throw new WebError('boom', 'WEB_PROVIDER_ERROR') } }
  const config = sanitize({ searchProviderId: 'loop', fallbackSearchProviderId: 'loop' })
  const self = nativeProvider({ id: 'loop' })
  const ctx = fakeContext({ providers: new Map([['loop', self]]) })
  const provider = createSearchProvider({ id: 'loop', config, ctx, credentials: credentials(), engine })
  await assert.rejects(provider.search({ query: 'q' }), /boom/)
  assert.equal(self.calls, 0, 'a self-referential fallback would recurse until the stack ends')
})

it('skips an unavailable fallback and an unreadable registry', async () => {
  const engine = { available: () => true, search: async () => { throw new WebError('boom', 'WEB_PROVIDER_ERROR') } }
  const down = nativeProvider({ available: () => false })
  const { provider: withDown } = searchWith(engine, { native: down })
  await assert.rejects(withDown.search({ query: 'q' }), /boom/)

  const blind = createSearchProvider({
    id: 'deepseek-tools-api',
    config: sanitize({}),
    ctx: {},
    credentials: credentials(),
    engine,
  })
  await assert.rejects(blind.search({ query: 'q' }), /boom/)
  assert.equal(readProviderRegistry({}, 'searchProviders'), undefined)
  assert.equal(resolveFallbackSearch({}, sanitize({}), 'deepseek-tools-api'), undefined)
})

it('reports the primary failure when the fallback fails too', async () => {
  const engine = { available: () => true, search: async () => { throw new WebError('primary exploded', 'WEB_PROVIDER_ERROR') } }
  const broken = nativeProvider({ async search() { throw new WebError('fallback exploded', 'WEB_PROVIDER_ERROR') } })
  const { provider, diagnostics } = searchWith(engine, { native: broken })
  await assert.rejects(provider.search({ query: 'q' }), /primary exploded/)
  assert.ok(diagnostics.some((line) => line.includes('fallback exploded')))
})

it('keeps the empty primary result when the fallback fails', async () => {
  const engine = { available: () => true, search: async () => ({ sources: [], truncated: false }) }
  const broken = nativeProvider({ async search() { throw new WebError('nope', 'WEB_PROVIDER_ERROR') } })
  const { provider, diagnostics } = searchWith(engine, { native: broken })
  const result = await provider.search({ query: 'q' })
  assert.deepEqual(result.sources, [])
  assert.ok(diagnostics.some((line) => line.includes('empty primary result')))
})

it('never spends a fallback call on a cancelled request', async () => {
  const controller = new AbortController()
  const engine = {
    available: () => true,
    search: async () => {
      controller.abort()
      throw new WebError('search was aborted', 'WEB_ABORTED')
    },
  }
  const { provider, native } = searchWith(engine)
  const error = await provider.search({ query: 'q' }, controller.signal).then(() => undefined, (thrown) => thrown)
  assert.equal(error.code, 'WEB_ABORTED')
  assert.equal(native.calls, 0)
})

it('available() is false when either half is unusable', () => {
  const engine = { available: () => true, search: async () => ({ sources: [], truncated: false }) }
  const { provider } = searchWith(engine)
  assert.equal(provider.available(), true)
  const noEngine = searchWith({ available: () => false, search: async () => ({}) })
  assert.equal(noEngine.provider.available(), false)
  const noKey = searchWith(engine, { credentials: { available: () => false, resolve: async () => 'k' } })
  assert.equal(noKey.provider.available(), false)
})

// --- the fetch provider ----------------------------------------------------

it('fetch delegates to the engine with the resolved key', async () => {
  const seen = []
  const engine = {
    available: () => true,
    fetch: async (params) => {
      seen.push(params)
      return { url: params.url, statusCode: 200, body: { kind: 'text', content: 'hi' }, truncated: false }
    },
  }
  const provider = createFetchProvider({ id: 'deepseek-tools-api', credentials: credentials(), engine })
  const result = await provider.fetch({ url: '  https://example.test/x  ' })
  assert.deepEqual(seen, [{ url: 'https://example.test/x', apiKey: 'test-key' }])
  assert.equal(result.body.kind, 'text')
  assert.equal(provider.available(), true)
})

it('fetch refuses an empty URL before it wakes the engine', async () => {
  let called = 0
  const engine = {
    available: () => true,
    fetch: async () => {
      called += 1
      return {}
    },
  }
  const provider = createFetchProvider({ id: 'deepseek-tools-api', credentials: credentials(), engine })
  await assert.rejects(provider.fetch({ url: '   ' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
  await assert.rejects(provider.fetch({}), (error) => error.code === 'WEB_PROVIDER_ERROR')
  assert.equal(called, 0)
})

// --- mounting --------------------------------------------------------------

/** Mount the plugin against a temporary diagnostics file. */
async function mount(options) {
  const directory = mkdtempSync(path.join(tmpdir(), 'webtools-unit-'))
  const diagFile = path.join(directory, 'diag.log')
  process.env.DSH_WEB_TOOLS_DEEPSEEK_DIAG_FILE = diagFile
  const ctx = fakeContext(options)
  const registered = []
  ctx.web.registerSearchProvider = (provider) => {
    registered.push(provider.id)
    return () => registered.splice(registered.indexOf(provider.id), 1)
  }
  ctx.web.registerFetchProvider = (provider) => {
    registered.push(provider.id)
    return () => registered.splice(registered.indexOf(provider.id), 1)
  }
  try {
    apply(ctx, new Config({}))
    // The real engine has to start and answer the handshake; poll for that line
    // instead of guessing a delay, so the test cannot lose a race on a slow spawn.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await tick(25)
      let text = ''
      try {
        text = readFileSync(diagFile, 'utf8')
      } catch {
        text = ''
      }
      if (text.includes('engine configured') || text.includes('engine is not usable')) break
    }
    // Copy before the `finally` disposes the effects: the disposers unregister.
    return { ctx, registered: registered.slice(), log: readFileSync(diagFile, 'utf8') }
  } finally {
    for (const effect of ctx.effects.slice().reverse()) {
      try {
        effect.dispose()
      } catch {
        // Disposal is best-effort in a test.
      }
    }
    await tick(10)
    delete process.env.DSH_WEB_TOOLS_DEEPSEEK_DIAG_FILE
    rmSync(directory, { recursive: true, force: true })
  }
}

it('apply registers both providers, starts the engine, and reports the seam wiring', async () => {
  const { ctx, registered, log } = await mount({ searchProviderId: 'deepseek-tools-api', fetchProviderId: 'deepseek-tools-api' })
  assert.deepEqual(registered, ['deepseek-tools-api', 'deepseek-tools-api'])
  assert.deepEqual(ctx.effects.map((effect) => effect.label), [
    'web-tools-deepseek: engine',
    'web-tools-deepseek: search provider',
    'web-tools-deepseek: fetch provider',
  ])
  assert.match(log, /registered search="deepseek-tools-api" fetch="deepseek-tools-api"/)
  assert.match(log, /fallback=deepseek-official:both/)
  assert.match(log, /engine=[^\s]*dsh-web-tools-deepseek[^\s]*\.exe/, 'the diagnostics name the binary that was found')
  assert.match(log, /engine configured/, 'the real engine answered the handshake')
  assert.match(log, /seam row is wired to this plugin/)
})

it('apply warns when the seam is pointed somewhere else', async () => {
  const { log } = await mount({ searchProviderId: 'deepseek-official', fetchProviderId: 'http' })
  assert.match(log, /registered but NOT selected for search \+ fetch/)
  assert.match(log, /search=deepseek-official/)
})

await Promise.allSettled(running)
console.log(`\n${passed} unit checks passed`)
if (failures.length > 0) {
  console.error(`${failures.length} failed:\n${failures.map((label) => `  - ${label}`).join('\n')}`)
  process.exitCode = 1
}
