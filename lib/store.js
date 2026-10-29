/**
 * The project files: one Markdown file per project plus `mainline.json` for their order.
 *
 * This is the only module that writes to them, and every write happens under two locks — an
 * in-process queue (so two callers in one process never poll the file lock against each other)
 * and `.mainline/lock` (so two processes never interleave a read-modify-write). The file on
 * disk is the truth; the cache is only what the panel reads, replaced wholesale after a write
 * so a reader holding a tree never sees it change underneath.
 *
 * An editor does not take our lock. So after computing the new text we read the file once more
 * and, if it changed in the meantime, run the mutation again on the newer text instead of
 * overwriting what the person just saved.
 *
 * @module dsh-mainline/store
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { atomicWrite, renameWithRetry } from './atomic.js'
import { TreeError } from './errors.js'
import { parse, serialize } from './format.js'
import { createFileLock } from './lockfile.js'

const MAX_ATTEMPTS = 3
const NAME_MAX = 60
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** @typedef {{ id: string, file: string, text: string, rev: string, root: import('./tree.js').Node }} Entry */

/** First 12 hex of sha1(text): the `rev` a caller can compare to know the file moved. */
export function revOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/**
 * The file name for a new project. Windows is the primary platform, so besides the characters
 * the spec lists this also avoids control characters, trailing dots and device names (`NUL.md`
 * cannot be created there), and compares names case-insensitively.
 *
 * @param {string} title
 * @param {Set<string>} taken lower-cased names already in use
 * @returns {string}
 */
export function fileNameFor(title, taken) {
  let stem = String(title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|#{}\u0000-\u001f]|\s+/g, '-')
    .replace(/-+/g, '-')
  stem = Array.from(stem).slice(0, NAME_MAX).join('').replace(/^[-.]+|[-.]+$/g, '')
  if (stem === '') stem = 'project'
  if (RESERVED.test(stem)) stem = `${stem}-`
  let name = `${stem}.md`
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${stem}-${n}.md`
  return name
}

/** A stable replacement id for a project whose own id is taken; derived from the file name so every process agrees. */
function substituteId(file, used) {
  const base = `p${Number.parseInt(createHash('sha1').update(file).digest('hex').slice(0, 8), 16).toString(36).slice(0, 5)}`
  let id = base
  for (let n = 2; used.has(id); n += 1) id = `${base.slice(0, 8 - String(n).length)}${n}`
  return id
}

const isTransient = (error) => ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {{ root: string, logger?: object, lockTimeoutMs?: number, renameAttempts?: number }} options
 */
export function createStore({ root, logger, lockTimeoutMs, renameAttempts }) {
  const local = path.join(root, '.mainline')
  const orderFile = path.join(root, 'mainline.json')
  const lock = createFileLock({ file: path.join(local, 'lock'), logger, timeoutMs: lockTimeoutMs })

  /** @type {Map<string, Entry>} by file name */
  const byFile = new Map()
  /** File names in display order; may name a file that is momentarily missing (an editor mid-save). */
  let order = []
  let queue = Promise.resolve()

  /** One writer at a time in this process, in arrival order. */
  function exclusive(fn) {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  async function withFileLock(fn) {
    await lock.acquire()
    try {
      return await fn()
    } finally {
      await lock.release()
    }
  }

  /** @returns {Promise<string | null>} null when the file does not exist */
  async function readText(file) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        // an editor or a scanner holds it for a moment
        if (attempt < 3 && isTransient(error)) {
          await sleep(15 * (attempt + 1))
          continue
        }
        throw new TreeError('store-corrupt', `读不了 ${path.basename(file)}：${error?.message ?? error}`, { file })
      }
    }
  }

  async function readStoredOrder() {
    const text = await readText(orderFile)
    if (text === null) return []
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed?.order) ? parsed.order.filter((n) => typeof n === 'string') : []
    } catch (error) {
      // the order is a convenience; a damaged file must not hide the projects
      logger?.warn?.(`dsh-mainline: mainline.json 无法解析，按文件名排序：${error?.message ?? error}`)
      return []
    }
  }

  async function scan() {
    const names = await readdir(root).catch((error) => {
      if (error?.code === 'ENOENT') return []
      throw new TreeError('store-unwritable', `读不了目录 ${root}：${error?.message ?? error}`)
    })
    return names.filter((n) => /\.md$/i.test(n) && !n.startsWith('.')).sort()
  }

  /** Stored order minus names without a file, plus files it does not know, by name. */
  function mergeOrder(stored, names) {
    const present = new Set(names)
    const seen = new Set()
    const merged = []
    for (const name of stored) if (present.has(name) && !seen.has(name)) (seen.add(name), merged.push(name))
    for (const name of names) if (!seen.has(name)) merged.push(name)
    return merged
  }

  const idsInUse = (except) => new Set([...byFile.values()].filter((e) => e.file !== except).map((e) => e.id))

  /** Parse a file's text into an entry; `id` pins the identity of a project that is being reloaded. */
  function makeEntry(file, text, id) {
    const tree = parse(text, { file })
    if (id !== undefined) tree.id = id
    else if (idsInUse(file).has(tree.id)) tree.id = substituteId(file, idsInUse(file))
    return { id: tree.id, file, text, rev: revOf(text), root: tree }
  }

  async function writeOrder() {
    const present = order.filter((name) => byFile.has(name))
    await atomicWrite(orderFile, `${JSON.stringify({ version: 1, order: present }, null, 2)}\n`, { renameAttempts })
  }

  function entryById(id) {
    for (const entry of byFile.values()) if (entry.id === id) return entry
    throw new TreeError('not-found', `找不到项目 ${id}`)
  }

  /** Entries in display order. */
  function list() {
    return order.map((name) => byFile.get(name)).filter(Boolean)
  }

  /**
   * Read every project and settle the order. Adopted files and dropped names are persisted (best
   * effort — an unwritable order file must not stop the panel from opening).
   *
   * @returns {Promise<{ changed: boolean }>} whether `mainline.json` had to change
   */
  async function load() {
    await mkdir(path.join(local, 'view'), { recursive: true })
    const names = await scan()
    const stored = await readStoredOrder()
    byFile.clear()
    const merged = mergeOrder(stored, names)
    for (const name of merged) {
      const text = await readText(path.join(root, name))
      if (text === null) continue
      const entry = makeEntry(name, text)
      byFile.set(name, entry)
    }
    order = merged.filter((name) => byFile.has(name))
    const changed = JSON.stringify(order) !== JSON.stringify(stored) && (order.length > 0 || stored.length > 0)
    if (changed) {
      try {
        await exclusive(() => withFileLock(writeOrder))
      } catch (error) {
        logger?.warn?.(`dsh-mainline: 无法写 mainline.json：${error?.message ?? error}`)
      }
    }
    return { changed }
  }

  /**
   * Read-modify-write one project under the lock.
   *
   * `mutate(tree)` edits a freshly parsed tree in place and may return a value, which is handed
   * back. It can run more than once (see the module comment), so it must only touch `tree`.
   * Returning `{ noop: true }` skips the write; so does a result that serializes to what is
   * already on disk.
   *
   * @param {string} id project id
   * @param {(tree: import('./tree.js').Node) => unknown} mutate
   * @returns {Promise<{ entry: Entry, value: any, wrote: boolean }>}
   */
  function update(id, mutate) {
    return exclusive(() =>
      withFileLock(async () => {
        const known = entryById(id)
        const full = path.join(root, known.file)
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const text = await readText(full)
          if (text === null) throw new TreeError('not-found', `项目文件 ${known.file} 已经不在了`)
          const tree = parse(text, { file: known.file })
          tree.id = known.id
          const value = await mutate(tree)
          if (value?.noop === true) return { entry: known, value, wrote: false }
          const out = serialize(tree)
          // The editor saved while we were computing: start over from what it saved.
          if ((await readText(full)) !== text) continue
          if (out === text) return { entry: known, value, wrote: false }
          try {
            await atomicWrite(full, out, { renameAttempts })
          } catch (error) {
            throw new TreeError('store-unwritable', `写不了 ${known.file}：${error?.message ?? error}`, { file: known.file })
          }
          const entry = makeEntry(known.file, out, known.id)
          byFile.set(known.file, entry)
          return { entry, value, wrote: true }
        }
        throw new TreeError('store-busy', `${known.file} 一直在被别处修改，没能写入。请稍后再试。`, { file: known.file })
      }),
    )
  }

  /**
   * Create a project file. `build({ file, used })` returns the root node (its id must not be in
   * `used`); the name comes from `title` and is never reused, even by case.
   *
   * @returns {Promise<Entry>}
   */
  function createProject({ title, build }) {
    return exclusive(() =>
      withFileLock(async () => {
        const names = await readdir(root).catch(() => [])
        const taken = new Set([...names, ...byFile.keys()].map((n) => n.toLowerCase()))
        const file = fileNameFor(title, taken)
        const used = idsInUse()
        const tree = build({ file, used })
        if (used.has(tree.id)) tree.id = substituteId(file, used)
        const text = serialize(tree)
        try {
          await atomicWrite(path.join(root, file), text, { renameAttempts })
        } catch (error) {
          throw new TreeError('store-unwritable', `写不了 ${file}：${error?.message ?? error}`, { file })
        }
        const entry = makeEntry(file, text, tree.id)
        byFile.set(file, entry)
        order = [...order.filter((n) => n !== file), file]
        await writeOrder()
        return entry
      }),
    )
  }

  /**
   * Remove a project from the tree. The file moves to `.mainline/trash/` rather than being
   * deleted: git keeps the history, but git may be missing, and a delete must not be final.
   *
   * @returns {Promise<Entry>}
   */
  function removeProject(id) {
    return exclusive(() =>
      withFileLock(async () => {
        const entry = entryById(id)
        const full = path.join(root, entry.file)
        const trash = path.join(local, 'trash')
        await mkdir(trash, { recursive: true })
        try {
          await renameWithRetry({ rename }, full, path.join(trash, `${entry.file}.${Date.now()}`))
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            // cross-device or locked: copy first, delete second, so a failure in between loses nothing
            await copyFile(full, path.join(trash, `${entry.file}.${Date.now()}`))
            await unlink(full).catch((e) => {
              throw new TreeError('store-unwritable', `删不掉 ${entry.file}：${e?.message ?? e}`, { file: entry.file })
            })
          }
        }
        byFile.delete(entry.file)
        order = order.filter((n) => n !== entry.file)
        await writeOrder()
        return entry
      }),
    )
  }

  /**
   * Put the listed projects first, in that order; projects not listed keep their relative order after them.
   * @param {string[]} ids
   * @returns {Promise<{ changed: boolean, order: string[] }>} project ids in the new order
   */
  function reorder(ids) {
    return exclusive(() =>
      withFileLock(async () => {
        const files = ids.map((id) => entryById(id).file)
        const next = [...files, ...list().map((e) => e.file).filter((n) => !files.includes(n))]
        const before = list().map((e) => e.file)
        if (JSON.stringify(next) !== JSON.stringify(before)) {
          order = next
          await writeOrder()
          return { changed: true, order: list().map((e) => e.id) }
        }
        return { changed: false, order: list().map((e) => e.id) }
      }),
    )
  }

  /**
   * Re-read one file after an external change. Runs in the write queue (not under the file lock)
   * so it never observes the gap between our rename and our cache update, which is what keeps our
   * own writes from looking like somebody else's. Never writes.
   *
   * @param {string} file
   * @returns {Promise<{ type: 'none' } | { type: 'changed', before: Entry, entry: Entry } | { type: 'added', entry: Entry } | { type: 'removed', entry: Entry }>}
   */
  function refresh(file) {
    return exclusive(async () => {
      const text = await readText(path.join(root, file))
      const known = byFile.get(file)
      if (text === null) {
        if (!known) return { type: 'none' }
        // the name stays in `order`: an editor that saves by delete-then-create gets its place back
        byFile.delete(file)
        return { type: 'removed', entry: known }
      }
      if (known) {
        if (known.text === text) return { type: 'none' }
        const entry = makeEntry(file, text, known.id)
        byFile.set(file, entry)
        return { type: 'changed', before: known, entry }
      }
      const entry = makeEntry(file, text)
      byFile.set(file, entry)
      if (!order.includes(file)) order = [...order, file]
      return { type: 'added', entry }
    })
  }

  /** Re-read `mainline.json` after an external edit; true when the effective order changed. Never writes. */
  function reloadOrder() {
    return exclusive(async () => {
      const merged = mergeOrder(await readStoredOrder(), [...byFile.keys()].sort())
      const before = list().map((e) => e.file)
      if (JSON.stringify(merged) === JSON.stringify(before)) return false
      order = merged
      return true
    })
  }

  return {
    root,
    local,
    orderFile,
    load,
    list,
    get: (id) => entryById(id),
    find: (id) => [...byFile.values()].find((e) => e.id === id) ?? null,
    files: () => [...byFile.keys()],
    update,
    createProject,
    removeProject,
    reorder,
    refresh,
    reloadOrder,
  }
}
