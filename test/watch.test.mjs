import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { createStore } from '../lib/store.js'
import { diffTrees, createWatch } from '../lib/watch.js'
import { parse } from '../lib/format.js'
import { makeNode } from '../lib/tree.js'
import { cleanup, makeRoot, sleep, until } from './helpers/env.mjs'

after(cleanup)

const A = '# A {#aaaa}\n\n## 一 {#s1}\n\n正文\n\n## 二 {#s2}\n'

async function watched(files = { 'a.md': A }) {
  const root = makeRoot()
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text)
  const store = createStore({ root })
  await store.load()
  const calls = { edit: [], appear: [], disappear: [], order: 0 }
  const watch = createWatch({
    root,
    store,
    debounceMs: 40,
    onEdit: (e) => calls.edit.push(e),
    onAppear: (e) => calls.appear.push(e),
    onDisappear: (e) => calls.disappear.push(e),
    onOrder: () => (calls.order += 1),
  })
  watch.start()
  return { root, store, watch, calls }
}

test('diffTrees reports added, removed and changed ids (title, state, question, body)', () => {
  const before = parse('# P {#pppp}\n\n## 一 {#s1}\n\n## 二 {#s2}\n\n## 三 {#s3}\n\n## 四 {#s4}\n\n## 五 {#s5}\n', { file: 'p.md' })
  const after = parse('# P {#pppp}\n\n## 一改 {#s1}\n\n## TODO 二 {#s2}\n\n## ? 三 {#s3}\n\n正文\n\n## 四 {#s4}\n\n## 六 {#s6}\n', { file: 'p.md' })
  const diff = diffTrees(before, after)
  assert.deepEqual(diff.added, ['s6'])
  assert.deepEqual(diff.removed, ['s5'])
  assert.deepEqual(diff.changed.sort(), ['s1', 's2', 's3'])
})

test('our own writes never raise an external edit', async () => {
  const { store, watch, calls } = await watched()
  await store.update('aaaa', (tree) => tree.children.push(makeNode({ kind: 'step', title: '我们加的' }, new Set(['aaaa']))))
  await sleep(150)
  await watch.idle()
  assert.deepEqual(calls.edit, [])
  watch.close()
})

test('an editor save is reported with the right ids, once, and the file is left alone', async () => {
  const { root, watch, calls } = await watched()
  const edited = A.replace('## 二 {#s2}', '## 二改 {#s2}').replace('正文', '新正文') + '\n## 新的 {#s3}\n'
  // an editor typically writes twice in a burst; the debounce must fold them
  writeFileSync(path.join(root, 'a.md'), edited)
  writeFileSync(path.join(root, 'a.md'), edited)
  await until(() => calls.edit.length > 0)
  await sleep(150)
  await watch.idle()
  assert.equal(calls.edit.length, 1)
  assert.deepEqual(calls.edit[0], { id: 'aaaa', file: 'a.md', title: 'A', added: ['s3'], removed: [], changed: ['s1', 's2'] })
  assert.equal(readFileSync(path.join(root, 'a.md'), 'utf8'), edited, 'the watcher never writes')
  watch.close()
})

test('a file appearing and disappearing updates the project list', async () => {
  const { root, store, watch, calls } = await watched()
  writeFileSync(path.join(root, '新 项目.md'), '# 新 {#newp}\n')
  await until(() => calls.appear.length > 0)
  assert.equal(calls.appear[0].id, 'newp')
  assert.deepEqual(store.list().map((e) => e.id), ['aaaa', 'newp'])
  rmSync(path.join(root, '新 项目.md'))
  await until(() => calls.disappear.length > 0)
  assert.equal(calls.disappear[0].file, '新 项目.md')
  assert.deepEqual(store.list().map((e) => e.id), ['aaaa'])
  watch.close()
})

test('non-project files are ignored; mainline.json edits are reported as an order change', async () => {
  const { root, store, watch, calls } = await watched({ 'a.md': A, 'b.md': '# B {#bbbb}\n' })
  writeFileSync(path.join(root, 'notes.txt'), 'x')
  writeFileSync(path.join(root, 'mainline.json'), JSON.stringify({ version: 1, order: ['b.md', 'a.md'] }))
  await until(() => calls.order > 0)
  assert.deepEqual(store.list().map((e) => e.id), ['bbbb', 'aaaa'])
  assert.deepEqual([calls.edit, calls.appear, calls.disappear], [[], [], []])
  watch.close()
})

test('a null filename (some platforms) falls back to scanning everything', async () => {
  const root = makeRoot()
  writeFileSync(path.join(root, 'a.md'), A)
  const store = createStore({ root })
  await store.load()
  const calls = []
  let fire
  const watch = createWatch({
    root,
    store,
    debounceMs: 20,
    watchFn: (_dir, _opts, cb) => ((fire = cb), { close() {}, on() {} }),
    onEdit: (e) => calls.push(e),
  })
  watch.start()
  writeFileSync(path.join(root, 'a.md'), A + '\n## 新 {#s9}\n')
  fire('rename', null)
  await until(() => calls.length > 0)
  assert.deepEqual(calls[0].added, ['s9'])
  watch.close()
})

test('close stops reporting', async () => {
  const { root, watch, calls } = await watched()
  watch.close()
  writeFileSync(path.join(root, 'a.md'), A + '\n## 晚了 {#late}\n')
  await sleep(200)
  assert.deepEqual(calls.edit, [])
})
