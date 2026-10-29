import { strict as assert } from 'node:assert'
import test from 'node:test'

import { createTools, limitDepth } from '../lib/tools.js'
import { makeService } from './helpers/host-fakes.mjs'

const byName = (tools, name) => tools.find((t) => t.name === name)
const setup = () => {
  const service = makeService()
  const tools = createTools({ service })
  return { service, tools, run: (name, args, exec) => byName(tools, name).execute(args, exec) }
}
const EXEC = { agent: { id: 'session-9' } }

test('eleven tools with the contract names and definition shape', () => {
  const { tools } = setup()
  assert.deepEqual(tools.map((t) => t.name), [
    'mainline_projects', 'mainline_read', 'mainline_add', 'mainline_update', 'mainline_move', 'mainline_remove',
    'mainline_fork', 'mainline_write', 'mainline_create_project', 'mainline_history', 'mainline_restore',
  ])
  for (const t of tools) {
    assert.equal(typeof t.description, 'string')
    assert.equal(typeof t.timeoutMs, 'number')
    assert.equal(typeof t.isConcurrencySafe(), 'boolean')
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.output.render, 'function')
  }
})

test('project resolves by id, file name (with or without .md) and exact title; unknown is a typed failure', async () => {
  const { run } = setup()
  for (const ref of ['p1', 'homelab.md', 'HOMELAB', 'NAS→ZFS']) {
    assert.equal((await run('mainline_read', { project: ref })).ok, true, ref)
  }
  const missing = await run('mainline_read', { project: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'not-found')
  assert.match(missing.error, /NAS→ZFS/)
})

test('mainline_projects maps the empty state to none', async () => {
  const { run } = setup()
  const result = await run('mainline_projects', {})
  assert.equal(result.ok, true)
  assert.equal(result.projects[0].state, 'none')
})

test('writes are attributed to the calling agent session', async () => {
  const { service, run } = setup()
  await run('mainline_add', { project: 'p1', kind: 'step', title: 'x', state: 'none' }, EXEC)
  const [, op, actor] = service.calls[0]
  assert.deepEqual(actor, { kind: 'agent', session: 'session-9' })
  assert.equal(op.state, '')
  assert.equal(op.parent, 'p1', 'parent defaults to the project root')
})

test('append and cwd travel to the service as locked patch fields; body+append is refused', async () => {
  const { service, run } = setup()
  await run('mainline_update', { project: 'p1', id: 's1', append: '结论' }, EXEC)
  assert.deepEqual(service.calls[0][1].patch, { append: '结论' })
  await run('mainline_update', { project: 'p1', id: 'l1', cwd: '/new' }, EXEC)
  assert.deepEqual(service.calls[1][1].patch, { setAttrs: { cwd: '/new' } })
  await run('mainline_update', { project: 'p1', id: 'l1', cwd: '' }, EXEC)
  assert.deepEqual(service.calls[2][1].patch, { setAttrs: { cwd: null } })
  assert.equal((await run('mainline_update', { project: 'p1', id: 's1', body: 'a', append: 'b' }, EXEC)).ok, false)
  assert.equal((await run('mainline_update', { project: 'p1', id: 's1' }, EXEC)).reason, 'invalid-request')
})

test('an invalid state is a typed failure, not a throw', async () => {
  const { run } = setup()
  const result = await run('mainline_add', { project: 'p1', kind: 'step', title: 'x', state: 'done' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid-state')
})

test('remove reports the subtree size; fork lists lanes', async () => {
  const { run } = setup()
  assert.deepEqual((await run('mainline_remove', { project: 'p1', id: 'x' })).removed, { title: '被删', count: 2 })
  const fork = await run('mainline_fork', { project: 'p1', after: 's1', lanes: ['a', 'b'] })
  assert.deepEqual(fork.lanes, [{ id: 'l1', title: 'nas-b' }])
})

test('create_project, write, history and restore pass through the service', async () => {
  const { service, run } = setup()
  assert.deepEqual(await run('mainline_create_project', { title: 'T' }), { ok: true, id: 'p1', file: 'homelab.md' })
  assert.equal((await run('mainline_write', { project: 'p1', markdown: '# x' })).rev, 'abc123abc123')
  assert.equal(service.calls.at(-1)[2], null, 'no node means the whole project')
  assert.equal((await run('mainline_history', { limit: 5 })).commits[0].rev, 'r1')
  assert.deepEqual(service.calls.at(-1), ['history', null, 5])
  assert.equal((await run('mainline_restore', { project: 'p1', rev: 'r1' })).ok, true)
})

test('a service that throws becomes an internal failure value', async () => {
  const { service, run } = setup()
  service.apply = async () => {
    throw new Error('boom')
  }
  const result = await run('mainline_move', { project: 'p1', id: 's1', parent: 'p1' })
  assert.deepEqual([result.ok, result.reason], [false, 'internal'])
})

test('limitDepth trims deeper headings but never treats a fenced # as a heading', () => {
  const md = '# a\n\n## b\n\n### c\n\n```bash\n# keep\n```\n\n## d'
  assert.ok(!limitDepth(md, 1).includes('### c'))
  assert.ok(limitDepth(md, 1).includes('## d'))
  assert.ok(!limitDepth(md, 1).includes('# keep'), 'a fence under a skipped heading goes with it')
  assert.ok(limitDepth(md, 5).includes('# keep'))
  assert.equal(limitDepth('# a\n## b\n```\n# x\n```', 0).includes('# x'), false)
})

test('render turns failures into one readable line', () => {
  const { tools } = setup()
  const [block] = byName(tools, 'mainline_add').output.render({}, { ok: false, reason: 'x', error: '坏了' })
  assert.match(block.text, /坏了/)
})
