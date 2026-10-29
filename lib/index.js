/**
 * dsh-mainline — host half.
 *
 * Wires the tree (events → git → service), the one shared DSH conversation, the
 * command runner, the agent tools, the HTTP routes and the prompt pieces. Each Host
 * surface is reached through `ctx.inject` in its own effect, so a missing optional
 * service costs that surface and nothing else.
 *
 * @module dsh-mainline
 */

import { homedir } from 'node:os'
import path from 'node:path'

import { createEvents } from './events.js'
import { createGit } from './git.js'
import { ROUTE_BASE, createRoutes } from './routes.js'
import { createRunner } from './runner.js'
import { createService } from './service.js'
import { createSession } from './session.js'
import { createTools } from './tools.js'

/** Must equal `package.json`'s version; `npm run check` enforces that. */
export const VERSION = '0.1.0'

/** Plugin id; also the Loader row id in `cordis.patch.yml`. */
export const name = 'dsh-mainline'

/** Applied when the patch row gives no `config`. */
export const DEFAULTS = Object.freeze({ root: '', sessionCwd: '', commitDelayMs: 4000, guidance: true })

/** @param {unknown} dispose a disposer-ish value */
function safely(dispose) {
  return () => {
    try {
      dispose?.()
    } catch {
      /* unloading must not throw */
    }
  }
}

/** @param {object} resolved */
function resolveRoot(resolved) {
  if (typeof resolved.root === 'string' && resolved.root.trim() !== '') return path.resolve(resolved.root.trim())
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'mainline')
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Cordis context
 * @param {object} [config] - the patch row's `config`
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  const logger = ctx?.logger
  const root = resolveRoot(resolved)
  const local = path.join(root, '.mainline')

  const events = createEvents({
    file: path.join(local, 'events.jsonl'),
    logger,
    emit: (eventName, event) => ctx.emit?.(eventName, event),
    now: Date.now,
  })
  const git = createGit({ root, logger, events, commitDelayMs: resolved.commitDelayMs })
  const service = createService({ root, logger, events, git, now: Date.now })

  // Handlers wait on this instead of racing the first load.
  let readyPromise = Promise.resolve()
  const whenReady = () => readyPromise
  ctx.effect(() => {
    readyPromise = Promise.resolve()
      .then(() => service.ready())
      .catch((error) => {
        logger?.warn?.(`dsh-mainline: 初始化失败：${error?.message ?? error}`)
        throw error
      })
    readyPromise.catch(() => {})
    return () => {
      void Promise.resolve()
        .then(() => service.close())
        .catch(() => {})
    }
  }, 'dsh-mainline: service')

  const session = createSession({
    ctx,
    service,
    events,
    logger,
    file: path.join(local, 'session.json'),
    cwd: resolved.sessionCwd || homedir(),
    now: Date.now,
  })
  const runner = createRunner({ ctx, service, session, events, logger, cwd: () => session.cwd() })

  ctx.effect(() => {
    void session.load().catch(() => {})
    const detach = session.attach()
    let stop = () => {}
    try {
      const dispose = ctx.on?.('agent/status', (payload) => session.handleStatus(payload))
      stop = safely(dispose)
    } catch (error) {
      logger?.warn?.(`dsh-mainline: 无法监听 agent/status：${error?.message ?? error}`)
    }
    return () => {
      stop()
      detach()
      runner.dispose()
    }
  }, 'dsh-mainline: session events')

  const toolState = { registered: [], error: null }
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      try {
        // A tool call can arrive before the first load finishes; make it wait.
        const definitions = createTools({ service, runner, session }).map((definition) => ({
          ...definition,
          async execute(args, exec) {
            await whenReady()
            return definition.execute(args, exec)
          },
        }))
        const disposers = definitions.map((definition) => toolCtx.tools.register(definition))
        toolState.registered = definitions.map((definition) => definition.name)
        toolState.error = null
        toolCtx.logger?.info?.(`dsh-mainline: 注册了 ${definitions.length} 个 Agent 工具`)
        return safely(() => disposers.forEach((dispose) => safely(dispose)()))
      } catch (error) {
        toolState.error = String(error?.message ?? error)
        toolCtx.logger?.warn?.(`dsh-mainline: 工具注册失败：${toolState.error}`)
        return () => {}
      }
    }, 'dsh-mainline: agent tools')
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      try {
        const routes = createRoutes({
          service,
          events,
          session,
          runner,
          logger,
          // A context, not a value: the connection fence can register after this plugin.
          rootCtx: ctx,
          connection: ctx.get?.('connection'),
          version: VERSION,
          whenReady,
          health: () => ({ git: { available: git.available ?? null }, tools: { ...toolState } }),
        })
        const disposers = routes.map((definition) => webCtx.webServer.register(definition))
        webCtx.logger?.info?.(`dsh-mainline: 注册了 ${disposers.length} 条路由（${ROUTE_BASE}）`)
        return safely(() => disposers.forEach((dispose) => safely(dispose)()))
      } catch (error) {
        webCtx.logger?.warn?.(`dsh-mainline: 路由注册失败：${error?.message ?? error}`)
        return () => {}
      }
    }, 'dsh-mainline: web routes')
  })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => {
      try {
        return session.registerPrompt(promptCtx.systemPrompt, { guidance: resolved.guidance !== false })
      } catch (error) {
        promptCtx.logger?.warn?.(`dsh-mainline: 提示词注册失败：${error?.message ?? error}`)
        return () => {}
      }
    }, 'dsh-mainline: prompt')
  })

  logger?.info?.(`dsh-mainline v${VERSION} 已挂载（root=${root}）`)
}

export default { name, apply }
