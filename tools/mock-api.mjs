/**
 * An in-memory stand-in for the host routes (`/api/mainline/*`).
 *
 * `tools/dev-server.mjs` uses it when the real host half cannot be mounted (or with
 * `--mock`). It speaks the same wire shapes as SPEC 4.4 — `{ ok, data }` / `{ ok: false,
 * reason, error }`, the SPEC 1.1 node, the SSE `event: mainline` stream — and implements
 * the ops of SPEC 3.6 well enough to drive the panel. Nothing is written to disk, nothing
 * is executed: `run` answers canned output after a delay.
 *
 * @module dsh-mainline/tools/mock-api
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'console', 'pwsh', 'powershell', 'ps1', 'cmd', 'bat']
const CAN_CONTAIN = {
  project: ['step', 'fork', 'ref'],
  step: ['step', 'fork', 'ref'],
  fork: ['lane', 'ref'],
  lane: ['step', 'fork', 'ref'],
  ref: ['ref'],
}
const OP_KEYS = {
  create: ['project', 'parent', 'after', 'kind', 'title', 'state', 'question', 'body', 'attrs'],
  update: ['project', 'id', 'patch'],
  move: ['project', 'id', 'parent', 'after'],
  remove: ['project', 'id'],
  insert: ['project', 'parent', 'after', 'node'],
  fork: ['project', 'after', 'title', 'lanes'],
  createProject: ['title', 'body', 'markdown'],
  removeProject: ['project'],
  renameProject: ['project', 'title'],
  reorderProjects: ['order'],
  restore: ['project', 'rev'],
}

/** Same rule as runner.js: shell fences only, `index` counts them in order. */
export function extractFences(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n')
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue
    let close = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j])
      if (m && m[1][0] === open[1][0] && m[1].length >= open[1].length) {
        close = j
        break
      }
    }
    if (close < 0) continue
    const lang = (open[2].trim().split(/\s+/)[0] ?? '').toLowerCase()
    if (SHELL_LANGS.includes(lang)) found.push({ index: found.length, lang, code: lines.slice(i + 1, close).join('\n') })
    i = close
  }
  return found
}

/** Believable output for the commands the fixtures carry; never a real execution. */
export function cannedRun(command) {
  const out = []
  for (const line of String(command).split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    if (/dmesg/.test(line)) {
      out.push(
        '[   12.480211] ata1: link up 6.0 Gbps',
        '[   12.481902] ata1.00: ATA-11: WDC WD80EFZZ, max UDMA/133',
        '[   13.002117] ata1.00: configured for UDMA/133',
        '[  842.113400] ata1: hard resetting link (ttq=3)',
      )
    } else if (/insmod/.test(line)) out.push('pool: tank  state: ONLINE')
    else if (/smartctl|lsblk/.test(line)) out.push('sda  WDC WD80EFZZ  Health: PASSED  Temperature: 38C  PowerOnHours: 18233')
    else out.push(`(mock) ${line}`)
  }
  const failed = /\bfalse\b|exit 1/.test(command)
  return { exitCode: failed ? 1 : 0, stdout: out.join('\n'), stderr: failed ? 'mock: command failed on purpose' : '' }
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

const STATUS = {
  'not-found': 404,
  'payload-too-large': 413,
  forbidden: 403,
  'store-busy': 503,
  internal: 500,
  'git-unavailable': 503,
  'shell-unavailable': 503,
  'session-unavailable': 503,
}

const clone = (value) => JSON.parse(JSON.stringify(value))

function walk(node, fn, parent = null) {
  fn(node, parent)
  for (const child of node.children) walk(child, fn, node)
}

function find(root, id) {
  let hit = null
  const visit = (node, parent, path) => {
    if (hit) return
    if (node.id === id) {
      hit = { node, parent, index: parent ? parent.children.indexOf(node) : -1, path }
      return
    }
    for (const child of node.children) visit(child, node, [...path, node])
  }
  visit(root, null, [])
  return hit
}

function cleanTitle(value) {
  const title = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (title === '' || title.length > 300) fail('invalid-title', '标题需要 1–300 个字')
  return title
}

/**
 * @param {{ treeFile: string, runDelayMs?: number, log?: (line: string) => void }} options
 */
export function createMockApi(options) {
  const runDelayMs = options.runDelayMs ?? 900
  const log = options.log ?? (() => {})
  const projects = new Map()
  let order = []
  const views = new Map()
  const commits = []
  const runs = new Map()
  const clients = new Set()
  let seq = 0
  let session = { sessionId: `session-dev-${randomUUID().slice(0, 8)}`, cwd: homedir() }

  const seed = JSON.parse(readFileSync(options.treeFile, 'utf8'))
  for (const entry of seed.projects) {
    const project = { id: entry.root.id, file: entry.file, rev: '', root: clone(entry.root) }
    touch(project)
    projects.set(project.id, project)
    order.push(project.id)
    commits.push({ project: project.id, rev: hash(`${project.id}-seed`), author: 'dsh-mainline', at: Date.now() - 86400000, message: `导入「${project.root.title.slice(0, 24)}」` })
  }

  function hash(text) {
    return createHash('sha1').update(text).digest('hex')
  }

  function touch(project) {
    project.rev = hash(JSON.stringify(project.root)).slice(0, 12)
  }

  function used(project) {
    const ids = new Set()
    walk(project.root, (node) => ids.add(node.id))
    return ids
  }

  function newId(taken) {
    for (let length = 4; ; length += 1) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const id = Math.random().toString(36).slice(2, 2 + Math.min(length, 8))
        if (/^[a-z0-9]{4,8}$/.test(id) && !taken.has(id)) {
          taken.add(id)
          return id
        }
      }
    }
  }

  function where(project, id) {
    const hit = find(project.root, id)
    if (!hit) return ''
    const parts = [project.root.title.slice(0, 24), ...hit.path.slice(1).map((node) => node.title.slice(0, 18)).filter(Boolean)]
    if (hit.node.kind !== 'project') parts.push(hit.node.title.slice(0, 24))
    return parts.join(' › ')
  }

  function publish(partial) {
    seq += 1
    const event = { id: randomUUID(), seq, at: Date.now(), actor: { kind: 'human' }, project: null, node: null, summary: '', data: {}, ...partial }
    const chunk = `event: mainline\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of clients) client.write(chunk)
    return event
  }

  function remember(project, message) {
    commits.push({ project, rev: hash(`${project}-${Date.now()}-${Math.random()}`), author: 'dsh-mainline', at: Date.now(), message })
  }

  function getProject(id) {
    const project = projects.get(id)
    if (!project) fail('not-found', `找不到项目 ${id}`)
    return project
  }

  function insertAt(parent, after, node) {
    const kids = parent.children
    let at = kids.length
    if (after === '') at = 0
    else if (typeof after === 'string') {
      const found = kids.findIndex((child) => child.id === after)
      if (found === -1) fail('not-found', `找不到兄弟节点 ${after}`)
      at = found + 1
    }
    kids.splice(at, 0, node)
  }

  function summary(project) {
    let todo = 0
    let halt = 0
    let steps = 0
    walk(project.root, (node) => {
      if (node.kind !== 'step') return
      steps += 1
      if (node.state === 'todo') todo += 1
      if (node.state === 'halt') halt += 1
    })
    return { id: project.id, file: project.file, title: project.root.title, state: project.root.state, todo, halt, steps }
  }

  function apply(op) {
    const allowed = OP_KEYS[op?.type]
    if (!allowed) fail('invalid-op', `未知操作 ${op?.type}`)
    for (const key of Object.keys(op)) if (key !== 'type' && !allowed.includes(key)) fail('invalid-op', `${op.type} 不接受字段 ${key}`)
    const events = []
    const emit = (partial) => events.push(publish(partial))
    let project = null
    let nodeId = null
    let removed
    switch (op.type) {
      case 'create': {
        project = getProject(op.project)
        const parent = find(project.root, op.parent)
        if (!parent) fail('not-found', `找不到 ${op.parent}`)
        if (!CAN_CONTAIN[parent.node.kind]?.includes(op.kind)) fail('invalid-kind', `${parent.node.kind} 下不能放 ${op.kind}`)
        const node = { id: newId(used(project)), kind: op.kind, title: cleanTitle(op.title), state: op.state ?? '', question: op.question === true, body: op.body ?? '', attrs: op.attrs ?? {}, children: [] }
        insertAt(parent.node, op.after, node)
        nodeId = node.id
        emit({ type: 'node/created', project: project.id, node: node.id, summary: `新增「${where(project, node.id)}」`, data: { kind: node.kind, title: node.title, parent: op.parent, after: op.after ?? null } })
        break
      }
      case 'update': {
        project = getProject(op.project)
        const hit = find(project.root, op.id)
        if (!hit) fail('not-found', `找不到 ${op.id}`)
        const patch = op.patch ?? {}
        const fields = []
        for (const key of ['title', 'state', 'question', 'body', 'attrs']) {
          if (!(key in patch)) continue
          let value = patch[key]
          if (key === 'title') value = cleanTitle(value)
          if (key === 'state' && !['', 'todo', 'halt'].includes(value)) fail('invalid-state', `状态 ${value} 不合法`)
          if (JSON.stringify(hit.node[key]) !== JSON.stringify(value)) {
            hit.node[key] = value
            fields.push(key)
          }
        }
        nodeId = hit.node.id
        if (fields.length) emit({ type: 'node/updated', project: project.id, node: hit.node.id, summary: `修改「${where(project, hit.node.id)}」的 ${fields.join('、')}`, data: { fields } })
        break
      }
      case 'move': {
        project = getProject(op.project)
        const hit = find(project.root, op.id)
        const target = find(project.root, op.parent)
        if (!hit || !target) fail('not-found', '找不到要移动的节点或目标')
        if (hit.node.kind === 'project' || target.path.includes(hit.node) || target.node === hit.node) fail('invalid-move', '不能移到自己里面')
        if (!CAN_CONTAIN[target.node.kind]?.includes(hit.node.kind)) fail('invalid-move', `${target.node.kind} 下不能放 ${hit.node.kind}`)
        hit.parent.children.splice(hit.index, 1)
        insertAt(target.node, op.after, hit.node)
        nodeId = hit.node.id
        emit({ type: 'node/moved', project: project.id, node: hit.node.id, summary: `移动「${where(project, hit.node.id)}」`, data: { fromParent: hit.parent.id, toParent: target.node.id, after: op.after ?? null } })
        break
      }
      case 'remove': {
        project = getProject(op.project)
        const hit = find(project.root, op.id)
        if (!hit || !hit.parent) fail('not-found', `找不到 ${op.id}`)
        const label = where(project, hit.node.id)
        hit.parent.children.splice(hit.index, 1)
        removed = hit.node
        let count = 0
        walk(hit.node, () => (count += 1))
        emit({ type: 'node/removed', project: project.id, node: hit.node.id, summary: `删除「${label}」`, data: { kind: hit.node.kind, title: hit.node.title, count } })
        break
      }
      case 'insert': {
        project = getProject(op.project)
        const target = find(project.root, op.parent)
        if (!target) fail('not-found', `找不到 ${op.parent}`)
        const node = clone(op.node)
        const taken = used(project)
        walk(node, (entry) => {
          if (taken.has(entry.id)) entry.id = newId(taken)
          else taken.add(entry.id)
        })
        insertAt(target.node, op.after, node)
        nodeId = node.id
        emit({ type: 'node/created', project: project.id, node: node.id, summary: `恢复「${where(project, node.id)}」`, data: { kind: node.kind, title: node.title, parent: op.parent, after: op.after ?? null } })
        break
      }
      case 'fork': {
        project = getProject(op.project)
        const hit = find(project.root, op.after)
        if (!hit || !hit.parent) fail('not-found', `找不到 ${op.after}`)
        const names = (op.lanes ?? []).map((name) => cleanTitle(name))
        if (names.length < 2) fail('invalid-op', '至少两条支线')
        const taken = used(project)
        const fork = { id: newId(taken), kind: 'fork', title: op.title ? cleanTitle(op.title) : '', state: '', question: false, body: '', attrs: {}, children: [] }
        fork.children = names.map((title) => ({ id: newId(taken), kind: 'lane', title, state: '', question: false, body: '', attrs: {}, children: [] }))
        hit.parent.children.splice(hit.index + 1, 0, fork)
        nodeId = fork.id
        emit({ type: 'node/created', project: project.id, node: fork.id, summary: `在「${where(project, op.after)}」之后分成 ${names.join(' / ')}`, data: { kind: 'fork', title: fork.title, parent: hit.parent.id, after: op.after } })
        break
      }
      case 'createProject': {
        const title = cleanTitle(op.title)
        const taken = new Set(projects.keys())
        const root = { id: newId(taken), kind: 'project', title, state: '', question: false, body: op.body ?? '', attrs: {}, children: [], preamble: '' }
        project = { id: root.id, file: `${title.replace(/[\\/:*?"<>|#{}\s]+/g, '-').slice(0, 60)}.md`, rev: '', root }
        projects.set(project.id, project)
        order.push(project.id)
        nodeId = project.id
        emit({ type: 'project/created', project: project.id, summary: `新建项目「${title}」`, data: { file: project.file, title } })
        break
      }
      case 'removeProject': {
        const target = getProject(op.project)
        projects.delete(target.id)
        order = order.filter((id) => id !== target.id)
        emit({ type: 'project/removed', project: target.id, summary: `删除项目「${target.root.title}」`, data: { file: target.file, title: target.root.title } })
        break
      }
      case 'renameProject': {
        project = getProject(op.project)
        project.root.title = cleanTitle(op.title)
        nodeId = project.id
        emit({ type: 'node/updated', project: project.id, node: project.id, summary: `项目改名为「${project.root.title}」`, data: { fields: ['title'] } })
        break
      }
      case 'reorderProjects': {
        order = (op.order ?? []).filter((id) => projects.has(id)).concat(order.filter((id) => !(op.order ?? []).includes(id)))
        emit({ type: 'projects/reordered', summary: '调整了项目顺序', data: { order } })
        break
      }
      case 'restore': {
        project = getProject(op.project)
        emit({ type: 'project/restored', project: project.id, summary: `恢复到 ${String(op.rev).slice(0, 7)}（mock：内容不变）`, data: { file: project.file, title: project.root.title, rev: op.rev } })
        break
      }
      default:
        fail('invalid-op', `未知操作 ${op.type}`)
    }
    if (project) touch(project)
    if (events.length) remember(project?.id ?? op.project ?? null, events[0].summary)
    return { project: project && projects.has(project.id) ? project : null, nodeId, removed, events }
  }

  function startRun(ref) {
    const project = getProject(ref.project)
    const hit = find(project.root, ref.node)
    if (!hit) fail('not-found', `找不到节点 ${ref.node}`)
    if (!Number.isInteger(ref.index) || ref.index < 0) fail('invalid-request', 'index 必须是非负整数')
    const fence = extractFences(hit.node.body).find((entry) => entry.index === ref.index)
    if (!fence) fail('not-found', `这张卡上没有第 ${ref.index + 1} 段命令`)
    const key = `${ref.project}/${ref.node}/${ref.index}`
    const existing = runs.get(key)
    if (existing?.status === 'running') return existing
    const chain = [hit.node, ...[...hit.path].reverse()]
    const cwd = chain.find((node) => node.attrs?.cwd)?.attrs.cwd ?? session.cwd
    const record = { runId: randomUUID(), project: ref.project, node: ref.node, index: ref.index, status: 'running', command: fence.code, cwd, startedAt: Date.now(), endedAt: null, exitCode: null, timedOut: false, aborted: false, stdout: '', stderr: '' }
    runs.set(key, record)
    publish({ type: 'run/started', project: ref.project, node: ref.node, summary: `运行第 ${ref.index + 1} 段命令`, data: { runId: record.runId, index: ref.index, command: record.command, cwd } })
    record.timer = setTimeout(() => {
      const result = cannedRun(record.command)
      Object.assign(record, result, { endedAt: Date.now(), status: result.exitCode === 0 ? 'done' : 'failed' })
      delete record.timer
      publish({ type: 'run/finished', project: ref.project, node: ref.node, summary: `命令运行结束（退出码 ${result.exitCode}）`, data: { runId: record.runId, index: ref.index, exitCode: result.exitCode, timedOut: false, aborted: false, tail: result.stdout.slice(-600) } })
    }, runDelayMs)
    return record
  }

  function cancelRun(runId) {
    for (const record of runs.values()) {
      if (record.runId !== runId || record.status !== 'running') continue
      clearTimeout(record.timer)
      delete record.timer
      Object.assign(record, { status: 'failed', aborted: true, endedAt: Date.now() })
      publish({ type: 'run/finished', project: record.project, node: record.node, summary: '命令已取消', data: { runId, index: record.index, exitCode: null, timedOut: false, aborted: true, tail: '' } })
      return true
    }
    return false
  }

  const publicRun = (record) => {
    const { timer, ...rest } = record
    return rest
  }

  function send(response, status, body) {
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(JSON.stringify(body))
  }

  async function body(request) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      fail('invalid-json', `请求体不是合法 JSON：${error.message}`)
    }
  }

  function stream(request, response) {
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('connection', 'keep-alive')
    response.flushHeaders?.()
    response.write('retry: 3000\n\n')
    clients.add(response)
    const ping = setInterval(() => response.write(': ping\n\n'), 25000)
    const close = () => {
      clearInterval(ping)
      clients.delete(response)
    }
    request.on('close', close)
    response.on('close', close)
  }

  const routes = {
    'GET /health': () => ({ version: 'mock', root: '(memory)', git: { available: false }, session, tools: null, projects: projects.size }),
    'GET /projects': () => ({ projects: order.map((id) => summary(projects.get(id))) }),
    'GET /project': (q) => ({ project: getProject(q.get('id')) }),
    'POST /op': async (q, request) => {
      const payload = await body(request)
      const result = apply(payload.op)
      return { project: result.project, nodeId: result.nodeId, ...(result.removed ? { removed: result.removed } : {}), events: result.events }
    },
    'POST /focus': async (q, request) => {
      const payload = await body(request)
      const project = getProject(payload.project)
      publish({ type: 'view/focus', project: project.id, node: payload.node ?? null, summary: `聚焦 ${where(project, payload.node ?? project.id)}`, data: { where: where(project, payload.node ?? project.id) } })
      return {}
    },
    'GET /session': () => session,
    'POST /session/reset': () => {
      session = { ...session, sessionId: `session-dev-${randomUUID().slice(0, 8)}` }
      return { sessionId: session.sessionId }
    },
    'POST /run': async (q, request) => {
      const payload = await body(request)
      return { run: publicRun(startRun(payload)) }
    },
    'POST /run/cancel': async (q, request) => ({ cancelled: cancelRun((await body(request)).runId) }),
    'GET /runs': (q) => ({
      runs: [...runs.values()].filter((record) => (!q.get('project') || record.project === q.get('project')) && (!q.get('node') || record.node === q.get('node'))).map(publicRun),
    }),
    'POST /ask': async (q, request) => {
      const payload = await body(request)
      const project = getProject(payload.project)
      log(`[ask] ${where(project, payload.node)}${Number.isInteger(payload.index) ? ` · 命令 ${payload.index + 1}` : ''}`)
      publish({ type: 'session/asked', project: project.id, node: payload.node, summary: `把「${where(project, payload.node)}」交给了 AI`, data: {} })
      return { sent: true }
    },
    'GET /history': (q) => {
      const project = q.get('project')
      const limit = Number(q.get('limit')) || 50
      return {
        commits: commits
          .filter((entry) => !project || entry.project === project)
          .slice(-limit)
          .reverse()
          .map(({ project: _project, ...entry }) => ({ ...entry, short: entry.rev.slice(0, 7) })),
      }
    },
    'GET /view': (q) => ({ view: views.get(getProject(q.get('project')).id) ?? {} }),
    'POST /view': async (q, request) => {
      const payload = await body(request)
      views.set(getProject(payload.project).id, payload.view ?? {})
      return {}
    },
  }

  /** @returns {Promise<boolean>} whether the request was an API request */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/mainline/')) return false
    const suffix = url.pathname.slice('/api/mainline'.length)
    if (request.method === 'GET' && suffix === '/stream') {
      stream(request, response)
      return true
    }
    const handler = routes[`${request.method} ${suffix}`]
    if (!handler) {
      send(response, Object.keys(routes).some((key) => key.endsWith(` ${suffix}`)) ? 405 : 404, { ok: false, reason: 'not-found', error: `没有这个路由：${request.method} ${suffix}` })
      return true
    }
    try {
      send(response, 200, { ok: true, data: await handler(url.searchParams, request) })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      send(response, STATUS[code] ?? 400, { ok: false, reason: code, error: error?.message ?? String(error) })
    }
    return true
  }

  return { handle, describe: () => `mock (${projects.size} 个项目，内存中)` }
}
