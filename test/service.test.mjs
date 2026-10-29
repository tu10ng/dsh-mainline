import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { createEvents } from '../lib/events.js'
import { createService } from '../lib/service.js'
import { AGENT, HUMAN, boot, cleanup, commitCount, gitOut, makeRoot, track, until } from './helpers/env.mjs'

after(cleanup)

const WALK = [
  '# Homelab {#proj}',
  '',
  '## REF 设计文档 {#d1}',
  '',
  '## 开头 {#s1}',
  '',
  '### 子步骤 {#c1}',
  '',
  '## FORK 两台机器 {#f1}',
  '',
  '### nas-a {#l1}',
  '',
  '#### nas-a 步骤 {#s2}',
  '',
  '### nas-b {#l2}',
  '',
  '## 收尾 {#s3}',
  '',
].join('\n')

/** A root holding one walkthrough: with a fake git that records what was scheduled, or with the real one. */
async function rig(options = {}) {
  const root = makeRoot()
  writeFileSync(path.join(root, 'homelab.md'), WALK)
  if (options.realGit) {
    const env = await boot({ root })
    // let the startup commit land first, so a later assertion about the latest commit is about the op under test
    await env.git.flush()
    return { ...env, scheduled: [] }
  }
  const scheduled = []
  const git = { available: true, schedule: (summary, actor) => scheduled.push([summary, actor]), flush: async () => {}, init: async () => {}, dirty: async () => false }
  const published = []
  const events = createEvents({ file: path.join(root, '.mainline', 'events.jsonl') })
  events.subscribe((e) => published.push(e))
  const service = track(createService({ root, events, git, watchDebounceMs: 30 }))
  await service.ready()
  // adopting the folder schedules a tidy-up commit; the tests below count what *they* cause
  scheduled.length = 0
  published.length = 0
  return { root, events, git, service, published, scheduled }
}

const apply = (s, op, actor = HUMAN) => s.apply(op, actor)

test('create appends, inserts first, inserts after a sibling, and returns the new id', async () => {
  const { service, scheduled } = await rig()
  const end = await apply(service, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: '  末尾\n步  ' })
  assert.equal(service.locate('proj', end.nodeId).node.title, '末尾 步')
  const first = await apply(service, { type: 'create', project: 'proj', parent: 'proj', after: '', kind: 'step', title: '最前' })
  const mid = await apply(service, { type: 'create', project: 'proj', parent: 'proj', after: 's1', kind: 'step', title: '中间', state: 'todo', question: true, body: '说明\r\n', attrs: { cwd: 'D:/x y' } })
  const kids = service.getProject('proj').root.children.map((c) => c.id)
  assert.deepEqual([kids[0], kids[kids.indexOf('s1') + 1], kids.at(-1)], [first.nodeId, mid.nodeId, end.nodeId])
  const node = service.locate('proj', mid.nodeId).node
  assert.deepEqual([node.state, node.question, node.body, node.attrs], ['todo', true, '说明', { cwd: 'D:/x y' }])
  assert.match(end.events[0].summary, /^添加了步骤：Homelab › 末尾 步（第 \d+ 步）$/)
  assert.equal(end.events[0].type, 'node/created')
  assert.equal(end.project.root.id, 'proj')
  assert.equal(scheduled.length, 3)
  assert.equal(scheduled[0][1].kind, 'human')
})

test('the kind table and the placement rules are enforced', async () => {
  const { service } = await rig()
  const bad = (op, code) => assert.rejects(() => apply(service, { type: 'create', project: 'proj', ...op }), { code })
  await bad({ parent: 'proj', kind: 'lane', title: 'x' }, 'invalid-kind')
  await bad({ parent: 'f1', kind: 'step', title: 'x' }, 'invalid-kind')
  await bad({ parent: 'd1', kind: 'step', title: 'x' }, 'invalid-kind')
  await bad({ parent: 'proj', kind: 'project', title: 'x' }, 'invalid-kind')
  await bad({ parent: 'proj', kind: 'bogus', title: 'x' }, 'invalid-kind')
  await bad({ parent: 'nope', kind: 'step', title: 'x' }, 'not-found')
  await bad({ parent: 'proj', after: 'c1', kind: 'step', title: 'x' }, 'invalid-op')
  const ok = await apply(service, { type: 'create', project: 'proj', parent: 'f1', kind: 'lane', title: '第三条' })
  assert.equal(service.locate('proj', ok.nodeId).node.kind, 'lane')
  await apply(service, { type: 'create', project: 'proj', parent: 'd1', kind: 'ref', title: '嵌套参考' })
  await apply(service, { type: 'create', project: 'proj', parent: 'proj', kind: 'fork', title: '' })
})

test('validation uses the SPEC codes', async () => {
  const { service } = await rig()
  const create = (extra) => apply(service, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: 't', ...extra })
  await assert.rejects(() => create({ title: '   ' }), { code: 'invalid-title' })
  await assert.rejects(() => create({ title: 'x'.repeat(301) }), { code: 'invalid-title' })
  await assert.rejects(() => create({ title: 5 }), { code: 'invalid-title' })
  await assert.rejects(() => create({ body: 'x'.repeat(100_001) }), { code: 'invalid-content' })
  await assert.rejects(() => create({ state: 'done' }), { code: 'invalid-state' })
  await assert.rejects(() => create({ attrs: { a: 'x\ny' } }), { code: 'invalid-attrs' })
  await assert.rejects(() => create({ attrs: { 'bad key': 'x' } }), { code: 'invalid-attrs' })
  await assert.rejects(() => create({ attrs: { a: 1 } }), { code: 'invalid-attrs' })
  await assert.rejects(() => create({ question: 'yes' }), { code: 'invalid-op' })
  await create({ title: 'x'.repeat(300), body: 'x'.repeat(100_000) })
})

test('unknown ops, unknown keys and missing fields are invalid-op', async () => {
  const { service } = await rig()
  const bad = (op) => assert.rejects(() => apply(service, op), { code: 'invalid-op' })
  await bad(null)
  await bad({})
  await bad({ type: 'explode' })
  await bad({ type: 'toString' })
  await bad({ type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: 't', parnet: 'x' })
  await bad({ type: 'update', project: 'proj', id: 's1', patch: { titel: 'x' } })
  await bad({ type: 'update', project: 'proj', id: 's1' })
  await bad({ type: 'update', project: 'proj', patch: { title: 'x' } })
  await bad({ type: 'move', project: 'proj', id: 's1', parent: 'proj', extra: 1 })
  await bad({ type: 'remove', project: 'proj' })
  await bad({ type: 'reorderProjects', order: 'x' })
  await bad({ type: 'fork', project: 'proj', after: 's1', lanes: ['only one'] })
  await assert.rejects(() => apply(service, { type: 'remove', project: 'nope', id: 'x' }), { code: 'not-found' })
})

test('update changes fields, reports before/after, and a no-op makes no event and no commit', async () => {
  const { service, scheduled, published } = await rig()
  const result = await apply(service, { type: 'update', project: 'proj', id: 's1', patch: { title: '开头改', state: 'halt', question: true, body: '一些正文', attrs: { cwd: '/w' } } })
  const node = service.locate('proj', 's1').node
  assert.deepEqual([node.title, node.state, node.question, node.body, node.attrs], ['开头改', 'halt', true, '一些正文', { cwd: '/w' }])
  const [event] = result.events
  assert.equal(event.type, 'node/updated')
  assert.deepEqual(event.data.fields, ['title', 'state', 'question', 'body', 'attrs'])
  assert.deepEqual(event.data.before.body, 0)
  assert.deepEqual(event.data.after.body, 4)
  assert.equal(event.data.before.title, '开头')
  assert.match(event.summary, /开头改/)
  const count = scheduled.length
  const events = published.length
  const again = await apply(service, { type: 'update', project: 'proj', id: 's1', patch: { title: '开头改', state: 'halt' } })
  assert.deepEqual(again.events, [])
  assert.equal(scheduled.length, count)
  assert.equal(published.length, events)
  await apply(service, { type: 'update', project: 'proj', id: 's1', patch: { attrs: {} } })
  assert.deepEqual(service.locate('proj', 's1').node.attrs, {})
})

test('update accepts append and setAttrs, computed under the lock, and refuses the ambiguous pairs', async () => {
  const { service } = await rig()
  const update = (patch, id = 's1') => apply(service, { type: 'update', project: 'proj', id, patch })
  await update({ append: '第一段' })
  const second = await update({ append: '第二段\n' })
  assert.equal(service.locate('proj', 's1').node.body, '第一段\n\n第二段')
  assert.deepEqual(second.events[0].data.fields, ['body'])
  await update({ attrs: { a: '1', b: '2' } })
  const merged = await update({ setAttrs: { b: null, c: '3' } })
  assert.deepEqual(service.locate('proj', 's1').node.attrs, { a: '1', c: '3' })
  assert.deepEqual(merged.events[0].data.fields, ['attrs'])
  assert.deepEqual((await update({ setAttrs: { zzz: null } })).events, [])
  assert.deepEqual((await update({ append: '' })).events, [])
  await assert.rejects(() => update({ body: 'x', append: 'y' }), { code: 'invalid-op' })
  await assert.rejects(() => update({ attrs: {}, setAttrs: {} }), { code: 'invalid-op' })
  await assert.rejects(() => update({ setAttrs: { a: 'x\ny' } }), { code: 'invalid-attrs' })
  await assert.rejects(() => update({ append: 'x'.repeat(100_001) }), { code: 'invalid-content' })
  // the point of the pair: concurrent appends never lose a paragraph
  await Promise.all(Array.from({ length: 8 }, (_, i) => update({ append: `并发${i}` })))
  const body = service.locate('proj', 's1').node.body
  for (let i = 0; i < 8; i += 1) assert.ok(body.includes(`并发${i}`))
})

test('an empty title is refused except on a fork', async () => {
  const { service } = await rig()
  await assert.rejects(() => apply(service, { type: 'update', project: 'proj', id: 's1', patch: { title: ' ' } }), { code: 'invalid-title' })
  await apply(service, { type: 'update', project: 'proj', id: 'f1', patch: { title: '' } })
  assert.equal(service.locate('proj', 'f1').node.title, '')
})

test('move reorders, re-parents, and refuses what the model could use to corrupt the tree', async () => {
  const { service } = await rig()
  const move = (op) => apply(service, { type: 'move', project: 'proj', ...op })
  const done = await move({ id: 's3', parent: 'proj', after: '' })
  assert.equal(service.getProject('proj').root.children[0].id, 's3')
  assert.equal(done.events[0].type, 'node/moved')
  assert.equal(done.events[0].data.toParent, 'proj')
  await move({ id: 's3', parent: 'l2' })
  assert.equal(service.locate('proj', 's3').parent.id, 'l2')
  assert.deepEqual((await move({ id: 's3', parent: 'l2' })).events, [], 'same place is a no-op')
  await assert.rejects(() => move({ id: 'f1', parent: 'f1' }), { code: 'invalid-move' })
  await assert.rejects(() => move({ id: 'f1', parent: 's2' }), { code: 'invalid-move' })
  await assert.rejects(() => move({ id: 'proj', parent: 's1' }), { code: 'invalid-move' })
  await assert.rejects(() => move({ id: 's1', parent: 'f1' }), { code: 'invalid-move' })
  await assert.rejects(() => move({ id: 'l1', parent: 'proj' }), { code: 'invalid-move' })
  await assert.rejects(() => move({ id: 's1', parent: 'proj', after: 's1' }), { code: 'invalid-move' })
  await assert.rejects(() => move({ id: 's1', parent: 'nope' }), { code: 'not-found' })
  assert.ok(service.locate('proj', 's1'), 'a refused move changes nothing')
})

test('remove returns the subtree and insert puts it back, ids intact', async () => {
  const { service } = await rig()
  const gone = await apply(service, { type: 'remove', project: 'proj', id: 'f1' })
  assert.equal(gone.removed.id, 'f1')
  assert.equal(gone.project.root.children.some((c) => c.id === 'f1'), false)
  assert.equal(gone.events[0].data.count, 4)
  assert.equal(service.locate('proj', 's2'), null)
  await assert.rejects(() => apply(service, { type: 'remove', project: 'proj', id: 'proj' }), { code: 'invalid-op' })
  const back = await apply(service, { type: 'insert', project: 'proj', parent: 'proj', after: 's1', node: gone.removed })
  assert.equal(back.nodeId, 'f1')
  assert.ok(service.locate('proj', 's2'))
  const kids = service.getProject('proj').root.children.map((c) => c.id)
  assert.equal(kids[kids.indexOf('s1') + 1], 'f1')
})

test('insert regenerates colliding ids, also inside the subtree, and validates kinds', async () => {
  const { service } = await rig()
  const subtree = { kind: 'step', id: 's1', title: '副本', children: [{ kind: 'step', id: 'c1', title: '子' }, { kind: 'step', id: 'c1', title: '同 id 的兄弟' }] }
  const result = await apply(service, { type: 'insert', project: 'proj', parent: 'proj', node: subtree })
  assert.notEqual(result.nodeId, 's1')
  const copy = service.locate('proj', result.nodeId).node
  assert.equal(copy.children.length, 2)
  const ids = []
  const collect = (n) => (ids.push(n.id), n.children.forEach(collect))
  collect(service.getProject('proj').root)
  assert.equal(new Set(ids).size, ids.length)
  await assert.rejects(() => apply(service, { type: 'insert', project: 'proj', parent: 'proj', node: { kind: 'lane', title: 'x' } }), { code: 'invalid-kind' })
  await assert.rejects(() => apply(service, { type: 'insert', project: 'proj', parent: 'proj', node: { kind: 'step', title: 'x', children: [{ kind: 'lane', title: 'y' }] } }), { code: 'invalid-kind' })
  await assert.rejects(() => apply(service, { type: 'insert', project: 'proj', parent: 'proj', node: 'x' }), { code: 'invalid-op' })
})

test('fork inserts a fork after a step with one empty lane per name', async () => {
  const { service } = await rig()
  const result = await apply(service, { type: 'fork', project: 'proj', after: 's1', title: '两个环境', lanes: ['甲', '乙', '丙'] })
  const fork = service.locate('proj', result.nodeId)
  assert.equal(fork.node.kind, 'fork')
  assert.deepEqual(fork.node.children.map((l) => [l.kind, l.title, l.children.length]), [['lane', '甲', 0], ['lane', '乙', 0], ['lane', '丙', 0]])
  assert.equal(fork.parent.children[fork.index - 1].id, 's1')
  assert.match(result.events[0].summary, /甲、乙、丙/)
  await apply(service, { type: 'fork', project: 'proj', after: 's2', lanes: ['a', 'b'] })
  await assert.rejects(() => apply(service, { type: 'fork', project: 'proj', after: 'd1', lanes: ['a', 'b'] }), { code: 'invalid-kind' })
  await assert.rejects(() => apply(service, { type: 'fork', project: 'proj', after: 'l1', lanes: ['a', 'b'] }), { code: 'invalid-kind' })
  await assert.rejects(() => apply(service, { type: 'fork', project: 'proj', after: 's1', lanes: ['a', ' '] }), { code: 'invalid-title' })
})

test('createProject: a title makes a file, markdown imports, ids are unique across projects', async () => {
  const { service, root } = await rig()
  const made = await apply(service, { type: 'createProject', title: '新 项目/一', body: '说明' })
  const entry = service.getProject(made.nodeId)
  assert.equal(entry.file, '新-项目-一.md')
  assert.equal(entry.root.body, '说明')
  assert.equal(made.events[0].type, 'project/created')
  assert.deepEqual(service.listProjects().map((p) => p.id), ['proj', made.nodeId])
  assert.ok(readFileSync(path.join(root, entry.file), 'utf8').startsWith('# 新 项目/一 {#'))

  const imported = await apply(service, { type: 'createProject', title: '导入', markdown: '# 别的标题 {#proj}\n\n## 步骤 {#x1}\n\n## TODO 要做 {#x2}\n' })
  assert.notEqual(imported.nodeId, 'proj', 'a taken project id is replaced')
  const project = service.getProject(imported.nodeId)
  assert.equal(project.root.title, '导入')
  assert.deepEqual(project.root.children.map((c) => [c.id, c.state]), [['x1', ''], ['x2', 'todo']])
  assert.equal(service.getProject('proj').root.title, 'Homelab')
  await assert.rejects(() => apply(service, { type: 'createProject', title: '' }), { code: 'invalid-title' })
  await assert.rejects(() => apply(service, { type: 'createProject', title: 'x', bogus: 1 }), { code: 'invalid-op' })
})

test('renameProject changes the title and never the file name', async () => {
  const { service, root } = await rig()
  const result = await apply(service, { type: 'renameProject', project: 'proj', title: '改名了' })
  assert.equal(service.getProject('proj').root.title, '改名了')
  assert.equal(service.getProject('proj').file, 'homelab.md')
  assert.deepEqual(readdirSync(root).filter((n) => n.endsWith('.md')), ['homelab.md'])
  assert.equal(result.events[0].type, 'node/updated')
  assert.equal(result.project.id, 'proj')
})

test('removeProject deletes the file (kept in the trash), reorderProjects reorders', async () => {
  const { service, root } = await rig()
  const a = await apply(service, { type: 'createProject', title: 'A' })
  const b = await apply(service, { type: 'createProject', title: 'B' })
  const order = await apply(service, { type: 'reorderProjects', order: [b.nodeId] })
  assert.deepEqual(service.listProjects().map((p) => p.id), [b.nodeId, 'proj', a.nodeId])
  assert.deepEqual(order.events[0].data.order, [b.nodeId, 'proj', a.nodeId])
  assert.deepEqual((await apply(service, { type: 'reorderProjects', order: [b.nodeId] })).events, [])
  await assert.rejects(() => apply(service, { type: 'reorderProjects', order: ['nope'] }), { code: 'not-found' })
  await assert.rejects(() => apply(service, { type: 'reorderProjects', order: [a.nodeId, a.nodeId] }), { code: 'invalid-op' })
  const removed = await apply(service, { type: 'removeProject', project: a.nodeId })
  assert.equal(removed.project, null)
  assert.equal(removed.events[0].type, 'project/removed')
  assert.equal(existsSync(path.join(root, 'A.md')), false)
  assert.deepEqual(service.listProjects().map((p) => p.id), [b.nodeId, 'proj'])
  assert.throws(() => service.getProject(a.nodeId), { code: 'not-found' })
})

test('listProjects summarizes counts; where, locate and readMarkdown work from the cache', async () => {
  const { service } = await rig()
  await apply(service, { type: 'update', project: 'proj', id: 's1', patch: { state: 'todo' } })
  assert.deepEqual(service.listProjects()[0], { id: 'proj', file: 'homelab.md', title: 'Homelab', state: '', todo: 1, halt: 0, steps: 4 })
  assert.equal(service.where('proj', 's2'), 'Homelab › 两台机器 › nas-a › nas-a 步骤（第 1 步）')
  assert.equal(service.where('proj', 'zzzz'), '')
  assert.equal(service.where('nope', 's2'), '')
  const hit = service.locate('proj', 's2')
  assert.deepEqual([hit.parent.id, hit.path.map((n) => n.id)], ['l1', ['proj', 'f1', 'l1']])
  assert.equal(service.locate('proj', 'zzzz'), null)
  const whole = service.readMarkdown('proj')
  assert.match(whole.markdown, /^# Homelab \{#proj\}\n/)
  assert.match(whole.rev, /^[0-9a-f]{12}$/)
  const part = service.readMarkdown('proj', 'f1')
  assert.match(part.markdown, /^# FORK 两台机器 \{#f1\}/)
  assert.equal(part.where, 'Homelab › 两台机器')
  assert.throws(() => service.readMarkdown('proj', 'zzzz'), { code: 'not-found' })
})

test('writeMarkdown replaces a subtree, keeps ids that are present, regenerates ids that live elsewhere', async () => {
  const { service } = await rig()
  const read = service.readMarkdown('proj', 'f1').markdown
  const edited = read.replace('nas-b {#l2}', 'nas-b 改 {#l2}') + '\n#### 新步骤 {#s3}\n\n#### 另一个\n'
  const result = await apply(service, { type: 'update', project: 'proj', id: 's1', patch: {} })
  assert.deepEqual(result.events, [])
  const written = await service.writeMarkdown('proj', 'f1', edited, AGENT)
  assert.equal(written.nodeId, 'f1')
  assert.equal(service.locate('proj', 'l2').node.title, 'nas-b 改')
  assert.equal(service.locate('proj', 's2').node.title, 'nas-a 步骤', 'untouched ids stay')
  // 's3' is the 收尾 step elsewhere in the project: the copy inside the fork gets a new id
  assert.equal(service.locate('proj', 's3').parent.id, 'proj')
  const lane = service.locate('proj', 'l2').node
  assert.equal(lane.children.length, 2)
  assert.notEqual(lane.children[0].id, 's3')
  assert.equal(lane.children[0].title, '新步骤')
  const [event] = written.events
  assert.equal(event.type, 'node/updated')
  assert.deepEqual(event.data.fields, ['markdown'])
  assert.equal(event.data.added.length, 2)
  assert.deepEqual(event.data.changed, ['l2'])
  assert.deepEqual(event.actor, AGENT)
  const same = await service.writeMarkdown('proj', 'f1', service.readMarkdown('proj', 'f1').markdown, AGENT)
  assert.deepEqual(same.events, [])
})

test('writeMarkdown on a step under a project turns unmarked headings into steps; kinds are checked against the parent', async () => {
  const { service } = await rig()
  await service.writeMarkdown('proj', 's1', '# 重写的步骤 {#s1}\n\n新正文\n\n## 子 A\n\n## REF 参考 B\n', HUMAN)
  const node = service.locate('proj', 's1').node
  assert.deepEqual(node.children.map((c) => [c.kind, c.title]), [['step', '子 A'], ['ref', '参考 B']])
  assert.equal(node.body, '新正文')
  // a lane replaces a lane because the parent (a fork) decides what an unmarked heading means
  await service.writeMarkdown('proj', 'l1', '### nas-a 换名 {#l1}\n', HUMAN)
  assert.equal(service.locate('proj', 'l1').node.kind, 'lane')
  await assert.rejects(() => service.writeMarkdown('proj', 's1', '没有标题的文字', HUMAN), { code: 'invalid-content' })
  await assert.rejects(() => service.writeMarkdown('proj', 's1', '', HUMAN), { code: 'invalid-content' })
  await assert.rejects(() => service.writeMarkdown('proj', 'zzzz', '# x\n', HUMAN), { code: 'not-found' })
  await assert.rejects(() => service.writeMarkdown('proj', null, 5, HUMAN), { code: 'invalid-content' })
})

test('writeMarkdown with a null node replaces the whole project but keeps its id', async () => {
  const { service } = await rig()
  const written = await service.writeMarkdown('proj', null, '# 完全不同 {#other}\n\n## 只剩一步 {#only}\n', HUMAN)
  const project = service.getProject('proj')
  assert.equal(project.root.id, 'proj')
  assert.equal(project.root.title, '完全不同')
  assert.deepEqual(project.root.children.map((c) => c.id), ['only'])
  assert.equal(written.project.rev, project.rev)
  assert.ok(written.events[0].data.removed.includes('s2'))
})

test('focus publishes view/focus with project and node at the top level and nothing else', async () => {
  const { service, published, scheduled } = await rig()
  const before = published.length
  service.focus('proj', 's2', HUMAN)
  service.focus('proj', null, HUMAN)
  const [one, two] = published.slice(before)
  assert.deepEqual([one.type, one.project, one.node, one.actor], ['view/focus', 'proj', 's2', HUMAN])
  assert.match(one.summary, /^聚焦 Homelab › 两台机器/)
  assert.equal(one.data.where, 'Homelab › 两台机器 › nas-a › nas-a 步骤（第 1 步）')
  assert.equal(two.node, null)
  assert.equal(scheduled.length, 0, 'focus is not a change')
  assert.throws(() => service.focus('nope', null, HUMAN), { code: 'not-found' })
})

test('view state round-trips under .mainline/view and a damaged one reads as empty', async () => {
  const { service, root } = await rig()
  assert.deepEqual(await service.readView('proj'), {})
  await service.writeView('proj', { camera: { x: 1, y: 2 }, fold: { s1: 'open' } })
  assert.deepEqual(await service.readView('proj'), { camera: { x: 1, y: 2 }, fold: { s1: 'open' } })
  assert.ok(existsSync(path.join(root, '.mainline', 'view', 'proj.json')))
  writeFileSync(path.join(root, '.mainline', 'view', 'proj.json'), '{ nope')
  assert.deepEqual(await service.readView('proj'), {})
  await assert.rejects(() => service.writeView('proj', []), { code: 'invalid-request' })
  await assert.rejects(() => service.readView('nope'), { code: 'not-found' })
})

test('events.jsonl gets every non-view event; a throwing emit does not break the op', async () => {
  const warnings = []
  const root = makeRoot()
  writeFileSync(path.join(root, 'homelab.md'), WALK)
  const events = createEvents({ file: path.join(root, '.mainline', 'events.jsonl'), logger: { warn: (m) => warnings.push(m) }, emit: () => { throw new Error('listener bug') } })
  events.subscribe(() => { throw new Error('subscriber bug') })
  const service = track(createService({ root, events, git: undefined }))
  await service.ready()
  const result = await apply(service, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: '照样成功' })
  assert.ok(service.locate('proj', result.nodeId))
  service.focus('proj', 's1', HUMAN)
  await events.idle()
  const logged = readFileSync(path.join(root, '.mainline', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(logged.map((e) => e.type), ['node/created'])
  assert.ok(warnings.length > 0)
})

test('two services on one root (two processes): concurrent ops on one project lose nothing', async () => {
  const root = makeRoot()
  writeFileSync(path.join(root, 'homelab.md'), WALK)
  const a = (await boot({ root, noGit: true })).service
  const b = (await boot({ root, noGit: true })).service
  const jobs = []
  for (let i = 0; i < 10; i += 1) {
    jobs.push(apply(a, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: `甲${i}` }))
    jobs.push(apply(b, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: `乙${i}` }, AGENT))
    jobs.push(apply(b, { type: 'update', project: 'proj', id: 's1', patch: { append: `段${i}` } }))
  }
  await Promise.all(jobs)
  const text = readFileSync(path.join(root, 'homelab.md'), 'utf8')
  for (let i = 0; i < 10; i += 1) for (const t of [`## 甲${i} `, `## 乙${i} `, `段${i}`]) assert.ok(text.includes(t), `lost ${t}`)
  await a.close()
  await b.close()
})

test('an external edit raises tree/external with the right ids and is committed as external; our writes do not', async () => {
  const env = await rig({ realGit: true })
  const { service, root, git, published } = env
  await apply(service, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: '我们的' })
  // settle our own commit first: with a slow git it would otherwise stage the external edit too
  await git.flush()
  await new Promise((r) => setTimeout(r, 200))
  await service.idle()
  assert.equal(published.filter((e) => e.type === 'tree/external').length, 0)
  const text = readFileSync(path.join(root, 'homelab.md'), 'utf8')
  writeFileSync(path.join(root, 'homelab.md'), text.replace('## 收尾 {#s3}', '## 收尾改 {#s3}') + '\n## 外部加的 {#ext1}\n')
  const event = await until(() => published.find((e) => e.type === 'tree/external'))
  assert.deepEqual(event.actor, { kind: 'external' })
  assert.equal(event.project, 'proj')
  assert.deepEqual([event.data.added, event.data.removed, event.data.changed], [['ext1'], [], ['s3']])
  assert.match(event.summary, /在外部改了项目「Homelab」/)
  assert.ok(service.locate('proj', 'ext1'), 'the cache follows the file')
  await git.flush()
  assert.match(gitOut(root, 'log', '-1', '--format=%s'), /在外部改了项目/)
  assert.equal(readFileSync(path.join(root, 'homelab.md'), 'utf8').includes('外部加的'), true)
  await service.close()
})

test('history answers per project and overall; every committed op shows up; agent ops are authored DSH Agent', async () => {
  const { service, git, root } = await rig({ realGit: true })
  await apply(service, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: '模型加的' }, AGENT)
  await git.flush()
  const commits = await service.history('proj', 10)
  assert.match(commits[0].message, /添加了步骤/)
  assert.equal(commits[0].author, 'DSH Agent')
  assert.ok((await service.history(null, 10)).length >= commits.length)
  assert.equal(gitOut(root, 'log', '-1', '--format=%ae'), 'agent@dsh.local')
  await assert.rejects(() => service.history('nope', 5), { code: 'not-found' })
  await service.close()
})

test('restore writes the old content as a new commit and never rewrites history', async () => {
  const { service, git, root } = await rig({ realGit: true })
  await git.flush()
  const [initial] = await service.history('proj', 5)
  await apply(service, { type: 'update', project: 'proj', id: 's1', patch: { title: '改过了' } })
  await git.flush()
  const before = commitCount(root)
  const history = await service.history('proj', 10)
  const result = await apply(service, { type: 'restore', project: 'proj', rev: initial.rev })
  await git.flush()
  assert.equal(service.locate('proj', 's1').node.title, '开头')
  assert.equal(result.events[0].type, 'project/restored')
  assert.equal(commitCount(root), before + 1)
  const after = await service.history('proj', 10)
  assert.deepEqual(after.slice(1).map((c) => c.rev), history.map((c) => c.rev), 'every older commit is still there, unchanged')
  assert.match(after[0].message, /恢复/)
  assert.equal(service.getProject('proj').root.id, 'proj')
  assert.deepEqual((await apply(service, { type: 'restore', project: 'proj', rev: initial.rev })).events, [], 'restoring what is already there is a no-op')
  await assert.rejects(() => apply(service, { type: 'restore', project: 'proj', rev: 'deadbeef' }), { code: 'not-found' })
  await assert.rejects(() => apply(service, { type: 'restore', project: 'proj', rev: '--help' }), { code: 'invalid-request' })
  await service.close()
})

test('without git the ops still work and history answers git-unavailable', async () => {
  const root = makeRoot()
  writeFileSync(path.join(root, 'homelab.md'), WALK)
  const env = await boot({ root, gitOptions: { gitBin: 'definitely-not-a-git-binary' } })
  assert.equal(env.git.available, false)
  const created = await apply(env.service, { type: 'create', project: 'proj', parent: 'proj', kind: 'step', title: '照常' })
  assert.ok(env.service.locate('proj', created.nodeId))
  await assert.rejects(() => env.service.history('proj', 5), { code: 'git-unavailable' })
  await assert.rejects(() => apply(env.service, { type: 'restore', project: 'proj', rev: 'abcd1234' }), { code: 'git-unavailable' })
  await env.service.close()
})

test('startup: a tree already in a repository is not re-initialised, uncommitted work is scheduled', async () => {
  const first = await rig({ realGit: true })
  await first.git.flush()
  const root = first.root
  await first.service.close()
  writeFileSync(path.join(root, 'late.md'), '# Late {#late}\n')
  const again = await boot({ root })
  await again.git.flush()
  assert.ok(again.service.listProjects().some((p) => p.id === 'late'))
  assert.equal(gitOut(root, 'ls-files', 'late.md'), 'late.md')
  await again.service.close()
})

test('paths with spaces and CJK, and a project file the editor wrote with CRLF, work end to end', async () => {
  const root = makeRoot()
  writeFileSync(path.join(root, '含 空格的 项目.md'), '# 中文 {#cn01}\r\n\r\n## 步骤 {#s1}\r\n\r\n正文\r\n')
  const { service } = await boot({ root, noGit: true })
  assert.equal(service.getProject('cn01').root.children[0].body, '正文')
  await apply(service, { type: 'update', project: 'cn01', id: 's1', patch: { state: 'todo' } })
  const text = readFileSync(path.join(root, '含 空格的 项目.md'), 'utf8')
  assert.equal(text.includes('\r'), false, 'output is always LF')
  assert.ok(text.includes('## TODO 步骤 {#s1}'))
  await service.close()
})

