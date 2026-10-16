#!/usr/bin/env node
// Conformance test for the Rust engine, against a local mock of the DeepSeek API.
//
// The engine is driven exactly the way the plugin drives it — spawn the binary,
// speak newline-delimited JSON over stdio — and every request it makes lands on a
// loopback HTTP server instead of the real API. That makes the whole surface
// (payload shape, mapping, retry, rate limiting, cancellation, error codes)
// testable without spending a single billable call.
//
//   node test/engine.mjs
//   DSH_WEB_TOOLS_DEEPSEEK_BIN=/path/to/binary node test/engine.mjs

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN =
  process.env.DSH_WEB_TOOLS_DEEPSEEK_BIN ??
  path.join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'dsh-web-tools-deepseek.exe' : 'dsh-web-tools-deepseek')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const failures = []
/** Registered tests, run strictly one at a time: they all share one engine and one
 * `requests` log, so running them concurrently would let one test's `reset()` erase
 * another test's evidence. */
const tests = []
let count = 0

const it = (label, fn) => tests.push({ label, fn })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Key-order-insensitive canonical form: `serde_json`'s map is sorted, and the
 * order a request body happened to be built in says nothing about its correctness. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

function show(value) {
  return value === undefined ? 'undefined' : JSON.stringify(canonical(value))
}

function assertEqual(actual, expected, what) {
  const a = show(actual)
  const b = show(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

// ---------------------------------------------------------------- mock server

/** Every request the engine made, in arrival order. */
const requests = []
/** Replaced per test: receives the request record, returns {status, body, headers}. */
let handler = () => ({ status: 500, body: { error: { message: 'no handler installed' } } })
let stallTimers = []

const server = createServer((request, reply) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = raw
    }
    const record = { method: request.method, path: request.url, body, raw, headers: request.headers, at: Date.now() }
    requests.push(record)
    let result
    try {
      result = handler(record) ?? { status: 500, body: {} }
    } catch (error) {
      result = { status: 500, body: { error: { message: `handler threw: ${error.message}` } } }
    }
    if (result.stall) {
      // Used by the cancellation test: hold the socket open, then close quietly.
      stallTimers.push(
        setTimeout(() => {
          try {
            reply.destroy()
          } catch {}
        }, result.stall),
      )
      return
    }
    const payload = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {})
    reply.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...(result.headers ?? {}) })
    reply.end(payload)
  })
})

// ------------------------------------------------------------------ engine io

function readLines(stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
    }
  })
}

class Engine {
  constructor() {
    this.nextId = 1
    this.pending = new Map()
    this.logs = []
    this.calls = []
    this.orphans = []
    this.badLines = []
    this.stderr = ''
    this.readyFrame = undefined
    this.exit = undefined
  }

  async start(timeoutMs = 20000) {
    this.child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_WEB_TOOLS_DEEPSEEK_DIAG: '0' } })
    this.exited = new Promise(resolve => this.child.on('exit', (code, signal) => {
      this.exit = { code, signal }
      resolve(this.exit)
    }))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderr += chunk
    })
    readLines(this.child.stdout, line => this.#frame(line))
    return this.#waitFor(() => this.readyFrame, timeoutMs, 'the ready frame')
  }

  #frame(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.badLines.push(line)
      return
    }
    if (frame.id !== undefined) {
      const settle = this.pending.get(frame.id)
      if (settle) {
        this.pending.delete(frame.id)
        settle(frame)
      } else {
        this.orphans.push(frame)
      }
      return
    }
    if (frame.event === 'ready') this.readyFrame = frame
    else if (frame.event === 'log') this.logs.push(frame)
    else if (frame.event === 'call') this.calls.push(frame.record)
  }

  /** Send a request; resolve with the full response frame. */
  send(method, params) {
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out waiting for ${method} (id=${id})`))
      }, 20000)
      this.pending.set(id, frame => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return { id, promise }
  }

  /** Send a request and return only the result, throwing on an error frame. */
  async ok(method, params) {
    const { promise } = this.send(method, params)
    const frame = await promise
    if (!frame.ok) throw new Error(`${method} failed: ${frame.error?.code} ${frame.error?.message}`)
    return frame.result
  }

  /** Send a request and return only the error payload. */
  async fail(method, params) {
    const { promise } = this.send(method, params)
    const frame = await promise
    if (frame.ok) throw new Error(`${method} unexpectedly succeeded: ${JSON.stringify(frame.result)}`)
    return frame.error
  }

  cancel(id) {
    const { promise } = this.send('cancel', { id })
    return promise
  }

  async #waitFor(getter, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = getter()
      if (value !== undefined) return value
      await sleep(20)
    }
    throw new Error(`timed out waiting for ${what}; stderr=${this.stderr} logs=${JSON.stringify(this.logs)}`)
  }

  async stop() {
    try {
      const { promise } = this.send('shutdown')
      await Promise.race([promise, sleep(3000)])
    } catch {}
    const exited = await Promise.race([this.exited, sleep(5000).then(() => undefined)])
    if (exited === undefined) this.child.kill('SIGKILL')
    return exited
  }
}

// ----------------------------------------------------------------------- main

let engine
let origin
let lastRequest

const main = async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  engine = new Engine()
  const ready = await engine.start()

  const configure = async params => {
    await engine.ok('configure', {
      baseURL: origin,
      count: 10,
      snippetSource: 'summary',
      blockedAsResult: true,
      includeTitle: true,
      timeoutMs: 5000,
      retries: 1,
      qps: 50,
      userAgent: 'dsh-web-tools-deepseek-test/0.2.0',
      ...params,
    })
  }
  await configure({})
  const reset = () => {
    requests.length = 0
    lastRequest = undefined
  }
  const apiKey = 'test-key'

  it('announces a ready frame before it will accept a request', async () => {
    assertEqual(ready.event, 'ready', 'ready frame event')
    assertEqual(ready.engine, 'rust', 'ready frame engine')
    assert(/^\d+\.\d+\.\d+/.test(ready.version), `ready frame version looks like a semver, got ${ready.version}`)
    assertEqual(engine.badLines, [], 'unparsable stdout lines')
  })

  it('answers ping', async () => {
    const result = await engine.ok('ping', {})
    assertEqual(result.pong, true, 'pong')
    assertEqual(result.engine, 'rust', 'ping engine')
  })

  it('acknowledges configure and logs the effective settings', async () => {
    const result = await engine.ok('configure', { baseURL: `${origin}/`, count: 7, qps: 4, timeoutMs: 1234, retries: 2 })
    assertEqual(result.baseURL, origin, 'trailing slash stripped from baseURL')
    assertEqual(result.count, 7, 'count echoed')
    assertEqual(result.qps, 4, 'qps echoed')
    assertEqual(result.timeoutMs, 1234, 'timeoutMs echoed')
    assert(result.userAgent.startsWith('dsh-web-tools-deepseek/'), `default userAgent, got ${result.userAgent}`)
    const logged = engine.logs.filter(entry => entry.message.includes('engine configured'))
    assert(logged.length >= 1, 'configure emitted a log event')
    await configure({})
  })

  it('out-of-range configure values are clamped, not rejected', async () => {
    const result = await engine.ok('configure', { baseURL: origin, count: 999, retries: 99, qps: -3, timeoutMs: 0 })
    assertEqual(result.count, 50, 'count clamped to the API maximum')
    assertEqual(result.retries, 5, 'retries clamped')
    assertEqual(result.qps, 5, 'non-positive qps falls back to 5')
    assertEqual(result.timeoutMs, 0, 'timeoutMs 0 is preserved (it means "no deadline")')
    await configure({})
  })

  it('rejects an unparsable configure instead of silently using the defaults', async () => {
    const error = await engine.fail('configure', { baseURL: origin, count: 'ten' })
    assert(error.message.includes('not a valid configuration'), `message explains the problem, got ${error.message}`)
    // A rejected frame must leave the previous configuration in place: falling back
    // to the defaults would point every later call at the production API.
    reset()
    handler = () => ({ status: 200, body: { results: [] } })
    await engine.ok('search', { query: 'x', apiKey })
    assertEqual(requests.length, 1, 'the mock is still the configured baseURL')
    assertEqual(requests[0].path, '/v1/tools/search', 'nothing escaped to the real API')
  })

  it('search sends the documented payload and maps the seam source shape', async () => {
    reset()
    handler = () => ({
      status: 200,
      body: {
        results: [
          {
            rerank_score: 2.4,
            title: '  A title  ',
            url: 'https://example.com/a',
            snippet: 'short text',
            summary: 'long text',
            content: '',
            site_name: 'example',
            site_icon: null,
            date: '2026-03-04T05:06:07Z',
            authority: 4,
          },
          { title: 'no date', url: 'https://example.com/b', summary: 'second', date: null },
        ],
      },
    })
    const result = await engine.ok('search', { query: 'deepseek site:api-docs.deepseek.com', apiKey })
    lastRequest = requests[0]
    assertEqual(lastRequest.path, '/v1/tools/search', 'endpoint path')
    assertEqual(lastRequest.method, 'POST', 'method')
    assertEqual(lastRequest.headers.authorization, `Bearer ${apiKey}`, 'authorization header')
    assert(lastRequest.headers['content-type'].includes('application/json'), 'content-type header')
    assertEqual(
      lastRequest.body,
      { query: 'deepseek site:api-docs.deepseek.com', count: 10 },
      'request body is exactly query+count (no need_content, no empty ori_question)',
    )
    assertEqual(result.truncated, false, 'truncated')
    assertEqual(result.content, undefined, 'no synthetic content digest')
    assertEqual(result.sources.length, 2, 'source count')
    assertEqual(Object.keys(result.sources[0]).sort(), ['publishedAt', 'snippet', 'title', 'url'], 'source keys')
    assertEqual(result.sources[0], {
      url: 'https://example.com/a',
      title: 'A title',
      snippet: 'long text',
      publishedAt: '2026-03-04',
    }, 'first source')
    assertEqual(result.sources[1], { url: 'https://example.com/b', title: 'no date', snippet: 'second' }, 'null date omitted')
  })

  it('search asks for exactly what the caller can consume', async () => {
    reset()
    handler = () => ({ status: 200, body: { results: [] } })
    await engine.ok('search', { query: 'x', maxResults: 3.9, apiKey })
    assertEqual(requests[0].body.count, 3, 'maxResults truncates to an integer count')
    await engine.ok('search', { query: 'x', maxResults: 999, apiKey })
    assertEqual(requests[1].body.count, 50, 'count is capped at the API maximum')
  })

  it('search falls back to the configured snippet field and prefers summary by default', async () => {
    reset()
    handler = () => ({ status: 200, body: { results: [{ url: 'https://e/x', snippet: 'SHORT', summary: 'LONG' }] } })
    const preferSummary = await engine.ok('search', { query: 'x', apiKey })
    assertEqual(preferSummary.sources[0].snippet, 'LONG', 'summary preferred by default')
    await configure({ snippetSource: 'snippet' })
    const preferSnippet = await engine.ok('search', { query: 'x', apiKey })
    assertEqual(preferSnippet.sources[0].snippet, 'SHORT', 'snippet when configured')
    handler = () => ({ status: 200, body: { results: [{ url: 'https://e/y', snippet: 'ONLY-SHORT' }] } })
    const fallbackOnly = await engine.ok('search', { query: 'x', apiKey })
    assertEqual(fallbackOnly.sources[0].snippet, 'ONLY-SHORT', 'falls back to the other field when the preferred one is absent')
    await configure({})
  })

  it('search sends ori_question and localization only when configured', async () => {
    reset()
    handler = () => ({ status: 200, body: { results: [] } })
    await engine.ok('search', { query: 'x', apiKey })
    assertEqual(requests[0].body.ori_question, undefined, 'ori_question absent when unset')
    assertEqual(requests[0].body.localization, undefined, 'localization absent when unset')
    await configure({ oriQuestion: 'the user asked this', localization: '203.0.113.7' })
    await engine.ok('search', { query: 'x', apiKey })
    assertEqual(requests[1].body.ori_question, 'the user asked this', 'ori_question sent')
    assertEqual(requests[1].body.localization, '203.0.113.7', 'localization sent')
    await configure({})
  })

  it('search truncates an over-long ori_question instead of failing the call', async () => {
    reset()
    handler = () => ({ status: 200, body: { results: [] } })
    await configure({ oriQuestion: 'y'.repeat(300) })
    const before = engine.logs.length
    await engine.ok('search', { query: 'x', apiKey })
    assertEqual(requests[0].body.query, 'x', 'the search itself still ran')
    assertEqual(Array.from(requests[0].body.ori_question).length, 128, 'ori_question clamped to 128 characters')
    assert(
      engine.logs.slice(before).some(entry => entry.level === 'warn' && entry.message.includes('ori_question truncated')),
      'a warning was logged',
    )
    await configure({})
  })

  it('search rejects an over-long query locally, without a request', async () => {
    reset()
    handler = () => ({ status: 200, body: { results: [] } })
    const error = await engine.fail('search', { query: 'z'.repeat(129), apiKey })
    assertEqual(error.code, 'WEB_PROVIDER_ERROR', 'error code')
    assert(error.message.includes('exceeds 128 characters'), `message names the bound, got ${error.message}`)
    assertEqual(requests.length, 0, 'no HTTP request was made')
    const empty = await engine.fail('search', { query: '   ', apiKey })
    assert(empty.message.includes('non-empty query'), `blank query refused, got ${empty.message}`)
    assertEqual(requests.length, 0, 'still no HTTP request')
  })

  it('search refuses to send without an API key', async () => {
    reset()
    const error = await engine.fail('search', { query: 'x' })
    assertEqual(error.code, 'WEB_MISSING_CREDENTIAL', 'error code')
    assertEqual(requests.length, 0, 'no HTTP request was made')
  })

  it('search surfaces the API error envelope', async () => {
    reset()
    handler = () => ({ status: 400, body: { error: { message: "'count' must be between 1 and 50", type: 'invalid_request_error', param: null, code: 'invalid_request_error' } } })
    const error = await engine.fail('search', { query: 'x', apiKey })
    assertEqual(error.code, 'WEB_PROVIDER_ERROR', 'error code')
    assert(error.message.includes('deepseek search failed with HTTP 400'), `message names the endpoint and status, got ${error.message}`)
    assert(error.message.includes("'count' must be between 1 and 50"), `message carries the API text, got ${error.message}`)
    assertEqual(requests.length, 1, 'a 4xx is not retried')
  })

  it('search rejects a 200 that is missing the results array', async () => {
    reset()
    handler = () => ({ status: 200, body: { unexpected: true } })
    const error = await engine.fail('search', { query: 'x', apiKey })
    assertEqual(error.code, 'WEB_PROVIDER_ERROR', 'error code')
    assert(error.message.includes('no "results" array'), `message explains the shape problem, got ${error.message}`)
  })

  it('search survives a non-JSON body without crashing', async () => {
    reset()
    handler = () => ({ status: 200, body: '<html>not json</html>' })
    const error = await engine.fail('search', { query: 'x', apiKey })
    assertEqual(error.code, 'WEB_PROVIDER_ERROR', 'error code')
    assert(requests.length === 1, 'exactly one attempt')
  })

  it('fetch returns the page Markdown as a text body', async () => {
    reset()
    handler = () => ({ status: 200, body: { title: 'Ze Title', content: 'body text' } })
    const result = await engine.ok('fetch', { url: 'https://example.com/page', apiKey })
    assertEqual(requests[0].path, '/v1/tools/fetch', 'endpoint path')
    assertEqual(requests[0].body, { url: 'https://example.com/page' }, 'request body')
    assertEqual(result.statusCode, 200, 'status')
    assertEqual(result.url, 'https://example.com/page', 'url echoed')
    assertEqual(result.truncated, false, 'truncated')
    assertEqual(result.body.kind, 'text', 'body kind')
    assert(result.body.content.startsWith('# Ze Title\n\nbody text'), `title prepended, got ${JSON.stringify(result.body.content)}`)
  })

  it('fetch does not duplicate a title the Markdown already carries (escaped)', async () => {
    reset()
    handler = () => ({ status: 200, body: { title: 'Ze Title', content: '\\# Ze Title \\- a \\*b\\*' } })
    const result = await engine.ok('fetch', { url: 'https://example.com/page', apiKey })
    assertEqual(result.body.content, '\\# Ze Title \\- a \\*b\\*', 'escaped title is recognised, nothing prepended')
  })

  it('fetch reports a 403 as a result, not as a thrown error', async () => {
    reset()
    handler = () => ({ status: 403, body: { error: { message: 'URL access denied (request_id: abc-123)', type: 'permission_error', param: null, code: 'invalid_request_error' } } })
    const result = await engine.ok('fetch', { url: 'https://api-docs.deepseek.com/', apiKey })
    assertEqual(result.statusCode, 403, 'real status is preserved')
    assert(result.body.content.startsWith('[FETCH FAILED — NOT PAGE CONTENT]'), 'body is marked as not page content')
    assert(result.body.content.includes('URL access denied (request_id: abc-123)'), 'API message is carried through')
    assertEqual(requests.length, 1, 'a 403 is not retried')
  })

  it('fetch reports a 404 as a result too', async () => {
    reset()
    handler = () => ({ status: 404, body: { error: { message: 'failed to fetch URL (request_id: def-456)' } } })
    const result = await engine.ok('fetch', { url: 'https://news.ycombinator.com/', apiKey })
    assertEqual(result.statusCode, 404, 'real status is preserved')
    assert(result.body.content.includes('could not obtain usable page content'), 'documented 404 causes are restated')
  })

  it('fetch can be told to throw on 403/404 instead', async () => {
    reset()
    handler = () => ({ status: 404, body: { error: { message: 'failed to fetch URL' } } })
    await configure({ blockedAsResult: false })
    const error = await engine.fail('fetch', { url: 'https://example.com/', apiKey })
    assertEqual(error.code, 'WEB_PROVIDER_ERROR', 'error code')
    assert(error.message.includes('HTTP 404'), `message names the status, got ${error.message}`)
    await configure({})
  })

  it('fetch retries 5xx up to the configured bound, then fails', async () => {
    reset()
    handler = () => ({ status: 503, body: { error: { message: 'temporarily unavailable' } } })
    const error = await engine.fail('fetch', { url: 'https://example.com/', apiKey })
    assertEqual(error.code, 'WEB_PROVIDER_ERROR', 'error code')
    assertEqual(requests.length, 2, 'one initial attempt plus one retry')
    assert(engine.calls.some(record => record.attempts === 2), 'a call record reports the second attempt')
  })

  it('fetch honours Retry-After on 429 and then succeeds', async () => {
    reset()
    let seen = 0
    handler = () => {
      seen += 1
      return seen === 1
        ? { status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '0' } }
        : { status: 200, body: { title: 'ok', content: 'fine' } }
    }
    const result = await engine.ok('fetch', { url: 'https://example.com/', apiKey })
    assertEqual(requests.length, 2, 'retried once after the 429')
    assertEqual(result.statusCode, 200, 'second attempt succeeded')
  })

  it('fetch refuses a malformed or unsupported URL locally', async () => {
    reset()
    const cases = [
      [{ url: 'not-a-url', apiKey }, 'valid absolute URL'],
      [{ url: 'ftp://example.com/x', apiKey }, 'http or https'],
      [{ url: 'https://user:pass@example.com/', apiKey }, 'username or password'],
      [{ url: `https://example.com/${'x'.repeat(9000)}`, apiKey }, 'exceeds 8192 characters'],
      [{ url: '   ', apiKey }, 'non-empty url'],
    ]
    for (const [params, expected] of cases) {
      const error = await engine.fail('fetch', params)
      assertEqual(error.code, 'WEB_PROVIDER_ERROR', `error code for ${JSON.stringify(params.url).slice(0, 40)}`)
      assert(error.message.includes(expected), `message should mention "${expected}", got ${error.message}`)
    }
    assertEqual(requests.length, 0, 'no HTTP request was made for any rejected URL')
  })

  it('cancel aborts an in-flight call with WEB_ABORTED', async () => {
    reset()
    handler = () => ({ stall: 4000 })
    const { id, promise } = engine.send('search', { query: 'slow', apiKey })
    await sleep(300)
    const ack = await engine.cancel(id)
    assertEqual(ack.ok, true, 'cancel is acknowledged')
    assertEqual(ack.result.cancelled, true, 'cancel found the in-flight request')
    const frame = await promise
    assertEqual(frame.ok, false, 'the cancelled request fails')
    assertEqual(frame.error.code, 'WEB_ABORTED', 'error code')
  })

  it('cancel for an unknown id is a no-op', async () => {
    const { promise } = engine.send('cancel', { id: 999999 })
    const ack = await promise
    assertEqual(ack.ok, true, 'answered')
    assertEqual(ack.result.cancelled, false, 'nothing to cancel')
  })

  it('an unknown method is refused without killing the process', async () => {
    const error = await engine.fail('frobnicate', {})
    assert(error.message.includes('unknown method'), `message names the problem, got ${error.message}`)
    const result = await engine.ok('ping', {})
    assertEqual(result.pong, true, 'the engine is still alive')
  })

  it('paces requests to the configured QPS instead of bursting', async () => {
    reset()
    handler = () => ({ status: 200, body: { results: [] } })
    await configure({ qps: 10 })
    await Promise.all([
      engine.ok('search', { query: 'a', apiKey }),
      engine.ok('search', { query: 'b', apiKey }),
      engine.ok('search', { query: 'c', apiKey }),
    ])
    assertEqual(requests.length, 3, 'all three requests went out')
    const gaps = requests.slice(1).map((request, index) => request.at - requests[index].at)
    // interval = ceil(1000/10) = 100 ms; allow scheduling slack but not a burst.
    for (const gap of gaps) assert(gap >= 85, `gap between requests must respect the 100 ms interval, got ${gap} ms`)
    await configure({})
  })

  it('concurrent requests each get their own answer', async () => {
    reset()
    handler = record => ({ status: 200, body: { results: [{ url: `https://e/${record.body.query}`, summary: record.body.query }] } })
    const results = await Promise.all(
      ['p', 'q', 'r', 's'].map(query => engine.ok('search', { query, apiKey })),
    )
    assertEqual(results.map(result => result.sources[0].url), ['https://e/p', 'https://e/q', 'https://e/r', 'https://e/s'], 'each response matched its request')
  })

  it('shutdown is acknowledged and the process exits cleanly', async () => {
    const { promise } = engine.send('shutdown')
    const ack = await promise
    assertEqual(ack.ok, true, 'shutdown acknowledged')
    const exited = await Promise.race([engine.exited, sleep(5000).then(() => undefined)])
    assert(exited !== undefined, 'the process exited')
    assertEqual(exited.code, 0, 'exit code')
    assertEqual(engine.stderr, '', 'nothing was written to stderr')
  })

  for (const { label, fn } of tests) {
    try {
      await fn()
      count += 1
      console.log(`PASS  ${label}`)
    } catch (error) {
      failures.push(label)
      console.error(`FAIL  ${label}\n      ${error?.message ?? error}`)
    }
  }
  for (const timer of stallTimers) clearTimeout(timer)
  await new Promise(resolve => server.close(resolve))
  if (engine?.child && engine.exit === undefined) engine.child.kill('SIGKILL')

  const total = tests.length
  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${total} engine checks FAILED:\n  - ${failures.join('\n  - ')}`)
    process.exitCode = 1
  } else {
    console.log(`\n${count} engine checks passed`)
  }
}

main().catch(async error => {
  console.error('engine test harness failed:', error?.stack ?? error)
  if (engine?.child && engine.exit === undefined) engine.child.kill('SIGKILL')
  try {
    await new Promise(resolve => server.close(resolve))
  } catch {}
  process.exitCode = 1
})
