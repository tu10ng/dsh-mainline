import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { makeNode } from '../lib/tree.js'
import { createStore, fileNameFor, revOf } from '../lib/store.js'
import { cleanup, makeRoot } from './helpers/env.mjs'

after(cleanup)

const put = (root, name, text) => writeFileSync(path.join(root, name), text)
const get = (root, name) => readFileSync(path.join(root, name), 'utf8')
const step = (title) => (tree) => {
  tree.children.push(makeNode({ kind: 'step', title }, new Set([tree.id])))
}

async function opened(files = {}, order) {
  const root = makeRoot()
  for (const [name, text] of Object.entries(files)) put(root, name, text)
  if (order) put(root, 'mainline.json', JSON.stringify({ version: 1, order }))
  const store = createStore({ root })
  const result = await store.load()
  return { root, store, result }
}

test('fileNameFor replaces illegal characters, clips, trims and de-duplicates', () => {
  const none = new Set()
  assert.equal(fileNameFor('a/b:c*d?e"f<g>h|i#j{k}l', none), 'a-b-c-d-e-f-g-h-i-j-k-l.md')
  assert.equal(fileNameFor('  两种   主控  ', none), '两种-主控.md')
  assert.equal(fileNameFor('', none), 'project.md')
  assert.equal(fileNameFor('...', none), 'project.md')
  assert.equal(fileNameFor('NUL', none), 'NUL-.md')
  assert.equal(Array.from(fileNameFor('字'.repeat(100), none)).length, 60 + 3)
  assert.equal(fileNameFor('BLOG', new Set(['blog.md'])), 'BLOG-2.md')
  assert.equal(fileNameFor('BLOG', new Set(['blog.md', 'blog-2.md'])), 'BLOG-3.md')
})

test('load adopts files missing from the order, drops stale names and persists the result', async () => {
  const { root, store, result } = await opened(
    { 'b.md': '# B {#bbbb}\n', 'a.md': '# A {#aaaa}\n', 'c.md': '# C {#cccc}\n' },
    ['c.md', 'gone.md'],
  )
  assert.deepEqual(store.list().map((e) => e.file), ['c.md', 'a.md', 'b.md'])
  assert.equal(result.changed, true)
  assert.deepEqual(JSON.parse(get(root, 'mainline.json')), { version: 1, order: ['c.md', 'a.md', 'b.md'] })
  assert.ok(existsSync(path.join(root, '.mainline', 'view')))
})

test('a project id is its root id; CRLF and BOM files read fine; non-md files are ignored', async () => {
  const { store } = await opened({ 'crlf.md': '﻿# 标题 {#crlf}\r\n\r\n正文\r\n\r\n## 步骤 {#s1}\r\n', 'notes.txt': 'x', 'README.MD': '# R {#rrrr}\n' })
  const entry = store.get('crlf')
  assert.equal(entry.root.title, '标题')
  assert.equal(entry.root.body, '正文')
  assert.equal(entry.root.children[0].id, 's1')
  assert.deepEqual(store.list().map((e) => e.file).sort(), ['README.MD', 'crlf.md'])
})

test('an empty root loads without writing mainline.json', async () => {
  const { root } = await opened()
  assert.equal(existsSync(path.join(root, 'mainline.json')), false)
})

test('two files with the same root id get distinct, stable ids', async () => {
  const text = '# Same {#same}\n'
  const { store } = await opened({ 'one.md': text, 'two.md': text })
  const ids = store.list().map((e) => e.id)
  assert.equal(new Set(ids).size, 2)
  assert.ok(ids.includes('same'))
  const again = createStore({ root: store.root })
  await again.load()
  assert.deepEqual(again.list().map((e) => e.id), ids)
})

test('update writes through, refreshes the cache, and a no-op writes nothing', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n' })
  const before = store.get('aaaa').rev
  const { entry, wrote } = await store.update('aaaa', step('一'))
  assert.equal(wrote, true)
  assert.notEqual(entry.rev, before)
  assert.equal(entry.rev, revOf(get(root, 'a.md')))
  assert.equal(store.get('aaaa').root.children.length, 1)
  assert.match(get(root, 'a.md'), /^# A \{#aaaa\}\n\n## 一 \{#\w+\}\n$/)
  const noop = await store.update('aaaa', () => ({ noop: true }))
  assert.equal(noop.wrote, false)
  assert.deepEqual(readdirSync(root).filter((n) => n.endsWith('.tmp')), [])
})

test('a mutation that throws writes nothing and frees the lock', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n' })
  await assert.rejects(() => store.update('aaaa', () => { throw new Error('nope') }), /nope/)
  assert.equal(get(root, 'a.md'), '# A {#aaaa}\n')
  await store.update('aaaa', step('ok'))
  assert.equal(existsSync(path.join(root, '.mainline', 'lock')), false)
  await assert.rejects(() => store.update('zzzz', step('x')), { code: 'not-found' })
})

test('two stores on one root (two processes) never lose a change', async () => {
  const { root, store: first } = await opened({ 'a.md': '# A {#aaaa}\n' })
  const second = createStore({ root })
  await second.load()
  const jobs = []
  for (let i = 0; i < 12; i += 1) {
    jobs.push(first.update('aaaa', step(`一${i}`)))
    jobs.push(second.update('aaaa', step(`二${i}`)))
  }
  await Promise.all(jobs)
  const titles = readFileSync(path.join(root, 'a.md'), 'utf8').match(/^## .+$/gm).map((l) => l.replace(/^## | \{.*$/g, ''))
  assert.equal(titles.length, 24)
  for (let i = 0; i < 12; i += 1) assert.ok(titles.includes(`一${i}`) && titles.includes(`二${i}`))
})

test('an editor save between our read and our write is not overwritten: the mutation runs again on the new text', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n\n## 旧 {#s1}\n' })
  let runs = 0
  await store.update('aaaa', (tree) => {
    runs += 1
    if (runs === 1) put(root, 'a.md', '# A {#aaaa}\n\n## 旧 {#s1}\n\n## 人写的 {#h1}\n')
    tree.children.push(makeNode({ kind: 'step', title: '我加的' }, new Set(['aaaa', 's1', 'h1'])))
  })
  assert.equal(runs, 2)
  const text = get(root, 'a.md')
  assert.ok(text.includes('## 人写的 {#h1}'), 'the editor change survived')
  assert.ok(text.includes('## 我加的'), 'ours was applied on top')
  assert.equal(store.get('aaaa').root.children.length, 3)
})

test('a file that keeps changing under us ends in store-busy, never in a lost edit', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n' })
  let n = 0
  await assert.rejects(
    () => store.update('aaaa', () => put(root, 'a.md', `# A {#aaaa}\n\n## ${n++} {#s${n}}\n`)),
    { code: 'store-busy' },
  )
  assert.equal(n, 3)
  assert.ok(get(root, 'a.md').includes('## 2'))
})

test('renaming a project never renames its file', async () => {
  const { root, store } = await opened({ 'old.md': '# Old {#oldd}\n' })
  await store.update('oldd', (tree) => { tree.title = '全新的名字' })
  assert.equal(store.get('oldd').file, 'old.md')
  assert.deepEqual(readdirSync(root).filter((n) => n.endsWith('.md')), ['old.md'])
  assert.ok(get(root, 'old.md').startsWith('# 全新的名字 {#oldd}'))
})

test('createProject picks a safe unique name, appends to the order and persists it', async () => {
  const { root, store } = await opened({ 'BLOG.md': '# L {#llll}\n' })
  const a = await store.createProject({ title: 'BLOG', build: () => makeNode({ kind: 'project', title: 'BLOG' }, new Set(['llll'])) })
  const b = await store.createProject({ title: '两种: 主控?', build: () => makeNode({ kind: 'project', title: '两种: 主控?' }, new Set()) })
  assert.equal(a.file, 'BLOG-2.md')
  assert.equal(b.file, '两种-主控.md')
  assert.deepEqual(JSON.parse(get(root, 'mainline.json')).order, ['BLOG.md', 'BLOG-2.md', '两种-主控.md'])
  assert.equal(store.get(b.id).root.title, '两种: 主控?')
})

test('createProject never reuses a name that differs only by case', async () => {
  const { store } = await opened({ 'blog.md': '# L {#llll}\n' })
  const entry = await store.createProject({ title: 'BLOG', build: () => makeNode({ kind: 'project', title: 'BLOG' }, new Set(['llll'])) })
  assert.equal(entry.file, 'BLOG-2.md')
})

test('removeProject moves the file to .mainline/trash and drops it from the order', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n', 'b.md': '# B {#bbbb}\n' })
  await store.removeProject('aaaa')
  assert.equal(existsSync(path.join(root, 'a.md')), false)
  assert.deepEqual(readdirSync(path.join(root, '.mainline', 'trash')).map((n) => n.split('.md')[0]), ['a'])
  assert.deepEqual(JSON.parse(get(root, 'mainline.json')).order, ['b.md'])
  assert.equal(store.find('aaaa'), null)
})

test('reorder puts the listed projects first and keeps the rest in order', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n', 'b.md': '# B {#bbbb}\n', 'c.md': '# C {#cccc}\n' })
  const result = await store.reorder(['cccc'])
  assert.deepEqual(result.order, ['cccc', 'aaaa', 'bbbb'])
  assert.deepEqual(JSON.parse(get(root, 'mainline.json')).order, ['c.md', 'a.md', 'b.md'])
  assert.equal((await store.reorder(['cccc'])).changed, false)
  await assert.rejects(() => store.reorder(['nope']), { code: 'not-found' })
})

test('refresh: our own write is not an external change, an editor save is', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n' })
  await store.update('aaaa', step('我们的'))
  assert.equal((await store.refresh('a.md')).type, 'none')
  put(root, 'a.md', get(root, 'a.md') + '\n## 外部的 {#ext1}\n')
  const change = await store.refresh('a.md')
  assert.equal(change.type, 'changed')
  assert.equal(change.entry.root.children.length, 2)
  assert.equal(store.get('aaaa').root.children.length, 2)
  put(root, 'new.md', '# New {#newn}\n')
  assert.equal((await store.refresh('new.md')).type, 'added')
  assert.equal(store.list().at(-1).id, 'newn')
  rmSync(path.join(root, 'new.md'))
  assert.equal((await store.refresh('new.md')).type, 'removed')
  assert.equal((await store.refresh('new.md')).type, 'none')
})

test('a missing project file is not-found, not a crash', async () => {
  const { root, store } = await opened({ 'a.md': '# A {#aaaa}\n' })
  rmSync(path.join(root, 'a.md'))
  await assert.rejects(() => store.update('aaaa', step('x')), { code: 'not-found' })
})

test('a damaged mainline.json does not hide the projects', async () => {
  const root = makeRoot()
  put(root, 'a.md', '# A {#aaaa}\n')
  put(root, 'mainline.json', '{ not json')
  const store = createStore({ root, logger: { warn() {} } })
  await store.load()
  assert.deepEqual(store.list().map((e) => e.id), ['aaaa'])
})
