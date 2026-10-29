import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { createEvents } from '../lib/events.js'
import { createGit } from '../lib/git.js'
import { bareGitEnv, cleanup, commitCount, gitOut, makeRoot, sleep } from './helpers/env.mjs'

after(cleanup)

const AGENT = { kind: 'agent', session: 's' }
const HUMAN = { kind: 'human' }

async function repo(options = {}) {
  const root = options.root ?? makeRoot()
  const events = createEvents({})
  const published = []
  events.subscribe((e) => published.push(e))
  const git = createGit({ root, events, commitDelayMs: 40, ...options })
  await git.init()
  return { root, git, published }
}

const edit = (root, name, text) => writeFileSync(path.join(root, name), text)

test('init makes root a repository with a .gitignore and a first commit; available is live', async () => {
  const root = makeRoot()
  const probe = createGit({ root })
  assert.equal(probe.available, null)
  const { git } = await repo({ root })
  assert.equal(git.available, true)
  assert.equal(commitCount(root), 1)
  assert.equal(gitOut(root, 'show', 'HEAD:.gitignore'), '.mainline/')
  assert.equal(gitOut(root, 'branch', '--show-current'), 'main')
})

test('a root inside another repository gets a repository of its own', async () => {
  const outer = makeRoot()
  await repo({ root: outer })
  const inner = path.join(outer, 'inner')
  mkdirSync(inner)
  await repo({ root: inner })
  assert.ok(existsSync(path.join(inner, '.git')))
  assert.equal(commitCount(inner), 1)
})

test('several schedules inside the delay make one commit named after the first', async () => {
  const { root, git, published } = await repo()
  edit(root, 'a.md', '# A {#aaaa}\n')
  git.schedule('第一处', HUMAN)
  edit(root, 'b.md', '# B {#bbbb}\n')
  git.schedule('第二处', HUMAN)
  git.schedule('第三处', HUMAN)
  assert.equal(commitCount(root), 1)
  await sleep(300)
  await git.flush()
  assert.equal(commitCount(root), 2)
  assert.equal(gitOut(root, 'log', '-1', '--format=%s'), '第一处（另有 2 处改动）')
  assert.equal(published.filter((e) => e.type === 'git/committed').length, 2)
  assert.equal(published.at(-1).data.message, '第一处（另有 2 处改动）')
})

test('flush commits immediately; with nothing to commit it makes no commit', async () => {
  const { root, git } = await repo()
  edit(root, 'a.md', '# A {#aaaa}\n')
  git.schedule('改了', HUMAN)
  await git.flush()
  assert.equal(commitCount(root), 2)
  git.schedule('什么都没改', HUMAN)
  await git.flush()
  assert.equal(commitCount(root), 2)
  await git.flush()
  assert.equal(commitCount(root), 2)
})

test('only the tree files are staged', async () => {
  const { root, git } = await repo()
  edit(root, 'a.md', '# A {#aaaa}\n')
  edit(root, 'notes.txt', 'private')
  mkdirSync(path.join(root, '.mainline'), { recursive: true })
  edit(root, '.mainline/events.jsonl', '{}')
  git.schedule('x', HUMAN)
  await git.flush()
  assert.deepEqual(gitOut(root, 'ls-files').split('\n').sort(), ['.gitignore', 'a.md'])
})

test('agent writes are authored DSH Agent; a mixed batch is not', async () => {
  const { root, git } = await repo()
  edit(root, 'a.md', '# A {#aaaa}\n')
  git.schedule('模型改的', AGENT)
  await git.flush()
  assert.equal(gitOut(root, 'log', '-1', '--format=%an <%ae>'), 'DSH Agent <agent@dsh.local>')
  edit(root, 'a.md', '# A2 {#aaaa}\n')
  git.schedule('模型', AGENT)
  git.schedule('人', HUMAN)
  await git.flush()
  assert.notEqual(gitOut(root, 'log', '-1', '--format=%an'), 'DSH Agent')
})

test('a machine without user.name/user.email still commits', async () => {
  const root = makeRoot()
  const { git } = await repo({ root, env: bareGitEnv(root) })
  assert.equal(git.available, true)
  edit(root, 'a.md', '# A {#aaaa}\n')
  git.schedule('x', HUMAN)
  await git.flush()
  assert.equal(commitCount(root), 2)
  const author = gitOut(root, 'log', '-1', '--format=%an <%ae>')
  assert.equal(author, 'dsh-mainline <mainline@localhost>')
})

test('a person identity is used when configured', async () => {
  const root = makeRoot()
  const env = { ...bareGitEnv(root) }
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Someone\n\temail = s@example.com\n')
  const { git } = await repo({ root, env })
  edit(root, 'a.md', '# A {#aaaa}\n')
  git.schedule('x', HUMAN)
  await git.flush()
  assert.equal(gitOut(root, 'log', '-1', '--format=%an <%ae>'), 'Someone <s@example.com>')
})

test('without git: available is false, scheduling is a no-op, history answers git-unavailable', async () => {
  const root = makeRoot()
  const { git } = await repo({ root, gitBin: 'definitely-not-a-git-binary' })
  assert.equal(git.available, false)
  git.schedule('x', HUMAN)
  await git.flush()
  assert.equal(existsSync(path.join(root, '.git')), false)
  await assert.rejects(() => git.log({}), { code: 'git-unavailable' })
  await assert.rejects(() => git.show('abcd', 'a.md'), { code: 'git-unavailable' })
})

test('log is newest first, can be limited, and can follow one file', async () => {
  const { root, git } = await repo()
  edit(root, 'a.md', '# A {#aaaa}\n')
  git.schedule('加 a', HUMAN)
  await git.flush()
  edit(root, 'b.md', '# B {#bbbb}\n')
  git.schedule('加 b', HUMAN)
  await git.flush()
  const all = await git.log({ limit: 10 })
  assert.deepEqual(all.map((c) => c.message), ['加 b', '加 a', '初始化工作树'])
  assert.match(all[0].rev, /^[0-9a-f]{40}$/)
  assert.equal(all[0].short, all[0].rev.slice(0, all[0].short.length))
  assert.ok(Math.abs(all[0].at - Date.now()) < 60_000)
  assert.equal((await git.log({ limit: 1 })).length, 1)
  assert.deepEqual((await git.log({ file: 'a.md' })).map((c) => c.message), ['加 a'])
})

test('show returns the content at a revision, CJK names included, and refuses odd input', async () => {
  const { root, git } = await repo()
  edit(root, '项目 一.md', '# 一 {#aaaa}\n\n旧\n')
  git.schedule('v1', HUMAN)
  await git.flush()
  const [first] = await git.log({})
  edit(root, '项目 一.md', '# 一 {#aaaa}\n\n新\n')
  git.schedule('v2', HUMAN)
  await git.flush()
  assert.equal(await git.show(first.rev, '项目 一.md'), '# 一 {#aaaa}\n\n旧\n')
  await assert.rejects(() => git.show('--output=x', 'a.md'), { code: 'invalid-request' })
  await assert.rejects(() => git.show(first.rev, '../x'), { code: 'invalid-request' })
  await assert.rejects(() => git.show(first.rev, 'missing.md'), { code: 'not-found' })
})
