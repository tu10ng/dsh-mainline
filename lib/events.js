/**
 * The event bus: one place every change is announced, remembered and fanned out.
 *
 * Three consumers hang off it — the SSE stream (panel), the session (tells the model what the
 * user did) and `events.jsonl` (a log a person can read after the fact). None of them may be
 * able to break a write, so every hand-off here is fenced: the op has already succeeded by
 * the time it is announced, and a failing listener must not turn that into an error.
 *
 * @module dsh-mainline/events
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

/** `events.jsonl` is rotated to `events.1.jsonl` past this size. */
export const ROTATE_BYTES = 5 * 1024 * 1024

const RECENT_MAX = 200
const NOT_LOGGED = /^view\//

/**
 * @typedef {{ kind: 'human' | 'agent' | 'external' | 'system', session?: string }} Actor
 * @typedef {{ id: string, seq: number, type: string, at: number, actor: Actor, project: string | null, node: string | null, summary: string, data: object }} MainlineEvent
 */

/**
 * @param {{ file?: string, logger?: object, emit?: (name: string, event: MainlineEvent) => void, now?: () => number, rotateBytes?: number }} options
 *   `file` empty/absent disables the log (tests that only care about delivery).
 * @returns {{ publish: (partial: object) => MainlineEvent, subscribe: (fn: (e: MainlineEvent) => void) => () => void, recent: (limit?: number) => MainlineEvent[], idle: () => Promise<void> }}
 */
export function createEvents({ file, logger, emit, now = Date.now, rotateBytes = ROTATE_BYTES } = {}) {
  const subscribers = new Set()
  const recent = []
  let seq = 0
  let chain = Promise.resolve()
  let size = null

  /** Rotation is checked from a running byte count, so the common append costs no stat. */
  async function append(line) {
    await mkdir(path.dirname(file), { recursive: true })
    if (size === null) size = await stat(file).then((s) => s.size, () => 0)
    if (size > rotateBytes) {
      await rename(file, path.join(path.dirname(file), 'events.1.jsonl')).catch(() => {})
      size = 0
    }
    await appendFile(file, line, 'utf8')
    size += Buffer.byteLength(line)
  }

  function log(event) {
    if (!file || NOT_LOGGED.test(event.type)) return
    // Chained so lines never interleave; the catch keeps one failure from poisoning the chain.
    chain = chain.then(() => append(`${JSON.stringify(event)}\n`)).catch((error) => {
      logger?.warn?.(`dsh-mainline: 事件日志写入失败：${error?.message ?? error}`)
    })
  }

  function guarded(label, fn) {
    try {
      fn()
    } catch (error) {
      logger?.warn?.(`dsh-mainline: ${label} 抛出了异常（已忽略）：${error?.message ?? error}`)
    }
  }

  /** @param {object} partial `type` plus whatever of actor/project/node/summary/data the caller knows */
  function publish(partial) {
    seq += 1
    const event = {
      id: randomUUID(),
      seq,
      type: String(partial?.type ?? 'unknown'),
      at: now(),
      actor: partial?.actor ?? { kind: 'system' },
      project: partial?.project ?? null,
      node: partial?.node ?? null,
      summary: partial?.summary ?? '',
      data: partial?.data ?? {},
    }
    recent.push(event)
    if (recent.length > RECENT_MAX) recent.shift()
    log(event)
    if (emit) {
      guarded('emit mainline/event', () => emit('mainline/event', event))
      guarded(`emit mainline/${event.type}`, () => emit(`mainline/${event.type}`, event))
    }
    for (const fn of [...subscribers]) guarded('事件订阅者', () => fn(event))
    return event
  }

  function subscribe(fn) {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  return {
    publish,
    subscribe,
    recent: (limit = 50) => recent.slice(-Math.max(0, limit)),
    /** Resolves once everything published so far is on disk (tests, shutdown). */
    idle: () => chain,
  }
}
