/**
 * The real `lib/index.js` mounted on a fake ctx, with a real directory and real git behind it:
 * the routes and the tools both reach the same files, and the files and the git log say so.
 */

import { strict as assert } from 'node:assert'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'

import { apply } from '../lib/index.js'
import { ROUTE_BASE } from '../lib/routes.js'
import { FIXTURES, cleanup, gitOut, makeRoot, sleep, until } from './helpers/env.mjs'

after(cleanup)

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
      return JSON.parse(this.body)
    },
  }
}

function makeReq(method, suffix, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: `${ROUTE_BASE}${suffix}`,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

/** Mount the plugin the way the Host does, against a ctx that records what it was given. */
function mount(config) {
  const tools = []
  const routes = []
  const disposers = []
  const emitted = []
  const quiet = { warn() {}, info() {}, debug() {} }
  const base = {
    logger: quiet,
    root: { get: () => undefined },
    get: () => undefined,
    emit: (name, event) => emitted.push([name, event]),
    on: () => () => {},
    effect(fn) {
      disposers.push(fn())
    },
  }
  const ctx = {
    ...base,
    inject(_names, callback) {
      callback({
        ...base,
        tools: { register: (definition) => (tools.push(definition), () => {}) },
        webServer: { register: (definition) => (routes.push(definition), () => {}) },
        systemPrompt: { section: () => () => {}, context: () => () => {} },
      })
    },
  }
  apply(ctx, config)
  return {
    tools,
    routes,
    emitted,
    async close() {
      for (const dispose of disposers) await dispose?.()
    },
    async call(method, suffix, body) {
      const route = routes.find((r) => r.path === `${ROUTE_BASE}${suffix.split('?')[0]}`)
      assert.ok(route, `no route ${suffix}`)
      const res = makeRes()
      await route.handler(makeReq(method, suffix, body), res)
      return res
    },
    async data(method, suffix, body) {
      const res = await this.call(method, suffix, body)
      const reply = res.json()
      assert.equal(res.statusCode, 200, JSON.stringify(reply))
      return reply.data
    },
    tool: (name) => tools.find((t) => t.name === name),
  }
}

let root
let host
let stream
const agent = { agent: { id: 'agent-session-1' } }
const sse = () => stream.chunks.filter((c) => c.startsWith('event: mainline')).map((c) => JSON.parse(c.split('data: ')[1]))
const text = (name, args) => host.tool(name).execute(args, agent)
const headHas = (needle) => {
  try {
    return gitOut(root, 'show', 'HEAD:homelab.md').includes(needle)
  } catch {
    return false
  }
}

before(async () => {
  root = makeRoot()
  for (const name of ['homelab.md', 'blog.md']) copyFileSync(path.join(FIXTURES, name), path.join(root, name))
  host = mount({ root, commitDelayMs: 25 })
  stream = makeRes()
  await host.routes.find((r) => r.path === `${ROUTE_BASE}/stream`).handler(makeReq('GET', '/stream'), stream)
})

after(async () => {
  stream?.listeners.close?.()
  await host?.close()
})

test('the plugin registers eleven tools and the routes, and /health reports git and the projects', async () => {
  assert.equal(host.tools.length, 11)
  const health = await host.data('GET', '/health')
  assert.equal(health.git.available, true)
  assert.equal(health.projects, 2)
  assert.equal(health.root, root)
  assert.equal(health.tools.registered.length, 11)
})

test('/projects lists the seeded files in order; /project returns the full tree', async () => {
  const { projects } = await host.data('GET', '/projects')
  assert.deepEqual(projects.map((p) => p.file), ['blog.md', 'homelab.md'])
  const homelab = projects.find((p) => p.id === 'hl01')
  assert.ok(homelab.steps > 0)
  const { project } = await host.data('GET', '/project?id=hl01')
  assert.equal(project.root.id, 'hl01')
  assert.equal(project.file, 'homelab.md')
  assert.equal(JSON.stringify(project).includes('\\r'), false)
  const missing = await host.call('GET', '/project?id=nope')
  assert.equal(missing.statusCode, 404)
})

test('/op create, update, move, remove, insert and fork reach the file, the stream and the cache', async () => {
  const op = (body) => host.data('POST', '/op', { op: body })
  const before = sse().length
  const created = await op({ type: 'create', project: 'hl01', parent: 'hl01', kind: 'step', title: '面板加的步骤', state: 'todo', body: '正文 `code`' })
  assert.equal(created.project.root.children.at(-1).id, created.nodeId)
  assert.match(readFileSync(path.join(root, 'homelab.md'), 'utf8'), new RegExp(`## TODO 面板加的步骤 \\{#${created.nodeId}\\}`))

  const second = await op({ type: 'create', project: 'hl01', parent: 'hl01', after: created.nodeId, kind: 'step', title: '第二步' })
  await op({ type: 'update', project: 'hl01', id: second.nodeId, patch: { title: '第二步（改）', question: true } })
  await op({ type: 'move', project: 'hl01', id: second.nodeId, parent: 'hl01', after: '' })
  const { project } = await host.data('GET', '/project?id=hl01')
  assert.equal(project.root.children[0].id, second.nodeId)
  assert.equal(project.root.children[0].title, '第二步（改）')
  assert.equal(project.root.children[0].question, true)

  const forked = await op({ type: 'fork', project: 'hl01', after: created.nodeId, title: '两个环境', lanes: ['甲', '乙'] })
  const fork = forked.project.root.children.find((c) => c.id === forked.nodeId)
  assert.deepEqual(fork.children.map((l) => l.title), ['甲', '乙'])

  const removed = await op({ type: 'remove', project: 'hl01', id: forked.nodeId })
  assert.equal(removed.removed.id, forked.nodeId)
  assert.equal(removed.project.root.children.some((c) => c.id === forked.nodeId), false)
  const back = await op({ type: 'insert', project: 'hl01', parent: 'hl01', after: created.nodeId, node: removed.removed })
  assert.equal(back.nodeId, forked.nodeId)

  const bad = await host.call('POST', '/op', { op: { type: 'create', project: 'hl01', parent: 'hl01', kind: 'lane', title: 'x' } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().reason, 'invalid-kind')
  const unknownKey = await host.call('POST', '/op', { op: { type: 'remove', project: 'hl01', id: 'x', extra: 1 } })
  assert.equal(unknownKey.json().reason, 'invalid-op')

  const types = sse().slice(before).map((e) => e.type)
  assert.deepEqual(types, ['node/created', 'node/created', 'node/updated', 'node/moved', 'node/created', 'node/removed', 'node/created'])
  assert.ok(host.emitted.some(([name]) => name === 'mainline/node/moved'), 'the Host bus hears them too')
  assert.ok(sse().slice(before).every((e) => e.actor.kind === 'human' && e.project === 'hl01' && e.summary))
})

test('/focus is announced on the stream and writes nothing', async () => {
  const before = sse().length
  const file = readFileSync(path.join(root, 'homelab.md'), 'utf8')
  await host.data('POST', '/focus', { project: 'hl01', node: 'hl01' })
  const event = sse().slice(before).find((e) => e.type === 'view/focus')
  assert.ok(event)
  assert.equal(event.project, 'hl01')
  assert.equal(readFileSync(path.join(root, 'homelab.md'), 'utf8'), file)
  const view = await host.data('POST', '/view', { project: 'hl01', view: { camera: { x: 3 } } })
  assert.deepEqual(view, {})
  assert.deepEqual((await host.data('GET', '/view?project=hl01')).view, { camera: { x: 3 } })
})

test('the agent tools read, add and write through the same service', async () => {
  // let the panel's commit land first: a batch that mixes people and the model is not the model's
  // (the panel's batch also holds the startup note, so its message is not the thing to look for: the content is)
  await until(() => headHas('面板加的步骤'), { timeout: 60_000, step: 500 })
  const unknown = await text('mainline_read', { project: 'No Such Title' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'not-found')
  const listed = await text('mainline_projects', {})
  assert.equal(listed.ok, true)
  const fileRef = await text('mainline_read', { project: 'homelab' })
  assert.equal(fileRef.ok, true)
  assert.match(fileRef.markdown, /^# .*\{#hl01/)

  const before = sse().length
  const added = await text('mainline_add', { project: 'hl01', kind: 'step', title: '模型加的步骤', body: '来自工具' })
  assert.equal(added.ok, true, JSON.stringify(added))
  assert.match(added.where, /模型加的步骤/)

  const subtree = await text('mainline_read', { project: 'hl01', node: added.id })
  assert.match(subtree.markdown, new RegExp(`^# 模型加的步骤 \\{#${added.id}\\}`))
  const rewritten = await text('mainline_write', { project: 'hl01', node: added.id, markdown: subtree.markdown.replace('来自工具', '工具改写后的正文\n\n## 子步骤\n') })
  assert.equal(rewritten.ok, true)
  const { project } = await host.data('GET', '/project?id=hl01')
  const node = project.root.children.find((c) => c.id === added.id)
  assert.equal(node.body, '工具改写后的正文')
  assert.deepEqual(node.children.map((c) => c.title), ['子步骤'])

  const actors = sse().slice(before).map((e) => e.actor)
  assert.ok(actors.length >= 2)
  assert.ok(actors.every((a) => a.kind === 'agent' && a.session === 'agent-session-1'))

  const bad = await text('mainline_add', { project: 'hl01', parent: 'zzzz', kind: 'step', title: 'x' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'not-found')
})

test('a tool write right after an editor save (before the watcher has looked) keeps the editor change', async () => {
  const file = path.join(root, 'blog.md')
  const before = readFileSync(file, 'utf8')
  writeFileSync(file, `${before.replace(/\n+$/, '')}\n\n## 编辑器里手写的 {#hand1}\n`)
  const added = await text('mainline_add', { project: 'blog', kind: 'step', title: '随后到的' })
  assert.equal(added.ok, true)
  const finalText = readFileSync(file, 'utf8')
  assert.ok(finalText.includes('{#hand1}'), 'the cache was stale, the disk was not')
  assert.ok(finalText.includes('随后到的'))
})

test('history, the git log and the files agree; agent commits are authored DSH Agent', async () => {
  const { commits } = await until(async () => {
    const data = await host.data('GET', '/history?project=hl01&limit=20')
    return data.commits.some((c) => c.author === 'DSH Agent' && /模型加的步骤/.test(c.message)) ? data : null
  }, { timeout: 60_000, step: 500 })
  assert.ok(commits.length >= 3)
  assert.ok(commits.every((c) => /^[0-9a-f]{40}$/.test(c.rev) && typeof c.message === 'string'))
  const log = gitOut(root, 'log', '--format=%an|%s', '--', 'homelab.md').split('\n')
  assert.ok(log.some((line) => line.startsWith('DSH Agent|') && /模型加的步骤/.test(line)))
  assert.ok(log.some((line) => !line.startsWith('DSH Agent|')), 'panel ops keep the person')
  assert.equal(gitOut(root, 'show', 'HEAD:homelab.md').includes('{#hl01'), true)
  assert.equal((await host.data('GET', '/history?limit=5')).commits.length > 0, true)
})

test('plugin unload flushes pending work into git', async () => {
  await host.data('POST', '/op', { op: { type: 'createProject', title: '最后一个' } })
  await host.close()
  // the Host does not wait for a disposer, so neither does the plugin: the flush finishes just after
  const clean = () => gitOut(root, 'status', '--porcelain', '--', ':(glob)*.md', 'mainline.json') === ''
  await until(() => clean() && gitOut(root, 'ls-files', '最后一个.md') === '最后一个.md', { timeout: 60_000, step: 500 })
  assert.equal(gitOut(root, 'show', 'HEAD:最后一个.md').startsWith('# 最后一个 {#'), true)
})
