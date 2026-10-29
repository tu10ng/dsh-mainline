import { strict as assert } from 'node:assert'
import test from 'node:test'

import { TreeError } from '../lib/errors.js'
import { ROUTE_BASE, createRoutes, isLoopbackRequest, statusForCode } from '../lib/routes.js'
import { makeEvents, makeService } from './helpers/host-fakes.mjs'

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    chunks: [],
    writableEnded: false,
    listeners: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    write(chunk) {
      this.chunks.push(chunk)
    },
    end(chunk) {
      this.body = chunk ?? ''
      this.writableEnded = true
    },
    on(name, fn) {
      this.listeners[name] = fn
    },
    json() {
      return this.body === '' ? null : JSON.parse(this.body)
    },
  }
}

function makeReq(options = {}) {
  const body = options.body === undefined ? '' : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  return {
    method: options.method ?? 'GET',
    url: options.url ?? ROUTE_BASE,
    headers: options.headers ?? { host: '127.0.0.1:3080' },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    listeners: {},
    on(name, fn) {
      this.listeners[name] = fn
    },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

function harness(options = {}) {
  const service = options.service ?? makeService()
  const events = makeEvents()
  const calls = []
  const session = {
    id: () => 'session-1',
    cwd: () => '/cwd',
    ensure: async () => 'session-1',
    reset: async () => calls.push('reset'),
    ask: async (text, summary) => calls.push(['ask', text, summary]),
  }
  const runner = {
    run: async (ref, actor) => (calls.push(['run', ref, actor]), { runId: 'r1', status: 'running' }),
    cancel: (id) => (calls.push(['cancel', id]), id === 'r1'),
    list: (filter) => (calls.push(['list', filter]), []),
    inspect: ({ index }) => ({ where: 'W', cwd: '/c', fence: index === undefined ? null : { code: 'echo stored' } }),
  }
  const routes = createRoutes({ service, events, session, runner, version: '0.0.0-test', ...options.deps })
  const call = async (suffix, request) => {
    const route = routes.find((r) => r.path === `${ROUTE_BASE}${suffix}`)
    assert.ok(route, `no route ${suffix}`)
    const response = makeRes()
    await route.handler(request, response)
    return response
  }
  return { service, events, calls, routes, call }
}

const post = (suffix, body, extra = {}) => makeReq({ method: 'POST', url: `${ROUTE_BASE}${suffix}`, body, ...extra })
const get = (suffix, extra = {}) => makeReq({ url: `${ROUTE_BASE}${suffix}`, ...extra })

test('the route table matches the contract, one verb per path', () => {
  const { routes } = harness()
  assert.deepEqual(routes.map((r) => r.path.slice(ROUTE_BASE.length)).sort(), [
    '/ask', '/focus', '/health', '/history', '/op', '/project', '/projects', '/run', '/run/cancel', '/runs',
    '/session', '/session/reset', '/stream', '/view',
  ].sort())
  assert.ok(routes.every((r) => r.kind === 'exact' && r.path.startsWith('/api/mainline/')))
})

test('a wrong verb is 405 with an allow header', async () => {
  const { call } = harness()
  const res = await call('/projects', post('/projects', {}))
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
  assert.equal((await call('/view', makeReq({ method: 'DELETE', url: `${ROUTE_BASE}/view` }))).headers.allow, 'GET, POST')
  const op = await call('/op', get('/op'))
  assert.equal(op.statusCode, 405)
  assert.equal(op.headers.allow, 'POST')
})

test('health reports version, root, session and counts', async () => {
  const { call } = harness({ deps: { health: () => ({ git: { available: true }, tools: { registered: ['a'] } }) } })
  const res = await call('/health', get('/health'))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().data, {
    version: '0.0.0-test',
    root: '/tree-root',
    git: { available: true },
    session: { sessionId: 'session-1', cwd: '/cwd' },
    tools: { registered: ['a'] },
    projects: 1,
  })
})

test('statusForCode follows the contract', () => {
  const expected = {
    'not-found': 404, 'payload-too-large': 413, forbidden: 403, 'store-busy': 503, 'store-corrupt': 500,
    'store-unwritable': 500, internal: 500, 'git-unavailable': 503, 'shell-unavailable': 503,
    'session-unavailable': 503, 'invalid-op': 400, 'invalid-json': 400,
  }
  for (const [code, status] of Object.entries(expected)) assert.equal(statusForCode(code), status, code)
})

test('op applies as the human actor and returns the project after the op', async () => {
  const { call, service } = harness()
  const res = await call('/op', post('/op', { op: { type: 'update', project: 'p1', id: 's1', patch: { title: 'x' } }, actor: { kind: 'agent' } }))
  assert.equal(res.statusCode, 200)
  const data = res.json().data
  assert.equal(data.nodeId, 's1')
  assert.equal(data.project.id, 'p1')
  assert.deepEqual(service.calls[0][2], { kind: 'human' }, 'a request cannot claim to be the agent')
})

test('service failures keep their code and status; invalid bodies are 400', async () => {
  const service = makeService()
  service.apply = async () => {
    throw new TreeError('store-busy', '锁被占用')
  }
  const { call } = harness({ service })
  const busy = await call('/op', post('/op', { op: { type: 'x' } }))
  assert.equal(busy.statusCode, 503)
  assert.equal(busy.json().reason, 'store-busy')
  assert.equal((await call('/op', post('/op', '{nope'))).json().reason, 'invalid-json')
  assert.equal((await call('/op', post('/op', {}))).statusCode, 400)
  assert.equal((await call('/op', post('/op', '[1]'))).json().reason, 'invalid-json')
  const big = await call('/op', post('/op', 'x'.repeat(1024 * 1024 + 1)))
  assert.equal(big.statusCode, 413)
})

test('an unexpected throw is a 500 internal', async () => {
  const service = makeService()
  service.listProjects = () => {
    throw new Error('kaboom')
  }
  const res = await harness({ service }).call('/projects', get('/projects'))
  assert.equal(res.statusCode, 500)
  assert.equal(res.json().reason, 'internal')
})

test('project needs an id and 404s for an unknown one', async () => {
  const { call } = harness()
  assert.equal((await call('/project', get('/project'))).statusCode, 400)
  assert.equal((await call('/project', get('/project?id=zz'))).statusCode, 404)
  assert.equal((await call('/project', get('/project?id=p1'))).json().data.project.id, 'p1')
})

test('focus records the human actor and rejects a stale project', async () => {
  const { call, service } = harness()
  assert.equal((await call('/focus', post('/focus', { project: 'p1', node: 's1' }))).json().ok, true)
  assert.deepEqual(service.calls.at(-1), ['focus', 'p1', 's1', { kind: 'human' }])
  await call('/focus', post('/focus', { project: 'p1', node: '' }))
  assert.equal(service.calls.at(-1)[2], null)
  assert.equal((await call('/focus', post('/focus', { project: 'gone', node: 's1' }))).statusCode, 404)
})

test('run passes only a reference to the runner, never request text', async () => {
  const { call, calls } = harness()
  const res = await call('/run', post('/run', { project: 'p1', node: 's1', index: 0, command: 'rm -rf /' }))
  assert.equal(res.json().data.run.runId, 'r1')
  assert.deepEqual(calls[0], ['run', { project: 'p1', node: 's1', index: 0 }, { kind: 'human' }])
  assert.equal((await call('/run', post('/run', { project: 'p1' }))).statusCode, 400)
})

test('cancel, runs and session routes', async () => {
  const { call, calls } = harness()
  assert.equal((await call('/run/cancel', post('/run/cancel', { runId: 'r1' }))).json().data.cancelled, true)
  assert.equal((await call('/run/cancel', post('/run/cancel', {}))).statusCode, 400)
  await call('/runs', get('/runs?project=p1&node=s1'))
  assert.deepEqual(calls.at(-1), ['list', { project: 'p1', node: 's1' }])
  assert.deepEqual((await call('/session', get('/session'))).json().data, { sessionId: 'session-1', cwd: '/cwd' })
  assert.deepEqual((await call('/session/reset', post('/session/reset', {}))).json().data, { sessionId: 'session-1' })
  assert.ok(calls.includes('reset'))
})

test('ask builds the text from the stored card, publishes session/asked and answers sent', async () => {
  const { call, calls, events } = harness()
  const res = await call('/ask', post('/ask', { project: 'p1', node: 's1', index: 0, text: '注意权限', command: 'rm -rf /' }))
  assert.deepEqual(res.json().data, { sent: true })
  const [, text, summary] = calls.find((c) => c[0] === 'ask')
  assert.match(text, /echo stored/)
  assert.ok(!text.includes('rm -rf'))
  assert.match(text, /注意权限/)
  assert.match(summary, /W/)
  assert.equal(events.published[0].type, 'session/asked')

  await call('/ask', post('/ask', { project: 'p1', node: 's1' }))
  assert.match(calls.filter((c) => c[0] === 'ask')[1][1], /请继续推进「W」/)
  assert.equal((await call('/ask', post('/ask', { project: 'p1', node: 's1', index: 'x' }))).statusCode, 400)
})

test('history clamps the limit; view round-trips', async () => {
  const { call, service } = harness()
  await call('/history', get('/history?project=p1&limit=9999'))
  assert.deepEqual(service.calls.at(-1), ['history', 'p1', 200])
  await call('/history', get('/history'))
  assert.deepEqual(service.calls.at(-1), ['history', null, 50])
  assert.deepEqual((await call('/view', get('/view?project=p1'))).json().data, { view: { camera: 1 } })
  assert.equal((await call('/view', post('/view', { project: 'p1', view: { camera: 2 } }))).json().ok, true)
  assert.deepEqual(service.calls.at(-1), ['writeView', 'p1', { camera: 2 }])
  assert.equal((await call('/view', post('/view', { project: 'p1', view: [] }))).statusCode, 400)
})

test('stream sets SSE headers, forwards events, pings and unsubscribes on close', async () => {
  const { call, events } = harness({ deps: { pingMs: 10 } })
  const req = get('/stream')
  const res = await call('/stream', req)
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /^text\/event-stream/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.writableEnded, false, 'the response stays open')
  assert.equal(res.chunks[0], 'retry: 3000\n\n')
  assert.equal(events.subscribers.size, 1)

  events.publish({ type: 'node/created', summary: '加了', actor: { kind: 'human' } })
  const frame = res.chunks.find((c) => c.startsWith('event: mainline\n'))
  assert.ok(frame)
  assert.equal(JSON.parse(frame.split('data: ')[1]).type, 'node/created')

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(res.chunks.includes(': ping\n\n'))

  req.listeners.close()
  assert.equal(events.subscribers.size, 0)
  const before = res.chunks.length
  events.publish({ type: 'node/updated', summary: 'x', actor: { kind: 'human' } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(res.chunks.length, before, 'nothing is written after close, pings included')
})

test('a write error on the stream cleans up instead of throwing', async () => {
  const h = harness()
  const res = makeRes()
  res.write = () => {
    throw new Error('EPIPE')
  }
  await h.routes.find((r) => r.path.endsWith('/stream')).handler(get('/stream'), res)
  assert.equal(h.events.subscribers.size, 0)
})

test('a remote address is refused when no fence exists', async () => {
  const res = await harness().call('/projects', get('/projects', { address: '192.168.1.50', headers: { host: '192.168.1.50:3080' } }))
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().reason, 'forbidden')
})

test('the fence wins whenever present, is looked up per request, and a throwing fence fails closed', async () => {
  let fence
  const rootCtx = { get: (name) => (name === 'connection' ? fence : undefined) }
  const { call } = harness({ deps: { rootCtx } })
  const remote = { address: '192.168.1.50', headers: { host: '192.168.1.50:3080' } }
  assert.equal((await call('/projects', get('/projects', remote))).statusCode, 403)

  fence = { requestRejection: () => undefined }
  assert.equal((await call('/projects', get('/projects', remote))).statusCode, 200, 'a late-registered fence is used')

  fence = { requestRejection: () => 401 }
  assert.equal((await call('/projects', get('/projects', remote))).statusCode, 401)
  const withCookie = { headers: { host: '127.0.0.1:3080', cookie: 'a=b' } }
  assert.equal((await call('/projects', get('/projects', withCookie))).statusCode, 401, 'a browser goes through the fence')
  assert.equal((await call('/projects', get('/projects'))).statusCode, 200, 'a credential-less local script is admitted')

  fence = {
    requestRejection() {
      throw new Error('fence broke')
    },
  }
  assert.equal((await call('/projects', get('/projects'))).statusCode, 403, 'fail closed, no carve-out')
})

test('the loopback predicate is strict about address, host and sec-fetch-site', () => {
  const ok = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } }
  assert.equal(isLoopbackRequest(ok), true)
  assert.equal(isLoopbackRequest({ ...ok, headers: { host: 'evil.example' } }), false)
  assert.equal(isLoopbackRequest({ ...ok, headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.2' }, headers: { host: 'localhost' } }), false)
})

test('whenReady is awaited before the handler runs', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const { call, service } = harness({ deps: { whenReady: () => gate } })
  let done = false
  const pending = call('/projects', get('/projects')).then((r) => ((done = true), r))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(done, false)
  release()
  assert.equal((await pending).statusCode, 200)
  void service
})
