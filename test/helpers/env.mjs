/** Real temp directories, real git, real files: the helpers every core test shares. */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEvents } from '../../lib/events.js'
import { createGit } from '../../lib/git.js'
import { createService } from '../../lib/service.js'

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures')

const made = []

const services = []

/** Remember a service so `cleanup` can close it: on Windows, deleting a folder that still has a live fs.watch keeps the process from exiting. */
export function track(service) {
  services.push(service)
  return service
}

/** Close every tracked service, then remove every temp directory this process created. Call from `after()`. */
export async function cleanup() {
  await Promise.allSettled(services.splice(0).map((service) => service.close()))
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      /* a scanner may still hold a handle; temp files are not worth failing a test over */
    }
  }
}

/**
 * A fresh root whose path has a space and CJK in it (the Windows hazard), seeded with fixtures.
 * Files are copied one by one: `cpSync` into a CJK destination crashed Node 24 on this machine.
 * @param {string[]} [seed] fixture file names
 */
export function makeRoot(seed = []) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mainline-test-'))
  made.push(base)
  const root = path.join(base, '工作 树')
  mkdirSync(root)
  for (const name of seed) copyFileSync(path.join(FIXTURES, name), path.join(root, name))
  return root
}

/** An env that makes git behave as on a machine nobody configured. */
export function bareGitEnv(root) {
  const home = path.join(path.dirname(root), 'home')
  mkdirSync(home, { recursive: true })
  return { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, 'none'), GIT_CONFIG_NOSYSTEM: '1' }
}

/** Boot events + git + service on `root` the way `index.js` does. */
export async function boot({ root = makeRoot(), seed, commitDelayMs = 25, watchDebounceMs = 30, gitOptions = {}, emit, noGit = false } = {}) {
  if (seed) for (const name of seed) copyFileSync(path.join(FIXTURES, name), path.join(root, name))
  const published = []
  const events = createEvents({ file: path.join(root, '.mainline', 'events.jsonl'), emit })
  events.subscribe((e) => published.push(e))
  const git = noGit ? undefined : createGit({ root, events, commitDelayMs, ...gitOptions })
  const service = createService({ root, events, git, watchDebounceMs })
  track(service)
  await service.ready()
  return { root, events, git, service, published }
}

export const gitOut = (root, ...args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8' }).trim()
export const commitCount = (root) => Number(gitOut(root, 'rev-list', '--count', 'HEAD'))
export const read = (root, name) => readFileSync(path.join(root, name), 'utf8')
export const names = (root) => readdirSync(root)

/** Poll until `fn()` is truthy. */
export async function until(fn, { timeout = 5000, step = 20 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, step))
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const HUMAN = { kind: 'human' }
export const AGENT = { kind: 'agent', session: 's-1' }
