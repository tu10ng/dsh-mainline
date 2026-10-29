/**
 * History for the tree: the project files live in a git repository so nothing a person or the
 * model does is ever unrecoverable.
 *
 * Commits are batched (a burst of clicks is one commit) and never rewrite anything: a restore is
 * a new commit on top. Git is optional — without it the plugin keeps working and only the
 * history surface answers `git-unavailable`.
 *
 * `execFile` with an argument array, never a shell: titles and file names reach the argument
 * list, and a shell would turn a title like `a; rm` into a command. Every git call is a process
 * start (about a second on a Windows machine with a scanner), so the code spends as few as it can.
 *
 * @module dsh-mainline/git
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { TreeError } from './errors.js'

const FALLBACK_NAME = 'dsh-mainline'
const FALLBACK_EMAIL = 'mainline@localhost'
const AGENT_AUTHOR = 'DSH Agent <agent@dsh.local>'
const DEFAULT_DELAY_MS = 4000
// line endings in the repo are ours to keep: a global autocrlf must not rewrite or warn about them
const NEUTRAL = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=off']
const RECORD = String.fromCharCode(0x1e)
const FIELD = String.fromCharCode(0x1f)

/**
 * @param {{ root: string, logger?: object, events?: object, commitDelayMs?: number, gitBin?: string, env?: Record<string, string> }} options
 *   `gitBin` and `env` exist for tests (a missing git, an identity-less machine).
 */
export function createGit({ root, logger, events, commitDelayMs = DEFAULT_DELAY_MS, gitBin = 'git', env } = {}) {
  let available = null
  let identity = []
  /** Tree files git already has, so a deleted one can still be staged. */
  let tracked = new Set()
  let timer = null
  let pending = []
  let chain = Promise.resolve()

  const childEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(env ?? {}) }

  /** @returns {Promise<{ code: number, stdout: string, stderr: string }>} never rejects */
  function run(args) {
    return new Promise((resolve) => {
      const child = execFile(
        gitBin,
        [...NEUTRAL, ...args],
        { cwd: root, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) return resolve({ code: 0, stdout, stderr })
          // A spawn that failed (the folder was deleted under us) can leave its pipes open, and
          // open pipes keep the whole process from exiting.
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
          resolve({ code: typeof error.code === 'number' ? error.code : -1, stdout: stdout ?? '', stderr: stderr || error.message })
        },
      )
    })
  }

  function requireAvailable() {
    if (available !== true) throw new TreeError('git-unavailable', '没有可用的 git，历史功能不可用（其余功能不受影响）')
  }

  /** The identity flags go in only when git has none of its own: a person's config always wins. */
  async function detectIdentity() {
    const result = await run(['config', '--get-regexp', '^user\\.(name|email)$'])
    const set = new Set(result.stdout.split('\n').map((line) => line.split(' ')[0]).filter(Boolean))
    const flags = []
    if (!set.has('user.name')) flags.push('-c', `user.name=${FALLBACK_NAME}`)
    if (!set.has('user.email')) flags.push('-c', `user.email=${FALLBACK_EMAIL}`)
    identity = flags
  }

  /**
   * Stage the tree files that exist, plus tracked ones that vanished (a removed project).
   * Deletions come from our own record of what git has rather than an `ls-files` per commit:
   * `add` fails on a pathspec that matches nothing, so the list has to be exact.
   */
  async function stage() {
    const names = await readdir(root).catch(() => [])
    const present = names.filter((n) => /\.md$/i.test(n) && !n.startsWith('.'))
    for (const fixed of ['mainline.json', '.gitignore']) if (existsSync(path.join(root, fixed))) present.push(fixed)
    const paths = [...present, ...[...tracked].filter((n) => !present.includes(n))]
    if (paths.length === 0) return
    const added = await run(['add', '-A', '--', ...paths])
    if (added.code !== 0) throw new Error(added.stderr.trim() || 'git add failed')
    tracked = new Set(present)
  }

  /** @returns {Promise<string | null>} the new rev, or null when there was nothing to commit */
  async function commit(message, author) {
    const args = [...identity, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message]
    if (author) args.push(`--author=${author}`)
    const result = await run(args)
    if (result.code !== 0) {
      if (/nothing (added )?to commit|no changes added/i.test(result.stdout + result.stderr)) return null
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'git commit failed')
    }
    const head = await run(['rev-parse', 'HEAD'])
    return head.stdout.trim()
  }

  /** @returns {Promise<void>} resolves after the commit attempt; never rejects */
  function commitBatch(batch) {
    chain = chain.then(async () => {
      try {
        await stage()
        const first = batch[0]?.summary || '更新工作树'
        const message = batch.length > 1 ? `${first}（另有 ${batch.length - 1} 处改动）` : first
        // a batch that mixes people and the model cannot be attributed to one author
        const agentOnly = batch.length > 0 && batch.every((b) => b.actor?.kind === 'agent')
        const rev = await commit(message, agentOnly ? AGENT_AUTHOR : null)
        if (rev === null) return
        events?.publish({ type: 'git/committed', actor: { kind: 'system' }, summary: `已提交：${message}`, data: { rev, message } })
      } catch (error) {
        logger?.warn?.(`dsh-mainline: git 提交失败：${error?.message ?? error}`)
      }
    })
    return chain
  }

  function takePending() {
    if (timer) clearTimeout(timer)
    timer = null
    const batch = pending
    pending = []
    return batch
  }

  return {
    /** `null` before `init()`, then whether git works. Live, so /health reflects the result. */
    get available() {
      return available
    },

    /** Find git, make `root` a repository of its own, commit what is already there. Never throws. */
    async init() {
      const version = await run(['--version'])
      available = version.code === 0
      if (!available) {
        logger?.warn?.(`dsh-mainline: 找不到 git（${version.stderr.trim()}），历史功能关闭`)
        return
      }
      try {
        await detectIdentity()
        // `.git` in root itself, not "some repository above": a parent repo must never receive our commits
        if (existsSync(path.join(root, '.git'))) {
          const listed = await run(['ls-files', '-z', '--', ':(glob)*.md', 'mainline.json', '.gitignore'])
          tracked = new Set(listed.stdout.split('\0').filter(Boolean))
        } else {
          const init = await run(['init', '-q', '-b', 'main'])
          if (init.code !== 0) throw new Error(init.stderr.trim())
          if (!existsSync(path.join(root, '.gitignore'))) await writeFile(path.join(root, '.gitignore'), '.mainline/\n', 'utf8')
          await commitBatch([{ summary: '初始化工作树', actor: { kind: 'system' } }])
        }
      } catch (error) {
        available = false
        logger?.warn?.(`dsh-mainline: git 初始化失败，历史功能关闭：${error?.message ?? error}`)
      }
    },

    /** True when the tree has changes git has not recorded (a file edited while we were off). */
    async dirty() {
      if (available !== true) return false
      const status = await run(['status', '--porcelain', '--', ':(glob)*.md', 'mainline.json', '.gitignore'])
      return status.code === 0 && status.stdout.trim() !== ''
    },

    /** Record that something changed; the commit happens `commitDelayMs` after the last call. */
    schedule(summary, actor) {
      if (available !== true) return
      pending.push({ summary: String(summary ?? ''), actor })
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void commitBatch(takePending())
      }, commitDelayMs)
      timer.unref?.()
    },

    /** Commit now (shutdown, tests). Resolves once every queued commit has finished. */
    async flush() {
      if (available !== true) return
      if (pending.length > 0) await commitBatch(takePending())
      await chain
    },

    /** @returns {Promise<{ rev: string, short: string, author: string, at: number, message: string }[]>} */
    async log({ file, limit = 50 } = {}) {
      requireAvailable()
      const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 500)
      const args = ['log', `-n${n}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e']
      if (file) args.push('--', file)
      const result = await run(args)
      // a repository without a commit yet is an empty history, not a failure
      if (result.code !== 0) {
        if (/does not have any commits|bad default revision|unknown revision/i.test(result.stderr)) return []
        throw new TreeError('git-failed', `git log 失败：${result.stderr.trim()}`)
      }
      return result.stdout
        .split(RECORD)
        .map((record) => record.replace(/^\s+/, ''))
        .filter(Boolean)
        .map((record) => {
          const [rev, short, author, at, message] = record.split(FIELD)
          return { rev, short, author, at: Number(at) * 1000, message }
        })
    },

    /** The text of `file` as of `rev`. */
    async show(rev, file) {
      requireAvailable()
      // a rev that starts with '-' would be read as an option
      if (typeof rev !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._/~^@{}-]*$/.test(rev)) throw new TreeError('invalid-request', `不是合法的版本号：${rev}`)
      if (typeof file !== 'string' || file === '' || /[\\/]|^\.\.?$/.test(file)) throw new TreeError('invalid-request', `不是合法的文件名：${file}`)
      const result = await run(['show', `${rev}:${file}`])
      if (result.code !== 0) throw new TreeError('not-found', `版本 ${rev} 里没有 ${file}`)
      return result.stdout
    },
  }
}
