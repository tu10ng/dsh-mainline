#!/usr/bin/env node
/**
 * A local harness for the panel: http://localhost:4710/
 *
 *   node tools/dev-server.mjs            # real host half when it loads, else the mock
 *   node tools/dev-server.mjs --mock     # always tools/mock-api.mjs
 *   node tools/dev-server.mjs --real     # the real host half or nothing (exit 1)
 *   PORT=4711 node tools/dev-server.mjs
 *
 * The page defines `window.__ModuleLoader__`, loads React 18 UMD, gives the panel a fake
 * Host ctx (a slots registry that renders the `main` registration full-page, `locale`,
 * `sessions` / `uiWorkspace` stubs — and no conversation factory, so the fallback shows)
 * and serves `lib/client.js` as is.
 *
 * "Real" mounts `lib/index.js`'s own `apply()` on a fake plugin ctx: the real service,
 * git, events, runner, session and routes, rooted at a temp copy of `fixtures/*.md`. The
 * Host services it needs are fakes: `shell` answers canned output (nothing is executed),
 * `sessionController` / `agents` hand out an in-memory agent that logs what it is told.
 *
 * Start states for screenshots come from the URL hash (or query):
 *   #project=hl01&select=r2q03&open=r2q03&fold=overview|contents|all&folded=r2lmq
 *   &all=<id>&menu=1|canvas|<id>&run=0&edit=<id>&fork=1&refs=1&cut=<id>&offset=<id>:dx:dy
 *   &theme=dark&lang=en&keep=1   (keep=1: use the stored view instead of starting from the defaults)
 *
 * @module dsh-mainline/tools/dev-server
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { cannedRun, createMockApi } from './mock-api.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 4710)
/**
 * React 18 UMD: REACT_UMD / REACT_DOM_UMD, else the deepseek-harness checkout next to this
 * repository (DSH_HARNESS overrides where that is), else a react@18 in node_modules.
 */
function locate(envName, pnpmPath, packagePath) {
  if (process.env[envName]) return process.env[envName]
  const harness = process.env.DSH_HARNESS ?? path.resolve(repo, '..', 'deepseek-harness')
  const candidates = [path.join(harness, 'node_modules', '.pnpm', pnpmPath), path.join(repo, 'node_modules', packagePath)]
  return candidates.find((file) => existsSync(file)) ?? candidates[0]
}
const REACT_UMD = locate('REACT_UMD', 'react@18.3.1/node_modules/react/umd/react.development.js', 'react/umd/react.development.js')
const REACT_DOM_UMD = locate(
  'REACT_DOM_UMD',
  'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.development.js',
  'react-dom/umd/react-dom.development.js',
)
const MODE = process.argv.includes('--mock') ? 'mock' : process.argv.includes('--real') ? 'real' : 'auto'
const RUN_DELAY_MS = Number(process.env.RUN_DELAY_MS ?? 900)

const log = (line) => console.log(`[dev] ${line}`)

// ------------------------------------------------------------------ fake Host services

function fakeShell() {
  return {
    resolve: (spec) => ({ ...spec }),
    async execute(spec) {
      let settle
      const done = new Promise((resolve) => (settle = resolve))
      const timer = setTimeout(() => {
        const result = cannedRun(spec.command)
        settle({ exitCode: result.exitCode, signal: null, timedOut: false, aborted: false, stdout: { text: result.stdout, truncated: false }, stderr: { text: result.stderr, truncated: false } })
      }, RUN_DELAY_MS)
      log(`[shell] (fake) ${spec.workdir ?? ''} $ ${String(spec.command).split('\n')[0]}`)
      return {
        result: () => done,
        kill() {
          clearTimeout(timer)
          settle({ exitCode: null, signal: 'SIGTERM', timedOut: false, aborted: true, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })
        },
      }
    },
  }
}

function fakeSessions() {
  const agents = new Map()
  const make = (id) => ({
    id,
    status: 'idle',
    inbox: { replace: () => false },
    inject(message) {
      log(`[session ${id}] notice: ${String(message?.content?.[0]?.text ?? '').split('\n').slice(0, 3).join(' | ')}`)
    },
    async followup(message) {
      log(`[session ${id}] turn: ${String(message?.content?.[0]?.text ?? '').split('\n')[0]}`)
    },
  })
  return {
    agents: { get: (id) => agents.get(id) },
    sessionController: {
      async create() {
        const sessionId = `session-dev-${randomUUID().slice(0, 8)}`
        agents.set(sessionId, make(sessionId))
        return { sessionId }
      },
      async resolveAgent(id) {
        const agent = agents.get(id)
        return agent ? { agent } : undefined
      },
    },
  }
}

/** The plugin ctx `lib/index.js` expects, with the routes it registers collected. */
function fakePluginCtx(routes) {
  const sessions = fakeSessions()
  const services = { shell: fakeShell(), sessionController: sessions.sessionController, agents: sessions.agents }
  const listeners = new Map()
  const logger = { info: (m) => log(m), warn: (m) => log(`WARN ${m}`), debug() {}, error: (m) => log(`ERROR ${m}`) }
  const base = {
    logger,
    effect(fn, label) {
      try {
        fn()
      } catch (error) {
        log(`effect ${label} failed: ${error?.message ?? error}`)
      }
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
    get: (name) => services[name],
    root: { get: (name) => services[name] },
  }
  base.inject = (names, callback) => {
    callback({
      ...base,
      tools: { register: () => () => {} },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      systemPrompt: { context: () => () => {}, section: () => () => {} },
    })
  }
  return base
}

async function mountReal() {
  const entry = path.join(repo, 'lib', 'index.js')
  const needed = ['index.js', 'routes.js', 'service.js', 'events.js'].map((name) => path.join(repo, 'lib', name))
  if (!needed.every((file) => existsSync(file))) return null
  const root = await mkdtemp(path.join(os.tmpdir(), 'mainline-dev-'))
  const fixtures = path.join(repo, 'fixtures')
  const files = (await readdir(fixtures)).filter((file) => file.endsWith('.md'))
  for (const name of files) await copyFile(path.join(fixtures, name), path.join(root, name))
  await mkdir(path.join(root, '.mainline'), { recursive: true })
  // The prototype's tab order; files not listed are appended by the store.
  const order = ['homelab.md', 'blog.md', 'backup.md', 'printer.md', 'cleanup.md', 'router.md'].filter((name) => files.includes(name))
  await writeFile(path.join(root, 'mainline.json'), `${JSON.stringify({ version: 1, order }, null, 2)}\n`)
  const routes = []
  const plugin = await import(pathToFileURL(entry).href)
  plugin.apply(fakePluginCtx(routes), { root, sessionCwd: os.homedir(), commitDelayMs: 1500, guidance: true })
  if (routes.length === 0) throw new Error('lib/index.js registered no routes')
  const byPath = new Map(routes.map((route) => [route.path, route]))
  return {
    describe: () => `real host half (${routes.length} routes, root ${root})`,
    async handle(request, response) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/api/mainline/')) return false
      const route = byPath.get(url.pathname)
      if (!route) {
        response.statusCode = 404
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ ok: false, reason: 'not-found', error: `没有这个路由：${url.pathname}` }))
        return true
      }
      await route.handler(request, response)
      return true
    },
  }
}

async function chooseApi() {
  const mock = () => createMockApi({ treeFile: path.join(repo, 'tools', 'mock-tree.json'), runDelayMs: RUN_DELAY_MS, log })
  if (MODE === 'mock') return mock()
  try {
    const real = await mountReal()
    if (real) return real
    if (MODE === 'real') throw new Error('the host half is not complete yet (lib/index.js, routes.js, service.js, events.js)')
  } catch (error) {
    if (MODE === 'real') throw error
    log(`real routes unavailable, using the mock: ${error?.stack ?? error}`)
  }
  return mock()
}

// ------------------------------------------------------------------ the page

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-mainline · dev</title>
<style>
/* The Host's own token values (packages/client/ui-theme design-platform.css). */
body {
  --dsw-alias-label-primary: rgb(15, 17, 21);
  --dsw-alias-label-secondary: rgb(97, 102, 107);
  --dsw-alias-bg-base: rgb(255, 255, 255);
  --dsw-alias-bg-layer-1: rgb(255, 255, 255);
  --dsw-alias-bg-layer-2: rgb(255, 255, 255);
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  --dsw-alias-state-error-primary: rgb(236, 19, 19);
}
body[data-ds-dark-theme] {
  --dsw-alias-label-primary: rgb(249, 250, 251);
  --dsw-alias-label-secondary: rgb(207, 211, 214);
  --dsw-alias-bg-base: rgb(21, 21, 23);
  --dsw-alias-bg-layer-1: rgb(35, 35, 36);
  --dsw-alias-bg-layer-2: rgb(44, 44, 46);
  --dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
  --dsw-alias-state-error-primary: rgb(242, 90, 90);
}
html, body { height: 100%; margin: 0; }
body { display: flex; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: 13px/1.5 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
#rail { flex: 0 0 48px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding-top: 10px;
  border-right: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
#rail .entry { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
#rail .label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
#root { flex: 1 1 auto; min-width: 0; height: 100%; }
#dev-toast { position: fixed; left: 60px; bottom: 34px; padding: 4px 10px; border-radius: 6px; font: 12px ui-monospace, Consolas, monospace;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); opacity: 0; transition: opacity .2s; pointer-events: none; }
</style>
<script src="vendor/react.js"></script>
<script src="vendor/react-dom.js"></script>
</head>
<body>
<nav id="rail"><div class="entry" id="rail-entry" title="sidebar.panellist"></div><div class="label" id="rail-label"></div></nav>
<div id="root"></div>
<div id="dev-toast"></div>
<script>
(function () {
  var search = new URLSearchParams(location.search)
  var hash = new URLSearchParams(location.hash.replace(/^#/, ''))
  var get = function (key) { return hash.has(key) ? hash.get(key) : search.get(key) }
  if (get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  var lang = get('lang') === 'en' ? 'en-US' : 'zh-CN'
  document.documentElement.lang = lang
  var dev = {}
  ;['project', 'select', 'fold', 'open', 'all', 'folded', 'menu', 'run', 'edit', 'fork', 'refs', 'cut', 'offset', 'keep'].forEach(function (key) {
    if (get(key) !== null) dev[key] = get(key)
  })
  window.__mainlineDev = dev
  try { localStorage.removeItem('dsh-mainline:open-project') } catch (e) {}
  function toast(text) {
    var el = document.getElementById('dev-toast')
    el.textContent = text
    el.style.opacity = '1'
    clearTimeout(toast.timer)
    toast.timer = setTimeout(function () { el.style.opacity = '0' }, 1800)
  }
  window.__ModuleLoader__ = {
    load: function (mod) {
      var plugin = mod.factory(function (name) {
        if (name === 'react') return window.React
        throw new Error('dev harness: unknown module ' + name)
      })
      var registrations = []
      var ctx = {
        effect: function (fn, label) { try { fn() } catch (error) { console.error('effect failed', label, error) } },
        locale: {
          register: function () { return function () {} },
          getLocale: function () { return { active: lang, locales: ['zh-CN', 'en-US'], revision: 1 } },
          subscribe: function () { return function () {} },
        },
        slots: {
          inject: function (name, fn) { return fn() },
          register: function (spec, Component) { registrations.push({ spec: spec, Component: Component }); return function () {} },
        },
        sessions: { retain: function (id) { return { id: id, release: function () {} } } },
        uiWorkspace: { openSession: function (id) { toast('uiWorkspace.openSession(' + id + ')') } },
      }
      plugin.apply(ctx)
      window.__mainlinePlugin = plugin
      var main = registrations.find(function (r) { return r.spec.name === 'main' })
      var entry = registrations.find(function (r) { return r.spec.name === 'sidebar.panellist' })
      if (entry) {
        ReactDOM.createRoot(document.getElementById('rail-entry')).render(React.createElement(entry.Component, { size: 18 }))
        document.getElementById('rail-label').textContent = typeof entry.spec.label === 'function' ? entry.spec.label() : ''
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(main.Component, {}))
    },
  }
})()
</script>
<script src="lib/client.js"></script>
</body>
</html>
`

async function serveFile(response, file, type) {
  try {
    const body = await readFile(file)
    response.statusCode = 200
    response.setHeader('content-type', type)
    response.setHeader('cache-control', 'no-store')
    response.end(body)
  } catch (error) {
    response.statusCode = 404
    response.end(`missing ${file}: ${error.message}`)
  }
}

const api = await chooseApi()
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (await api.handle(request, response)) return
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(PAGE)
      return
    }
    if (url.pathname === '/lib/client.js') return await serveFile(response, path.join(repo, 'lib', 'client.js'), 'text/javascript; charset=utf-8')
    if (url.pathname === '/vendor/react.js') return await serveFile(response, REACT_UMD, 'text/javascript; charset=utf-8')
    if (url.pathname === '/vendor/react-dom.js') return await serveFile(response, REACT_DOM_UMD, 'text/javascript; charset=utf-8')
    response.statusCode = 404
    response.end('not found')
  } catch (error) {
    log(`request failed: ${error?.stack ?? error}`)
    if (!response.headersSent) response.statusCode = 500
    response.end()
  }
})
server.listen(PORT, '127.0.0.1', () => {
  log(`API: ${api.describe()}`)
  log(`open http://localhost:${PORT}/`)
})
