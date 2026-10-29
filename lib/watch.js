/**
 * Notice edits made outside the plugin — an editor saving a project file, a `git pull`.
 *
 * The watcher only reads and reports. It never writes a file in response to an edit: the person
 * is probably still typing in that editor, and a write from here would fight their next save.
 * Whether a change is ours is decided by the store (content equal to what we last wrote), not by
 * the event, because `fs.watch` fires several times per save and says nothing about who saved.
 *
 * @module dsh-mainline/watch
 */

import { watch as fsWatch } from 'node:fs'
import { readdir } from 'node:fs/promises'

const DEBOUNCE_MS = 300

/**
 * Compare two trees by node id.
 *
 * @param {import('./tree.js').Node} before
 * @param {import('./tree.js').Node} after
 * @returns {{ added: string[], removed: string[], changed: string[] }} `changed` = title, state, question or body differs
 */
export function diffTrees(before, after) {
  const index = (root) => {
    const map = new Map()
    const visit = (node) => {
      map.set(node.id, node)
      node.children.forEach(visit)
    }
    visit(root)
    return map
  }
  const old = index(before)
  const next = index(after)
  const added = [...next.keys()].filter((id) => !old.has(id))
  const removed = [...old.keys()].filter((id) => !next.has(id))
  const changed = [...next.keys()].filter((id) => {
    const a = old.get(id)
    const b = next.get(id)
    return a && (a.title !== b.title || a.state !== b.state || a.question !== b.question || a.body !== b.body)
  })
  return { added, removed, changed }
}

const isProjectFile = (name) => /\.md$/i.test(name) && !name.startsWith('.')

/**
 * @param {{ root: string, store: object, logger?: object, debounceMs?: number, watchFn?: typeof fsWatch,
 *   onEdit: (e: { id: string, file: string, title: string, added: string[], removed: string[], changed: string[] }) => void,
 *   onAppear?: (e: { id: string, file: string, title: string }) => void,
 *   onDisappear?: (e: { id: string, file: string, title: string }) => void,
 *   onOrder?: () => void }} options
 * @returns {{ start: () => void, close: () => void, idle: () => Promise<void>, rescan: () => Promise<void> }}
 */
export function createWatch({ root, store, logger, debounceMs = DEBOUNCE_MS, watchFn = fsWatch, onEdit, onAppear, onDisappear, onOrder }) {
  const timers = new Map()
  let watcher = null
  let working = Promise.resolve()
  let closed = false

  async function handleFile(file) {
    if (closed) return
    const change = await store.refresh(file)
    if (change.type === 'changed') {
      const { entry, before } = change
      onEdit?.({ id: entry.id, file, title: entry.root.title, ...diffTrees(before.root, entry.root) })
    } else if (change.type === 'added') {
      onAppear?.({ id: change.entry.id, file, title: change.entry.root.title })
    } else if (change.type === 'removed') {
      onDisappear?.({ id: change.entry.id, file, title: change.entry.root.title })
    }
  }

  async function handleOrder() {
    if (closed) return
    if (await store.reloadOrder()) onOrder?.()
  }

  /** Run after whatever is already running, and never let one failure stop the next. */
  function enqueue(job) {
    working = working.then(job).catch((error) => {
      logger?.warn?.(`dsh-mainline: 处理外部改动失败：${error?.message ?? error}`)
    })
    return working
  }

  function touch(key, job) {
    clearTimeout(timers.get(key))
    const timer = setTimeout(() => {
      timers.delete(key)
      void enqueue(job)
    }, debounceMs)
    timer.unref?.()
    timers.set(key, timer)
  }

  /** `filename` can be null on some platforms: then every file is a suspect. */
  async function rescan() {
    const names = (await readdir(root).catch(() => [])).filter(isProjectFile)
    const known = store.files()
    for (const file of new Set([...names, ...known])) await handleFile(file)
    await handleOrder()
  }

  function onEvent(_type, filename) {
    const name = filename == null ? null : String(filename)
    if (name === null) return touch('*', rescan)
    if (isProjectFile(name)) touch(name, () => handleFile(name))
    else if (name === 'mainline.json') touch(name, handleOrder)
  }

  return {
    start() {
      if (watcher) return
      try {
        watcher = watchFn(root, { persistent: false }, onEvent)
        // a watcher that dies (the folder was removed) must not take the process down with it
        watcher.on?.('error', (error) => {
          logger?.warn?.(`dsh-mainline: 文件监视出错，已停止监视：${error?.message ?? error}`)
          // a watcher that errored is dead; keeping the handle around only hides that
          try {
            watcher?.close()
          } catch {
            /* already gone */
          }
          watcher = null
        })
      } catch (error) {
        logger?.warn?.(`dsh-mainline: 无法监视 ${root}，外部编辑要到下次读取才会发现：${error?.message ?? error}`)
      }
    },
    close() {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      try {
        watcher?.close()
      } catch {
        /* closing must not throw */
      }
      watcher = null
    },
    /** Resolves when every debounced edit seen so far has been handled (tests). */
    async idle() {
      while (timers.size > 0) await new Promise((resolve) => setTimeout(resolve, debounceMs / 3 + 5))
      await working
    },
    rescan: () => enqueue(rescan),
  }
}
