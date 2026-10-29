/**
 * Running a command from a card.
 *
 * The one rule that keeps this safe: the command is **read from the stored node
 * body** at the moment of the run. A request names a fence by `(project, node,
 * index)` and nothing else, so the route can never become "execute this text".
 *
 * @module dsh-mainline/runner
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import { TreeError } from './errors.js'

/** Info-string languages that count as a runnable shell fence. */
export const SHELL_LANGS = Object.freeze(['bash', 'sh', 'shell', 'zsh', 'console', 'pwsh', 'powershell', 'ps1', 'cmd', 'bat'])

const OUTPUT_TAIL = 20_000
const EVENT_TAIL = 600
const RUN_TIMEOUT_MS = 120_000
const MAX_RECORDS = 200

/**
 * Shell fences in a Markdown body.
 *
 * Same fence rule as the file format: an opening line without a matching close is
 * plain text. `index` counts shell fences only, in order, so the panel and the
 * host agree on "the second command of this card" without sharing a parser.
 * `start` / `end` are character offsets of the opening line and of the end of the
 * closing line (no trailing newline).
 *
 * @param {string} body
 * @returns {Array<{ index: number, lang: string, code: string, start: number, end: number }>}
 */
export function extractFences(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const offsets = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (!open) continue
    const [, marker, info] = open
    // A backtick fence's info string may not contain a backtick (that is inline code).
    if (marker[0] === '`' && info.includes('`')) continue
    let close = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j])
      if (m && m[1][0] === marker[0] && m[1].length >= marker.length) {
        close = j
        break
      }
    }
    if (close < 0) continue
    const lang = (info.trim().split(/\s+/)[0] ?? '').toLowerCase()
    if (SHELL_LANGS.includes(lang)) {
      found.push({
        index: found.length,
        lang,
        code: lines.slice(i + 1, close).join('\n'),
        start: offsets[i],
        end: offsets[close] + lines[close].length,
      })
    }
    i = close
  }
  return found
}

/** @param {string} text @param {number} max */
const tail = (text, max) => (text.length > max ? text.slice(text.length - max) : text)

/** @param {string} text */
function lastLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const line = lines.at(-1) ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/**
 * @param {object} options
 * @param {object} options.ctx - plugin context (`ctx.root.get('shell')`)
 * @param {object} options.service
 * @param {object} [options.session] - supplies the default cwd when `cwd` is not given
 * @param {{ publish: Function }} options.events
 * @param {object} [options.logger]
 * @param {string | (() => string)} [options.cwd] - fallback working directory
 */
export function createRunner(options) {
  const { ctx, service, session, events, logger } = options
  const hostRoot = () => ctx?.root ?? ctx
  const host = (name) => {
    try {
      return hostRoot()?.get?.(name) ?? undefined
    } catch {
      return undefined
    }
  }

  /** key `project/node/index` → record; runId → { key, execution }. */
  const records = new Map()
  const live = new Map()

  function fallbackCwd() {
    const wanted = typeof options.cwd === 'function' ? options.cwd() : options.cwd
    if (typeof wanted === 'string' && wanted !== '') return wanted
    return session?.cwd?.() ?? homedir()
  }

  /**
   * What a fence request refers to, resolved from the stored tree.
   *
   * @param {{ project: string, node: string, index?: number }} ref
   * @returns {{ node: object, where: string, cwd: string, fence: object | null }}
   */
  function inspect(ref) {
    const hit = service.locate(ref.project, ref.node)
    if (!hit) throw new TreeError('not-found', `找不到节点 ${ref.node}`)
    const chain = [...hit.path].reverse()
    const withCwd = [hit.node, ...chain].find((n) => typeof n?.attrs?.cwd === 'string' && n.attrs.cwd !== '')
    const cwd = withCwd ? withCwd.attrs.cwd : fallbackCwd()
    let fence = null
    if (ref.index !== undefined && ref.index !== null) {
      fence = extractFences(hit.node.body).find((f) => f.index === ref.index) ?? null
      if (!fence) throw new TreeError('not-found', `这张卡上没有第 ${Number(ref.index) + 1} 段命令`)
    }
    return { node: hit.node, where: service.where(ref.project, ref.node), cwd, fence }
  }

  const keyOf = (ref) => `${ref.project}/${ref.node}/${ref.index}`

  function publicRecord(rec) {
    return { ...rec }
  }

  function remember(key, rec) {
    records.delete(key)
    records.set(key, rec)
    if (records.size <= MAX_RECORDS) return
    for (const [k, r] of records) {
      if (records.size <= MAX_RECORDS) break
      if (r.status !== 'running') records.delete(k)
    }
  }

  function finish(rec, patch, project, node, actor) {
    Object.assign(rec, patch, { endedAt: Date.now() })
    rec.status = rec.exitCode === 0 && !rec.timedOut && !rec.aborted ? 'done' : 'failed'
    live.delete(rec.runId)
    const output = `${rec.stdout}${rec.stderr ? `\n${rec.stderr}` : ''}`
    const why = rec.aborted ? '已取消' : rec.timedOut ? '超时' : `退出码 ${rec.exitCode ?? '未知'}`
    const last = lastLine(rec.stderr && rec.exitCode !== 0 ? rec.stderr : output)
    events.publish({
      type: 'run/finished',
      actor,
      project,
      node,
      summary: `命令运行结束（${why}）${last ? `：${last}` : ''}`,
      data: {
        runId: rec.runId,
        index: rec.index,
        command: rec.command,
        cwd: rec.cwd,
        exitCode: rec.exitCode ?? null,
        timedOut: rec.timedOut,
        aborted: rec.aborted,
        tail: tail(output, EVENT_TAIL),
      },
    })
  }

  /**
   * Start the `index`-th shell fence of a card.
   *
   * @param {{ project: string, node: string, index: number }} ref
   * @param {{ kind: string, session?: string }} actor
   * @returns {Promise<object>} the run record (running, or already failed to start)
   */
  async function run(ref, actor) {
    if (!Number.isInteger(ref?.index) || ref.index < 0) throw new TreeError('invalid-request', 'index 必须是非负整数')
    const target = inspect(ref)
    const key = keyOf(ref)
    const existing = records.get(key)
    if (existing?.status === 'running') return publicRecord(existing)

    const shell = host('shell')
    if (!shell?.resolve || !shell?.execute) throw new TreeError('shell-unavailable', '宿主没有提供 shell 服务')

    const rec = {
      runId: randomUUID(),
      project: ref.project,
      node: ref.node,
      index: ref.index,
      status: 'running',
      command: target.fence.code,
      cwd: target.cwd,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      timedOut: false,
      aborted: false,
      stdout: '',
      stderr: '',
    }
    remember(key, rec)
    events.publish({
      type: 'run/started',
      actor,
      project: ref.project,
      node: ref.node,
      summary: `在「${target.where}」运行第 ${ref.index + 1} 段命令`,
      data: { runId: rec.runId, index: rec.index, command: rec.command, cwd: rec.cwd },
    })

    let execution
    try {
      let policy
      try {
        policy = host('sandboxPolicy')?.resolve?.()
      } catch {
        policy = undefined
      }
      const spec = shell.resolve({ command: rec.command, workdir: rec.cwd, timeoutMs: RUN_TIMEOUT_MS, sandboxPolicy: policy })
      execution = await shell.execute(spec)
    } catch (error) {
      logger?.warn?.(`dsh-mainline: 启动命令失败：${error?.message ?? error}`)
      finish(rec, { stderr: String(error?.message ?? error) }, ref.project, ref.node, actor)
      return publicRecord(rec)
    }
    live.set(rec.runId, { execution, rec })

    void Promise.resolve()
      .then(() => execution.result())
      .then(
        (result) =>
          finish(
            rec,
            {
              exitCode: result?.exitCode ?? null,
              timedOut: result?.timedOut === true,
              aborted: result?.aborted === true || rec.aborted,
              stdout: tail(String(result?.stdout?.text ?? ''), OUTPUT_TAIL),
              stderr: tail(String(result?.stderr?.text ?? ''), OUTPUT_TAIL),
            },
            ref.project,
            ref.node,
            actor,
          ),
        (error) => finish(rec, { stderr: String(error?.message ?? error) }, ref.project, ref.node, actor),
      )
    return publicRecord(rec)
  }

  /**
   * @param {string} runId
   * @returns {boolean} whether a running command was asked to stop
   */
  function cancel(runId) {
    const entry = live.get(runId)
    if (!entry) return false
    entry.rec.aborted = true
    try {
      entry.execution.kill?.()
    } catch (error) {
      logger?.warn?.(`dsh-mainline: 终止命令失败：${error?.message ?? error}`)
    }
    return true
  }

  /** Latest run per fence, oldest first. @param {{ project?: string, node?: string }} [filter] */
  function list(filter = {}) {
    return [...records.values()]
      .filter((r) => (!filter.project || r.project === filter.project) && (!filter.node || r.node === filter.node))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(publicRecord)
  }

  /** Stop everything still running (plugin unload). */
  function dispose() {
    for (const runId of [...live.keys()]) cancel(runId)
  }

  return { run, cancel, list, inspect, dispose }
}
