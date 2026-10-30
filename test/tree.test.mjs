import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KINDS, STATES, canContain, refsOf, lineOf, isLive, walk, findNode, newId, counts, describePath, clone, makeNode,
} from '../lib/tree.js'

const P = 'NAS 迁移到 ZFS：旧盘换新盘、两台机器与…'
let seq = 0
const n = (kind, title, o = {}) => ({
  id: o.id ?? `t${String(++seq).padStart(3, '0')}`,
  kind,
  title,
  state: o.state ?? '',
  question: Boolean(o.question),
  body: o.body ?? '',
  attrs: {},
  children: o.children ?? [],
  ...(kind === 'project' ? { preamble: '' } : {}),
})

function sample() {
  const nasBSteps = [n('step', 'nas-b c'), n('step', '清点旧盘'), n('step', '换盘', { id: 'patc', state: 'todo', children: [n('ref', '校验', { id: 'sign', children: [n('ref', '服务地址', { id: 'addr' })] })] })]
  const fork = n('fork', '两台机器', { id: 'fork', children: [
    n('lane', 'nas-a', { id: 'lanv', children: [n('step', 'nas-a c', { id: 'mvc1' })] }),
    n('lane', 'nas-b', { id: 'lanq', children: nasBSteps }),
    n('ref', '分叉参考', { id: 'frk1' }),
  ] })
  return n('project', 'NAS 迁移到 ZFS：旧盘换新盘、两台机器与回滚预案的完整记录', { id: 'proj', children: [
    n('ref', '设计文档', { id: 'ref1' }),
    n('step', '头文件', { id: 'step1', state: 'halt' }),
    fork,
    n('step', '一个非常非常长的步骤标题用来测试裁剪行为', { id: 'long', question: true, state: 'todo' }),
  ] })
}

test('KINDS and STATES are the contract lists', () => {
  assert.deepEqual([...KINDS], ['project', 'step', 'fork', 'lane', 'ref'])
  assert.deepEqual([...STATES], ['', 'todo', 'halt'])
})

test('canContain follows the SPEC 1.2 table exactly', () => {
  const table = {
    project: ['step', 'fork', 'ref'],
    step: ['step', 'fork', 'ref'],
    fork: ['lane', 'ref'],
    lane: ['step', 'fork', 'ref'],
    ref: ['ref'],
  }
  for (const parent of KINDS) {
    for (const child of KINDS) assert.equal(canContain(parent, child), table[parent].includes(child), `${parent} > ${child}`)
  }
  assert.equal(canContain('nope', 'step'), false)
  assert.equal(canContain('step', 'toString'), false)
})

test('refsOf and lineOf partition the children in file order', () => {
  const root = sample()
  assert.deepEqual(refsOf(root).map((c) => c.id), ['ref1'])
  assert.deepEqual(lineOf(root).map((c) => c.id), ['step1', 'fork', 'long'])
  assert.deepEqual(lineOf(findNode(root, 'fork').node).map((c) => c.id), ['lanv', 'lanq'])
})

test('isLive: todo steps, containers of them, never through a halted step or a ref', () => {
  const root = sample()
  assert.equal(isLive(root), true)
  assert.equal(isLive(findNode(root, 'patc').node), true)
  assert.equal(isLive(findNode(root, 'lanq').node), true)
  assert.equal(isLive(findNode(root, 'lanv').node), false)
  assert.equal(isLive(findNode(root, 'fork').node), true)
  assert.equal(isLive(findNode(root, 'step1').node), false)

  const halted = n('step', 'h', { state: 'halt', children: [n('step', 'inside', { state: 'todo' })] })
  assert.equal(isLive(halted), false)
  const holder = n('step', 'p', { children: [n('ref', 'r', { state: 'todo' })] })
  assert.equal(isLive(holder), false)
  const chapter = n('step', 'p', { children: [n('step', 'c', { children: [n('step', 'deep', { state: 'todo' })] })] })
  assert.equal(isLive(chapter), true)
  const haltedProject = n('project', 'P', { state: 'halt', children: [n('step', 's', { state: 'todo' })] })
  assert.equal(isLive(haltedProject), false)
})

test('walk is pre-order with parent and depth (root 0); false prunes', () => {
  const root = sample()
  const seen = []
  walk(root, (node, parent, depth) => { seen.push(`${depth}:${node.id}:${parent?.id ?? '-'}`) })
  assert.deepEqual(seen.slice(0, 6), ['0:proj:-', '1:ref1:proj', '1:step1:proj', '1:fork:proj', '2:lanv:fork', '3:mvc1:lanv'])
  assert.equal(seen.at(-1).startsWith('1:long'), true)

  const pruned = []
  walk(root, (node) => { pruned.push(node.id); return node.id === 'fork' ? false : undefined })
  assert.ok(pruned.includes('fork'))
  assert.ok(!pruned.includes('lanv'))
  assert.ok(pruned.includes('long'))
})

test('findNode returns node, parent, children index and the ancestors root first', () => {
  const root = sample()
  const hit = findNode(root, 'addr')
  assert.equal(hit.node.title, '服务地址')
  assert.equal(hit.parent.id, 'sign')
  assert.equal(hit.index, 0)
  assert.deepEqual(hit.path.map((x) => x.id), ['proj', 'fork', 'lanq', 'patc', 'sign'])
  const top = findNode(root, 'proj')
  assert.equal(top.parent, null)
  assert.equal(top.index, -1)
  assert.deepEqual(top.path, [])
  assert.equal(findNode(root, 'missing'), null)
  assert.equal(findNode(root, 'long').index, 3)
})

test('newId: 4 chars [a-z0-9], registered, unique, grows on collisions', () => {
  const used = new Set()
  for (let i = 0; i < 500; i += 1) {
    const id = newId(used)
    assert.match(id, /^[a-z0-9]{4}$/)
  }
  assert.equal(used.size, 500)

  class Crowded extends Set {
    has(id) { return id.length < 8 || super.has(id) }
  }
  const crowded = new Crowded()
  const id = newId(crowded)
  assert.match(id, /^[a-z0-9]{8}$/)
  assert.ok(Set.prototype.has.call(crowded, id))
})

test('counts: steps only for todo/halt/steps, questions over every node', () => {
  const root = sample()
  assert.deepEqual(counts(root), { todo: 2, halt: 1, steps: 6, questions: 1 })
  assert.deepEqual(counts(n('project', 'empty', { state: 'todo' })), { todo: 0, halt: 0, steps: 0, questions: 0 })
  const q = n('project', 'q', { children: [n('ref', 'r', { question: true }), n('step', 's', { question: true })] })
  assert.equal(counts(q).questions, 2)
})

test('describePath: steps in lanes, chapters, refs, clipping', () => {
  const root = sample()
  assert.equal(describePath(root, 'patc'), `${P} › 两台机器 › nas-b › 换盘（第 3 步）`)
  assert.equal(describePath(root, 'proj'), `${P}`)
  assert.equal(describePath(root, 'step1'), `${P} › 头文件（第 1 步）`)
  assert.equal(describePath(root, 'lanq'), `${P} › 两台机器 › nas-b`)
  assert.equal(describePath(root, 'fork'), `${P} › 两台机器`)
  assert.equal(describePath(root, 'ref1'), `${P} › 设计文档（参考）`)
  assert.equal(describePath(root, 'addr'), `${P} › 两台机器 › nas-b › 换盘 › 校验 › 服务地址（参考）`)
  assert.equal(describePath(root, 'long'), `${P} › 一个非常非常长的步骤标题用来测试裁剪行为（第 3 步）`)
  assert.equal(describePath(root, 'nope'), '')
})

test('describePath: the short example from the spec, clipping and untitled forks', () => {
  const lane = n('lane', 'nas-b', { id: 'lq', children: [n('step', 'a'), n('step', 'b'), n('step', '换盘', { id: 'pp' })] })
  const root = n('project', 'NAS→ZFS', { children: [n('fork', '两台机器', { children: [lane] })] })
  assert.equal(describePath(root, 'pp'), 'NAS→ZFS › 两台机器 › nas-b › 换盘（第 3 步）')

  const anon = n('project', 'P', { children: [n('fork', '', { id: 'f0', children: [n('lane', 'L', { id: 'l0', children: [n('step', 'x'.repeat(30), { id: 's0' })] })] })] })
  assert.equal(describePath(anon, 's0'), `P › L › ${'x'.repeat(23)}…（第 1 步）`)
  assert.equal(describePath(anon, 'f0'), 'P › （分叉）')
  const bare = n('project', 'P', { children: [n('fork', '', { children: [n('lane', '', { id: 'l9', children: [n('step', '另一件事', { id: 's9' })] })] })] })
  assert.equal(describePath(bare, 's9'), 'P › 另一件事（第 1 步）', 'an unnamed lane is only a split too')
  assert.equal(describePath(bare, 'l9'), 'P › （未命名）', 'but the lane itself still has a label')

  const deepStep = n('step', 'y'.repeat(25), { id: 'd1', children: [n('step', 'inner', { id: 'd2' })] })
  assert.equal(describePath(n('project', 'P', { children: [deepStep] }), 'd2'), `P › ${'y'.repeat(17)}… › inner（第 1 步）`)
})

test('clone is a deep copy', () => {
  const root = sample()
  const copy = clone(root)
  assert.deepEqual(copy, root)
  copy.children[1].title = 'changed'
  copy.attrs.cwd = 'x'
  assert.equal(root.children[1].title, '头文件')
  assert.deepEqual(root.attrs, {})
  assert.notEqual(copy.children, root.children)
})

test('makeNode fills defaults, registers ids and validates', () => {
  const used = new Set(['keep'])
  const a = makeNode({ kind: 'step', title: '  one\nline  ' }, used)
  assert.deepEqual({ ...a, id: undefined }, { id: undefined, kind: 'step', title: 'one line', state: '', question: false, body: '', attrs: {}, children: [] })
  assert.ok(used.has(a.id))
  const kept = makeNode({ kind: 'ref', title: 'r', id: 'fixd' }, used)
  assert.equal(kept.id, 'fixd')
  const clash = makeNode({ kind: 'ref', title: 'r', id: 'fixd' }, used)
  assert.notEqual(clash.id, 'fixd')
  assert.equal(makeNode({ kind: 'project', title: 'P' }).preamble, '')
  assert.throws(() => makeNode({ kind: 'bogus', title: 'x' }), { code: 'invalid-kind' })
  assert.throws(() => makeNode({ kind: 'step', title: 'x', state: 'done' }), { code: 'invalid-state' })
  assert.throws(() => makeNode(null), { code: 'invalid-op' })
  const withAttrs = makeNode({ kind: 'project', title: 'P', attrs: { cwd: 'D:/x' }, state: 'todo', question: 1 })
  assert.deepEqual(withAttrs.attrs, { cwd: 'D:/x' })
  assert.equal(withAttrs.question, true)
})
