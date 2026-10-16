/**
 * End-to-end smoke test: real DeepSeek tools API, real Rust engine, fake cordis context.
 *
 * It exercises the plugin exactly as the seam would — `apply()` on a stub ctx,
 * then the providers it registered — and cross-checks every call against the raw
 * HTTP request, so a mapping bug cannot hide behind a passing assertion.
 *
 * The fallback path is proved *without* spending anything: the primary is pointed
 * at a closed port, so it fails at the transport layer (free, per the pricing
 * rules) and the registered fallback provider has to take over.
 *
 * Usage (from the plugin directory):
 *   node test/smoke.mjs          # needs a built engine: cargo build --release
 *
 * Cost: 4 successful calls ≈ ¥0.02. The key is read from `DEEPSEEK_API_KEY`, or
 * from the `refs:` block of `$DSH_HOME/.credentials.yaml`; it is never printed.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE_URL = 'https://api.deepseek.com'
const QUERY = 'DeepSeek 开放平台 搜索 API 定价'
const BLOCKED_URL = 'https://api-docs.deepseek.com/'

/** Resolve the API key without ever echoing it. */
function readApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const file = process.env.DSH_CREDENTIALS_FILE
    || path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text)
  if (match === null) throw new Error(`DEEPSEEK_API_KEY not found in ${file}`)
  return match[1].replace(/^["']|["']$/g, '')
}

// Point diagnostics at a file this run owns, so the assertions below can read
// back exactly what the plugin reported instead of whatever is in %TEMP%.
const diagFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'webtools-smoke-')), 'diag.log')
process.env.DSH_WEB_TOOLS_DEEPSEEK_DIAG_FILE = diagFile

const apiKey = readApiKey()
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  if (!ok) failures += 1
}
/**
 * Read the diagnostics log back.
 *
 * Lines are `<ISO> [level] <message>`; a `call` line's message is one JSON
 * attempt record, which is spread so the assertions can read `status` / `endpoint`
 * directly.
 * @returns {object[]} One entry per line.
 */
const diagLines = () => (readFileSync(diagFile, 'utf8').trim().split('\n').filter((l) => l.length > 0))
  .map((line) => {
    const match = /^\S+ \[(\w+)\] ([\s\S]*)$/.exec(line)
    if (match === null) return { level: '?', message: line }
    const [, level, rest] = match
    if (level !== 'call') return { level, message: rest }
    try { return { level, ...JSON.parse(rest) } } catch { return { level, message: rest } }
  })

/** Raw API call, for the reference side of every comparison. */
async function raw(pathname, payload) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  return { status: response.status, json: (() => { try { return JSON.parse(text) } catch { return undefined } })(), text }
}

/**
 * Mount the plugin on a stub ctx.
 * @param {object} [overrides] - Raw config overrides.
 * @param {Map} [providers] - Pre-registered seam providers, for the fallback.
 * @returns {Promise<object>} The registered providers, disposers and log lines.
 */
async function mount(overrides = {}, providers = new Map()) {
  const { apply, Config } = await import('../lib/index.js')
  const registered = {}
  const disposers = []
  const stubCtx = {
    logger: { info: (m) => console.log(`  [plugin] ${m}`), warn: (m) => console.log(`  [plugin:warn] ${m}`) },
    get: (name) => (name === 'credentials'
      ? { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: apiKey, source: 'smoke-test' } : undefined) }
      : undefined),
    effect: (callback) => { disposers.push(callback()) },
    web: {
      searchProviders: providers,
      registerSearchProvider: (provider) => { registered.search = provider; return () => { delete registered.search } },
      registerFetchProvider: (provider) => { registered.fetch = provider; return () => { delete registered.fetch } },
    },
  }
  apply(stubCtx, Config(overrides))
  // Let the engine handshake settle before the first call is made.
  await new Promise((resolve) => setTimeout(resolve, 400))
  return { registered, dispose: async () => { for (const d of disposers.reverse()) await d?.() } }
}

// ---------------------------------------------------------------- wiring ----
const run = await mount()
const { registered, dispose } = run
console.log('\n== wiring ==')
check('search provider id', registered.search?.id === 'deepseek-tools-api', registered.search?.id)
check('fetch provider id', registered.fetch?.id === 'deepseek-tools-api', registered.fetch?.id)
check('search.available() is a local true', registered.search?.available() === true)
check('fetch.available() is a local true', registered.fetch?.available() === true)
const firstLine = diagLines().find((entry) => typeof entry.message === 'string' && entry.message.includes('registered search='))
check('startup line names the engine it will use', firstLine !== undefined && /engine=.+dsh-web-tools-deepseek/.test(firstLine.message),
  firstLine?.message?.match(/engine=\S+/)?.[0])

// ---------------------------------------------------------------- search ----
console.log('\n== search ==')
const searchResult = await registered.search.search({ query: QUERY, maxResults: 8 })
check('sources returned', searchResult.sources.length > 0, `count=${searchResult.sources.length}`)
check('at most maxResults sources', searchResult.sources.length <= 8, `count=${searchResult.sources.length}`)
check('truncated is false', searchResult.truncated === false)
check('content left unset (D2)', searchResult.content === undefined)
check('every source has an absolute url', searchResult.sources.every((s) => /^https?:\/\//.test(s.url)))

const rawSearch = await raw('/v1/tools/search', { query: QUERY, count: 8 })
console.log(`  raw status=${rawSearch.status} results=${rawSearch.json?.results?.length}`)
const providerUrls = searchResult.sources.map((s) => s.url)
const rawUrls = (rawSearch.json?.results ?? []).map((r) => r.url)
check('provider order matches raw request', JSON.stringify(providerUrls) === JSON.stringify(rawUrls))
check('snippet carries the model-facing summary, not the display snippet',
  (searchResult.sources[0].snippet ?? '').length > 300 && searchResult.sources[0].snippet !== rawSearch.json?.results?.[0]?.snippet,
  `mapped=${(searchResult.sources[0].snippet ?? '').length}ch raw_snippet=${(rawSearch.json?.results?.[0]?.snippet ?? '').length}ch`)
console.log(`  raw item[0]     = ${JSON.stringify(rawSearch.json?.results?.[0])?.slice(0, 200)}`)
console.log(`  mapped source[0]= ${JSON.stringify({ ...searchResult.sources[0], snippet: `${(searchResult.sources[0].snippet ?? '').slice(0, 60)}…` })}`)

// ----------------------------------------------------------------- fetch ----
console.log('\n== fetch (success path) ==')
const target = providerUrls[0]
const fetchResult = await registered.fetch.fetch({ url: target })
const rawFetch = await raw('/v1/tools/fetch', { url: target })
console.log(`  target=${target} provider status=${fetchResult.statusCode} raw status=${rawFetch.status}`)
check('statusCode is 200', fetchResult.statusCode === 200)
check('body kind is text', fetchResult.body.kind === 'text')
check('truncated is false', fetchResult.truncated === false)
const rawContent = rawFetch.json?.content ?? ''
const body = fetchResult.body.content
const titleHeading = typeof rawFetch.json?.title === 'string' && rawFetch.json.title.trim().length > 0 ? `# ${rawFetch.json.title.trim()}\n\n` : ''
check('body equals API content (modulo the optional title heading)',
  body === rawContent || body === `${titleHeading}${rawContent}`,
  `provider=${body.length}ch raw=${rawContent.length}ch`)
check('title visible to the model', body.includes('# ') || rawContent.startsWith('#'))
console.log(`  provider head: ${JSON.stringify(body.slice(0, 160))}`)

console.log('\n== fetch (403 verdict path) ==')
const blocked = await registered.fetch.fetch({ url: BLOCKED_URL })
check('403 returned as a result, not a throw', blocked.statusCode === 403, `statusCode=${blocked.statusCode}`)
check('body is marked as not-page-content', blocked.body.content.startsWith('[FETCH FAILED — NOT PAGE CONTENT]'))
check('verdict body carries no page markup', !blocked.body.content.includes('<html'))
console.log(`  body: ${JSON.stringify(blocked.body.content.slice(0, 220))}`)

const blockedRaw = await raw('/v1/tools/fetch', { url: BLOCKED_URL })
console.log(`  raw status=${blockedRaw.status} message=${blockedRaw.json?.error?.message}`)

// ------------------------------------------------------------- negatives ----
console.log('\n== local validation (no request spent) ==')
const beforeNegatives = diagLines().filter((entry) => entry.level === 'call').length
for (const bad of ['', 'not-a-url', 'ftp://example.com/x', 'https://user:pw@example.com/', 'https://example.com/' + 'a'.repeat(9000)]) {
  let threw = undefined
  try {
    await registered.fetch.fetch({ url: bad })
  } catch (error) {
    threw = error
  }
  check(`rejects ${JSON.stringify(bad.slice(0, 34))}`, threw?.name === 'WebError', threw?.code)
}
let emptyQuery = undefined
try {
  await registered.search.search({ query: '   ' })
} catch (error) {
  emptyQuery = error
}
check('rejects a blank query', emptyQuery?.name === 'WebError', emptyQuery?.code)
check('local rejections never reached the engine', diagLines().filter((entry) => entry.level === 'call').length === beforeNegatives,
  `new HTTP attempts=${diagLines().filter((entry) => entry.level === 'call').length - beforeNegatives}`)

// -------------------------------------------------------------- fallback ----
console.log('\n== fallback to another registered provider (free: the primary port is closed) ==')
const fallbackCalls = []
const fallbackProvider = {
  id: 'deepseek-official',
  available: () => true,
  search: async (request) => {
    fallbackCalls.push(request)
    return { sources: [{ url: 'https://example.com/native', title: 'native result', snippet: 'from the fallback' }], truncated: false }
  },
}
const unreachable = await mount({ baseURL: 'http://127.0.0.1:1', fallbackOn: 'both' }, new Map([['deepseek-official', fallbackProvider]]))
const fallbackResult = await unreachable.registered.search.search({ query: QUERY, maxResults: 3 })
check('the fallback result is what the caller gets', fallbackResult.sources?.[0]?.url === 'https://example.com/native',
  fallbackResult.sources?.[0]?.url)
check('the fallback saw the same query and maxResults', fallbackCalls.length === 1 && fallbackCalls[0].query === QUERY && fallbackCalls[0].maxResults === 3,
  JSON.stringify(fallbackCalls[0]))
const noFallback = await mount({ baseURL: 'http://127.0.0.1:1', fallbackOn: 'never' }, new Map([['deepseek-official', fallbackProvider]]))
let primaryOnly = undefined
try {
  await noFallback.registered.search.search({ query: QUERY })
} catch (error) {
  primaryOnly = error
}
check('fallbackOn=never reports the primary transport failure instead', primaryOnly?.name === 'WebError', primaryOnly?.code)
await unreachable.dispose()
await noFallback.dispose()

// ------------------------------------------------------------ diagnostics ----
console.log('\n== diagnostics ==')
const engineCalls = diagLines().filter((entry) => typeof entry.endpoint === 'string')
const fallbackCallsLogged = diagLines().filter((entry) => entry.path === 'fallback')
check('each HTTP attempt is logged with a numeric status', engineCalls.length >= 5 && engineCalls.every((c) => typeof c.status === 'number'),
  `${engineCalls.length} engine records, statuses=${engineCalls.map((c) => c.status).join(',')}`)
check('the successful search took exactly one attempt',
  engineCalls.some((c) => c.status === 200 && c.attempts === 1 && c.endpoint.endsWith('/v1/tools/search')))
check('the transport failure was retried (retries=1) once per failing mount, then handed to the fallback',
  engineCalls.filter((c) => c.code === 'TRANSPORT').length === 4 && fallbackCallsLogged.length === 1,
  `transport=${engineCalls.filter((c) => c.code === 'TRANSPORT').length} (2 mounts x 2 attempts) fallback=${fallbackCallsLogged.length}`)

await dispose()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
console.log(`diag log: ${diagFile}`)
process.exit(failures === 0 ? 0 : 1)
