/**
 * The panel's HTTP surface (`/api/mainline/*`).
 *
 * The client calls these with a document-relative path (`api/mainline/...`); the
 * host registers them with the leading slash. Every handler sits behind the same
 * fence as dsh-global-todo's: the Host's `connection.requestRejection`, resolved per
 * request (the service can register after this plugin), with a strict loopback rule
 * when there is no fence and a carve-out for credential-less local scripts.
 *
 * Routes only ever act as `{ kind: 'human' }`: a caller cannot claim to be the agent.
 *
 * @module dsh-mainline/routes
 */

import { TreeError, asTreeError } from './errors.js'
import { renderAsk } from './prompt.js'

/** Route prefix. */
export const ROUTE_BASE = '/api/mainline'

const MAX_BODY_BYTES = 1024 * 1024
const HUMAN = Object.freeze({ kind: 'human' })
const SSE_PING_MS = 25_000

/** @param {import('node:http').IncomingMessage} request */
export function hasBrowserCredentials(request) {
  const cookie = request.headers?.cookie
  if (typeof cookie === 'string' && cookie.trim() !== '') return true
  const origin = request.headers?.origin
  return typeof origin === 'string' && origin.trim() !== ''
}

/** Strict loopback: address, Host header and `sec-fetch-site` all have to agree. */
export function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  let hostname
  try {
    hostname = new URL(`http://${request.headers?.host ?? ''}`).hostname
  } catch {
    return false
  }
  if (!(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))) return false
  return request.headers?.['sec-fetch-site'] !== 'cross-site'
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(payload)
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new TreeError('payload-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new TreeError('invalid-json', `请求体不是合法 JSON：${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TreeError('invalid-json', '请求体必须是 JSON 对象')
  }
  return parsed
}

/**
 * @param {string} code
 * @returns {number} the HTTP status for a machine code
 */
export function statusForCode(code) {
  if (code === 'not-found') return 404
  if (code === 'payload-too-large') return 413
  if (code === 'forbidden') return 403
  // 503, not 500: another process held the lock; the same request usually succeeds a moment later.
  if (code === 'store-busy') return 503
  if (code === 'store-corrupt' || code === 'store-unwritable' || code === 'internal') return 500
  if (code === 'git-unavailable' || code === 'shell-unavailable' || code === 'session-unavailable') return 503
  return 400
}

/** @param {unknown} value @param {string} name */
function requireString(value, name) {
  if (typeof value !== 'string' || value === '') throw new TreeError('invalid-request', `缺少 ${name}`)
  return value
}

/**
 * @param {object} deps
 * @param {object} deps.service
 * @param {{ subscribe: Function, publish: Function }} deps.events
 * @param {object} deps.session
 * @param {object} deps.runner
 * @param {object} [deps.logger]
 * @param {object} [deps.rootCtx] - for the per-request `connection` lookup
 * @param {object} [deps.connection]
 * @param {string} deps.version
 * @param {() => object} [deps.health] - extra `/health` fields: `{ git, tools }`
 * @param {() => Promise<unknown>} [deps.whenReady] - awaited before every handler (store loaded)
 * @param {number} [deps.pingMs] - SSE keep-alive interval
 * @returns {Array<{ kind: 'exact', path: string, handler: Function }>}
 */
export function createRoutes(deps) {
  const { service, events, session, runner, logger, version } = deps

  const fenceOf = () => {
    if (deps.connection) return deps.connection
    try {
      return deps.rootCtx?.get?.('connection') ?? undefined
    } catch {
      return undefined
    }
  }

  /** Wrap a handler in the connection fence and the error mapping. */
  function route(handler) {
    return async (request, response) => {
      try {
        let rejection
        let fenceError = false
        const connection = fenceOf()
        try {
          rejection = connection?.requestRejection?.(request)
        } catch (error) {
          logger?.warn?.(`dsh-mainline: connection 围栏异常：${error?.message ?? error}`)
          // A fence that cannot answer is not an approval, and the local-script carve-out must not rescue it.
          rejection = 403
          fenceError = true
        }
        const fenced = typeof rejection === 'number' || (rejection !== undefined && rejection !== null)
        const localScript = !fenceError && isLoopbackRequest(request) && !hasBrowserCredentials(request)
        if (fenced && !localScript) {
          sendJson(response, typeof rejection === 'number' ? rejection : 403, {
            ok: false,
            reason: 'forbidden',
            error: '请求被宿主连接围栏拒绝',
          })
          return
        }
        if (!fenced && (connection === undefined || connection === null) && !isLoopbackRequest(request)) {
          sendJson(response, 403, { ok: false, reason: 'forbidden', error: '只接受本机请求' })
          return
        }
        await deps.whenReady?.()
        const result = await handler(request, response)
        if (result !== undefined && !response.writableEnded) sendJson(response, 200, { ok: true, data: result })
      } catch (error) {
        const wrapped = asTreeError(error)
        if (wrapped.code === 'internal') {
          logger?.warn?.(`dsh-mainline: ${request.method} ${request.url} 失败：${wrapped.stack ?? wrapped.message}`)
        }
        if (!response.writableEnded) sendJson(response, statusForCode(wrapped.code), wrapped.toJSON())
      }
    }
  }

  /**
   * One path, its verbs. Anything else is 405 before the fence is consulted. A path
   * must be registered once (the Host keys exact routes by path), so the one path
   * that serves two verbs (`/view`) is a single route that dispatches.
   */
  function exactVerbs(suffix, handlers) {
    return {
      kind: 'exact',
      path: `${ROUTE_BASE}${suffix}`,
      handler: async (request, response) => {
        const handler = handlers[request.method]
        if (!handler) {
          response.setHeader('allow', Object.keys(handlers).join(', '))
          sendJson(response, 405, { ok: false, reason: 'method-not-allowed', error: `请用 ${Object.keys(handlers).join(' / ')}` })
          return
        }
        await route(handler)(request, response)
      },
    }
  }
  const exact = (verb, suffix, handler) => exactVerbs(suffix, { [verb]: handler })

  const query = (request) => new URL(request.url ?? ROUTE_BASE, 'http://localhost').searchParams

  /** Take over the response and stream events until the client goes away. */
  function stream(request, response) {
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders?.()
    let closed = false
    let unsubscribe = () => {}
    let timer
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      try {
        unsubscribe?.()
      } catch {
        /* closing must not throw */
      }
    }
    const write = (chunk) => {
      if (closed) return
      try {
        response.write(chunk)
      } catch {
        cleanup()
      }
    }
    write('retry: 3000\n\n')
    if (closed) return undefined
    unsubscribe = events.subscribe((event) => write(`event: mainline\ndata: ${JSON.stringify(event)}\n\n`))
    timer = setInterval(() => write(': ping\n\n'), deps.pingMs ?? SSE_PING_MS)
    timer.unref?.()
    request.on?.('close', cleanup)
    response.on?.('close', cleanup)
    return undefined
  }

  return [
    exact('GET', '/health', async () => {
      const extra = deps.health?.() ?? {}
      return {
        version,
        root: service.root,
        git: extra.git ?? null,
        session: { sessionId: session.id(), cwd: session.cwd() },
        tools: extra.tools ?? null,
        projects: service.listProjects().length,
      }
    }),

    exact('GET', '/projects', async () => ({ projects: service.listProjects() })),

    exact('GET', '/project', async (request) => ({ project: service.getProject(requireString(query(request).get('id'), 'id')) })),

    exact('POST', '/op', async (request) => {
      const body = await readJsonBody(request)
      if (body.op === null || typeof body.op !== 'object' || Array.isArray(body.op)) {
        throw new TreeError('invalid-request', '缺少 op')
      }
      const result = await service.apply(body.op, HUMAN)
      return {
        project: result.project ?? null,
        nodeId: result.nodeId ?? null,
        ...(result.removed === undefined ? {} : { removed: result.removed }),
        events: result.events ?? [],
      }
    }),

    exact('POST', '/focus', async (request) => {
      const body = await readJsonBody(request)
      const project = requireString(body.project, 'project')
      const node = typeof body.node === 'string' && body.node !== '' ? body.node : null
      service.getProject(project) // not-found for a stale project instead of a silent no-op
      service.focus(project, node, HUMAN)
      return {}
    }),

    exact('GET', '/stream', stream),

    exact('GET', '/session', async () => ({ sessionId: await session.ensure(), cwd: session.cwd() })),

    exact('POST', '/session/reset', async (request) => {
      await readJsonBody(request)
      await session.reset()
      return { sessionId: await session.ensure() }
    }),

    exact('POST', '/run', async (request) => {
      const body = await readJsonBody(request)
      const ref = { project: requireString(body.project, 'project'), node: requireString(body.node, 'node'), index: body.index }
      return { run: await runner.run(ref, HUMAN) }
    }),

    exact('POST', '/run/cancel', async (request) => {
      const body = await readJsonBody(request)
      return { cancelled: runner.cancel(requireString(body.runId, 'runId')) }
    }),

    exact('GET', '/runs', async (request) => {
      const q = query(request)
      return { runs: runner.list({ project: q.get('project') || undefined, node: q.get('node') || undefined }) }
    }),

    exact('POST', '/ask', async (request) => {
      const body = await readJsonBody(request)
      const project = requireString(body.project, 'project')
      const node = requireString(body.node, 'node')
      const hasIndex = body.index !== undefined && body.index !== null
      if (hasIndex && (!Number.isInteger(body.index) || body.index < 0)) {
        throw new TreeError('invalid-request', 'index 必须是非负整数')
      }
      const note = typeof body.text === 'string' ? body.text.trim() : ''
      // The command is read from the stored card, never taken from the request.
      const target = runner.inspect({ project, node, index: hasIndex ? body.index : undefined })
      const text = renderAsk({ where: target.where, cwd: target.cwd, command: target.fence?.code, note })
      await session.ask(text, `工作树：交给 AI —— ${target.where}`)
      events.publish({
        type: 'session/asked',
        actor: HUMAN,
        project,
        node,
        summary: `把「${target.where}」交给了 AI`,
        data: { text },
      })
      return { sent: true }
    }),

    exact('GET', '/history', async (request) => {
      const q = query(request)
      const parsed = Number.parseInt(q.get('limit') ?? '', 10)
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50
      return { commits: await service.history(q.get('project') || null, limit) }
    }),

    exactVerbs('/view', {
      GET: async (request) => ({ view: await service.readView(requireString(query(request).get('project'), 'project')) }),
      POST: async (request) => {
        const body = await readJsonBody(request)
        if (body.view === null || typeof body.view !== 'object' || Array.isArray(body.view)) {
          throw new TreeError('invalid-request', 'view 必须是对象')
        }
        await service.writeView(requireString(body.project, 'project'), body.view)
        return {}
      },
    }),
  ]
}
