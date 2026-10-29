/**
 * The one ordinary DSH conversation that shares the tree with the panel.
 *
 * It is a normal Host session created the way "new conversation" creates one, so
 * every plugin, tool, approval and model picker works in it, and it outlives a
 * plugin reload (the Host owns it; we only remember its id).
 *
 * The panel's clicks reach the model as *notices that never wake it*: events pile
 * up in one inbox message that is rewritten in place until the model claims it,
 * and are injected only while the agent is idle — injecting into a running turn
 * costs it an extra step for something it did not ask about.
 *
 * @module dsh-mainline/session
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { atomicWrite } from './atomic.js'
import { TreeError } from './errors.js'
import { BATCH_CAP, GUIDANCE_FULL, GUIDANCE_SHORT, renderEventBatch, renderFocus } from './prompt.js'

/** The `source.kind` of every message this plugin puts into a session. */
export const NOTICE_SOURCE = 'plugin:dsh-mainline'

const WORKSPACE_TITLE = '工作树'
/** Event types the model never needs to hear about. */
const SKIPPED = new Set(['git/committed', 'session/asked'])

/** @param {string} text @param {number} max */
function clipSummary(text, max = 120) {
  const chars = [...String(text)]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** @param {string} text @param {string} summary */
function noticeMessage(text, summary, id = randomUUID()) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_SOURCE, form: 'notice', summary: clipSummary(summary) },
  }
}

/** @param {string} a @param {string} b */
function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '')
  const x = norm(a)
  const y = norm(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * @param {object} options
 * @param {object} options.ctx - plugin context (`ctx.root` reaches Host services)
 * @param {object} options.service - the tree service (`root`, `getProject`, `locate`, `where`, `listProjects`)
 * @param {{ subscribe: Function }} options.events
 * @param {object} [options.logger]
 * @param {string} options.file - `.mainline/session.json`
 * @param {string | (() => string)} [options.cwd] - `sessionCwd`; empty means the home directory
 * @param {() => number} [options.now]
 */
export function createSession(options) {
  const { ctx, service, events, logger, file } = options
  const now = options.now ?? Date.now

  const hostRoot = () => ctx?.root ?? ctx
  const host = (name) => {
    try {
      return hostRoot()?.get?.(name) ?? undefined
    } catch {
      return undefined
    }
  }

  /** Never the tree root itself: a file tool aimed at the project files would bypass the lock. */
  function cwd() {
    const wanted = typeof options.cwd === 'function' ? options.cwd() : options.cwd
    const candidate = typeof wanted === 'string' && wanted.trim() !== '' ? wanted.trim() : homedir()
    return service?.root && samePath(candidate, service.root) ? homedir() : candidate
  }

  let sessionId = null
  let loaded = false
  let focus = null
  let inflight = null
  /** The batch not yet fully delivered: `sent` lines are already in the inbox message. */
  let pending = { lines: [], dropped: 0, messageId: null, sent: 0 }

  async function loadId() {
    if (loaded) return sessionId
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (typeof parsed?.sessionId === 'string' && parsed.sessionId !== '') sessionId = parsed.sessionId
    } catch {
      /* no file yet, or unreadable: start fresh */
    }
    return sessionId
  }

  async function saveId(id) {
    await mkdir(path.dirname(file), { recursive: true })
    await atomicWrite(file, `${JSON.stringify({ sessionId: id }, null, 2)}\n`)
  }

  function liveAgent(id) {
    try {
      return host('agents')?.get?.(id) ?? undefined
    } catch {
      return undefined
    }
  }

  /** The live agent, resuming a persisted session when it is not loaded. */
  async function resolveAgent(id) {
    const live = liveAgent(id)
    if (live) return live
    try {
      const resolved = await host('sessionController')?.resolveAgent?.(id)
      return resolved?.agent ?? undefined
    } catch (error) {
      logger?.debug?.(`dsh-mainline: 恢复会话失败：${error?.message ?? error}`)
      return undefined
    }
  }

  async function create() {
    const sc = host('sessionController')
    if (!sc?.create) throw new TreeError('session-unavailable', '宿主没有提供会话服务，无法创建工作树会话')
    const dir = cwd()
    let created
    try {
      const registry = host('workspaceRegistry')
      if (registry) {
        const workspace = (await registry.resolveByPath?.(dir)) ?? (await registry.create?.(dir, WORKSPACE_TITLE))
        if (workspace?.id) created = await sc.create({ workspaceId: workspace.id })
      }
    } catch (error) {
      logger?.warn?.(`dsh-mainline: 按工作区创建会话失败，改用目录：${error?.message ?? error}`)
      created = undefined
    }
    if (!created?.sessionId) {
      try {
        created = await sc.create({ cwd: dir })
      } catch (error) {
        throw new TreeError('session-unavailable', `创建会话失败：${error?.message ?? error}`)
      }
    }
    if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
      throw new TreeError('session-unavailable', '宿主没有返回会话编号')
    }
    return created.sessionId
  }

  /**
   * The session id, reusing the remembered one while it still resolves.
   *
   * @returns {Promise<string>}
   */
  function ensure() {
    if (inflight) return inflight
    inflight = (async () => {
      const known = await loadId()
      if (known && (await resolveAgent(known))) return known
      if (!host('sessionController') && !known) {
        throw new TreeError('session-unavailable', '宿主没有提供会话服务')
      }
      const created = await create()
      sessionId = created
      pending = { lines: [], dropped: 0, messageId: null, sent: 0 }
      await saveId(created)
      return created
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** Forget the id; the old conversation stays in the sidebar as what it was. */
  async function reset() {
    await loadId()
    sessionId = null
    pending = { lines: [], dropped: 0, messageId: null, sent: 0 }
    await saveId(null).catch((error) => logger?.warn?.(`dsh-mainline: 写 session.json 失败：${error?.message ?? error}`))
  }

  /** Write the pending batch into the agent's inbox, if (and only if) that is cheap. */
  function flush() {
    try {
      if (!sessionId || pending.lines.length === 0) return false
      const agent = liveAgent(sessionId)
      // Not loaded, or mid-turn: hold. The idle status event comes back here.
      if (!agent || agent.status !== 'idle') return false

      if (pending.messageId) {
        const text = renderEventBatch(pending.lines, { dropped: pending.dropped })
        const next = noticeMessage(text, `工作树：${pending.lines.length} 项操作`, pending.messageId)
        if (agent.inbox?.replace?.(pending.messageId, next)) {
          pending.sent = pending.lines.length
          return true
        }
      }
      if (pending.messageId) {
        // Claimed: everything up to `sent` was delivered with that turn.
        pending = { lines: pending.lines.slice(pending.sent), dropped: 0, messageId: null, sent: 0 }
        if (pending.lines.length === 0) return false
      }
      const id = randomUUID()
      const text = renderEventBatch(pending.lines, { dropped: pending.dropped })
      agent.inject(noticeMessage(text, `工作树：${pending.lines.length} 项操作`, id))
      pending.messageId = id
      pending.sent = pending.lines.length
      return true
    } catch (error) {
      logger?.warn?.(`dsh-mainline: 投递面板操作失败：${error?.message ?? error}`)
      return false
    }
  }

  function drop(index) {
    pending.lines.splice(index, 1)
    if (index < pending.sent) pending.sent -= 1
  }

  /** @param {object} event */
  function onEvent(event) {
    try {
      if (!event || typeof event.type !== 'string') return
      if (event.type === 'view/focus') {
        focus = { project: event.project ?? null, node: event.node ?? null }
      }
      if (!sessionId) return
      if (SKIPPED.has(event.type)) return
      if (event.type.startsWith('view/') && event.type !== 'view/focus') return
      // The model already knows what its own tools did.
      if (event.actor?.session && event.actor.session === sessionId) return

      if (event.type === 'view/focus') {
        // Only the latest focus matters; a trail of clicks is noise.
        const at = pending.lines.findIndex((line) => line.type === 'view/focus')
        if (at >= 0) drop(at)
      }
      pending.lines.push({ type: event.type, at: event.at ?? now(), summary: event.summary ?? event.type })
      while (pending.lines.length > BATCH_CAP) {
        drop(0)
        pending.dropped += 1
      }
      flush()
    } catch (error) {
      logger?.warn?.(`dsh-mainline: 处理事件失败：${error?.message ?? error}`)
    }
  }

  /** Feed `ctx.on('agent/status')` payloads here. */
  function handleStatus(payload) {
    try {
      if (sessionId && payload?.agent?.id === sessionId && payload.status === 'idle') flush()
    } catch (error) {
      logger?.warn?.(`dsh-mainline: 状态回调失败：${error?.message ?? error}`)
    }
  }

  /**
   * Start a real turn (or queue one) in the conversation: "交给 AI".
   *
   * @param {string} text
   * @param {string} [summary]
   */
  async function ask(text, summary = '工作树：交给 AI') {
    const id = await ensure()
    const agent = await resolveAgent(id)
    if (!agent?.followup) throw new TreeError('session-unavailable', '工作树会话当前无法接收消息')
    // Deliver what the user did first, so the turn starts with the same picture.
    flush()
    await agent.followup(noticeMessage(text, summary))
  }

  /**
   * Register the guidance section and the focus context.
   *
   * @param {{ section: Function, context: Function }} systemPrompt
   * @param {{ guidance?: boolean }} [opts]
   * @returns {() => void} disposer that never throws
   */
  function registerPrompt(systemPrompt, opts = {}) {
    const disposers = []
    const mine = (c) => sessionId !== null && c?.agent?.id === sessionId
    if (opts.guidance !== false) {
      disposers.push(
        systemPrompt.section({
          name: 'dsh-mainline:guidance',
          order: 3050,
          interpolate: false,
          text: (c) => (mine(c) ? GUIDANCE_FULL : GUIDANCE_SHORT),
        }),
      )
    }
    disposers.push(
      systemPrompt.context({
        name: 'dsh-mainline:focus',
        order: 140,
        interpolate: false,
        text: (c) => (mine(c) ? renderFocus({ service, focus }) : ''),
      }),
    )
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* unloading must not throw */
        }
      }
    }
  }

  /** Subscribe to the event stream. @returns {() => void} */
  function attach() {
    const dispose = events.subscribe(onEvent)
    return () => {
      try {
        dispose?.()
      } catch {
        /* unloading must not throw */
      }
    }
  }

  return {
    ensure,
    reset,
    ask,
    attach,
    handleStatus,
    registerPrompt,
    flush,
    cwd,
    /** The remembered id, or null before the first `ensure()`. */
    id: () => sessionId,
    /** Load the remembered id from disk without creating anything (so events can be queued). */
    load: loadId,
    focus: () => focus,
  }
}
