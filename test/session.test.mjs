import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GUIDANCE_FULL, GUIDANCE_SHORT } from '../lib/prompt.js'
import { createSession } from '../lib/session.js'
import { makeAgent, makeCtx, makeEvents, makeService, text } from './helpers/host-fakes.mjs'

async function setup(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ml-session-'))
  const file = path.join(dir, 'session.json')
  if (options.saved) await writeFile(file, JSON.stringify({ sessionId: options.saved }))
  const agent = options.agent ?? makeAgent('session-1')
  const agents = new Map(options.live === false ? [] : [[agent.id, agent]])
  const created = []
  const sessionController = options.noController
    ? undefined
    : {
        created,
        create: async (arg) => {
          created.push(arg)
          if (options.failWorkspace && arg.workspaceId) throw new Error('no workspace')
          return { sessionId: 'session-new' }
        },
        resolveAgent: async (id) => (options.resumable === id ? { agent } : { error: 'gone' }),
      }
  const workspaceRegistry = options.noWorkspace
    ? undefined
    : { resolveByPath: async () => options.existingWorkspace, create: async (cwd, title) => ({ id: 'ws-1', cwd, title }) }
  const ctx = makeCtx({ agents, sessionController, workspaceRegistry })
  const events = makeEvents()
  const service = makeService()
  const session = createSession({ ctx, service, events, logger: ctx.logger, file, cwd: options.cwd ?? '/work-here', now: () => 1_700_000_000_000 })
  const dispose = session.attach()
  return { dir, file, agent, session, events, service, sessionController, ctx, cleanup: async () => (dispose(), rm(dir, { recursive: true, force: true })) }
}

const human = (type, summary, extra = {}) => ({ type, summary, actor: { kind: 'human' }, at: 1_700_000_000_000, ...extra })

test('ensure reuses a saved session that is live', async () => {
  const env = await setup({ saved: 'session-1' })
  try {
    assert.equal(await env.session.ensure(), 'session-1')
    assert.deepEqual(env.sessionController.created, [])
  } finally {
    await env.cleanup()
  }
})

test('ensure resumes a saved session that is persisted but not live', async () => {
  const env = await setup({ saved: 'session-1', live: false, resumable: 'session-1' })
  try {
    assert.equal(await env.session.ensure(), 'session-1')
    assert.deepEqual(env.sessionController.created, [])
  } finally {
    await env.cleanup()
  }
})

test('ensure creates through a workspace and persists the id', async () => {
  const env = await setup({ saved: 'session-gone', live: false })
  try {
    assert.equal(await env.session.ensure(), 'session-new')
    assert.deepEqual(env.sessionController.created, [{ workspaceId: 'ws-1' }])
    assert.deepEqual(JSON.parse(await readFile(env.file, 'utf8')), { sessionId: 'session-new' })
  } finally {
    await env.cleanup()
  }
})

test('ensure falls back to cwd when there is no workspace registry or it fails', async () => {
  for (const options of [{ noWorkspace: true }, { failWorkspace: true }]) {
    const env = await setup({ live: false, ...options })
    try {
      await env.session.ensure()
      assert.deepEqual(env.sessionController.created.at(-1), { cwd: '/work-here' })
    } finally {
      await env.cleanup()
    }
  }
})

test('no sessionController is session-unavailable', async () => {
  const env = await setup({ noController: true, live: false })
  try {
    await assert.rejects(env.session.ensure(), { code: 'session-unavailable' })
  } finally {
    await env.cleanup()
  }
})

test('the session cwd is never the tree root', async () => {
  const env = await setup({ cwd: '/tree-root' })
  try {
    assert.equal(env.session.cwd(), homedir())
  } finally {
    await env.cleanup()
  }
})

test('reset forgets the id and a new ensure creates another session', async () => {
  const env = await setup({ saved: 'session-1' })
  try {
    await env.session.ensure()
    await env.session.reset()
    assert.equal(env.session.id(), null)
    assert.equal(await env.session.ensure(), 'session-new')
  } finally {
    await env.cleanup()
  }
})

test('events are injected only while idle; a running agent holds the batch until it goes idle', async () => {
  const agent = makeAgent('session-1', 'running')
  const env = await setup({ saved: 'session-1', agent })
  try {
    await env.session.ensure()
    env.events.publish(human('node/updated', '改了标题'))
    assert.equal(agent.injected.length, 0)
    agent.status = 'idle'
    env.session.handleStatus({ agent: { id: 'other' }, status: 'idle' })
    assert.equal(agent.injected.length, 0, 'another agent going idle is not ours')
    env.session.handleStatus({ agent: { id: 'session-1' }, status: 'idle' })
    assert.equal(agent.injected.length, 1)
    const message = agent.injected[0]
    assert.equal(message.role, 'user')
    assert.ok(Array.isArray(message.content))
    assert.deepEqual([message.source.kind, message.source.form], ['plugin:dsh-mainline', 'notice'])
    assert.equal(message.source.summary, '工作树：1 项操作')
    assert.match(text(message), /^【工作树】用户在面板上的操作（较早的在前）：\n- \d\d:\d\d 改了标题$/)
  } finally {
    await env.cleanup()
  }
})

test('a further event replaces the unclaimed message; a claimed one starts a new message with only the new lines', async () => {
  const env = await setup({ saved: 'session-1' })
  try {
    await env.session.ensure()
    env.events.publish(human('node/created', '加了一步'))
    const firstId = env.agent.injected[0].id
    env.events.publish(human('node/updated', '改了状态'))
    assert.equal(env.agent.injected.length, 1)
    assert.equal(env.agent.injected[0].id, firstId, 'replace keeps the id')
    assert.match(text(env.agent.injected[0]), /加了一步\n- \d\d:\d\d 改了状态/)

    env.agent.inbox.claimed.add(firstId)
    env.events.publish(human('node/removed', '删了一步'))
    assert.equal(env.agent.injected.length, 2)
    assert.notEqual(env.agent.injected[1].id, firstId)
    assert.ok(!text(env.agent.injected[1]).includes('加了一步'), 'delivered lines are not repeated')
    assert.match(text(env.agent.injected[1]), /删了一步/)
  } finally {
    await env.cleanup()
  }
})

test('own-session events, git commits, session/asked and other view events are skipped', async () => {
  const env = await setup({ saved: 'session-1' })
  try {
    await env.session.ensure()
    env.events.publish({ type: 'node/updated', summary: '自己改的', actor: { kind: 'agent', session: 'session-1' } })
    env.events.publish(human('git/committed', 'c'))
    env.events.publish(human('session/asked', 'a'))
    env.events.publish(human('view/scroll', 'v'))
    assert.equal(env.agent.injected.length, 0)
    env.events.publish({ type: 'node/updated', summary: '别的会话改的', actor: { kind: 'agent', session: 'session-2' } })
    assert.equal(env.agent.injected.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('focus events de-duplicate: only the latest focus stays in the batch', async () => {
  const agent = makeAgent('session-1', 'running')
  const env = await setup({ saved: 'session-1', agent })
  try {
    await env.session.ensure()
    env.events.publish(human('view/focus', '聚焦 A', { project: 'p1', node: 's0' }))
    env.events.publish(human('node/updated', '改了'))
    env.events.publish(human('view/focus', '聚焦 B', { project: 'p1', node: 's1' }))
    agent.status = 'idle'
    env.session.handleStatus({ agent: { id: 'session-1' }, status: 'idle' })
    const body = text(agent.injected[0])
    assert.ok(!body.includes('聚焦 A'))
    assert.ok(body.includes('聚焦 B'))
    assert.ok(body.indexOf('改了') < body.indexOf('聚焦 B'), 'order is kept')
    assert.deepEqual(env.session.focus(), { project: 'p1', node: 's1' })
  } finally {
    await env.cleanup()
  }
})

test('the batch is capped at 40 lines and says how many were dropped', async () => {
  const agent = makeAgent('session-1', 'running')
  const env = await setup({ saved: 'session-1', agent })
  try {
    await env.session.ensure()
    for (let i = 0; i < 45; i += 1) env.events.publish(human('node/updated', `第${i}条`))
    agent.status = 'idle'
    env.session.flush()
    const lines = text(agent.injected[0]).split('\n')
    assert.equal(lines.length, 1 + 1 + 40)
    assert.match(lines[1], /更早的 5 条已省略/)
    assert.ok(lines.at(-1).endsWith('第44条'))
    assert.ok(!text(agent.injected[0]).includes('第4条'))
  } finally {
    await env.cleanup()
  }
})

test('ask starts a real turn with followup, delivering pending notices first', async () => {
  const env = await setup({ saved: 'session-1' })
  try {
    env.events.publish(human('node/updated', '不应记录：还没有会话'))
    await env.session.ensure()
    env.events.publish(human('node/updated', '改了'))
    await env.session.ask('请继续推进', '工作树：交给 AI')
    assert.equal(env.agent.followups.length, 1)
    assert.equal(text(env.agent.followups[0]), '请继续推进')
    assert.equal(env.agent.followups[0].source.form, 'notice')
    assert.equal(env.agent.injected.length, 1)
    assert.ok(!text(env.agent.injected[0]).includes('不应记录'))
  } finally {
    await env.cleanup()
  }
})

test('prompt section and context answer only for this session', async () => {
  const env = await setup({ saved: 'session-1' })
  try {
    await env.session.ensure()
    const registered = []
    const systemPrompt = {
      section: (def) => (registered.push(def), () => {}),
      context: (def) => (registered.push(def), () => {}),
    }
    env.session.registerPrompt(systemPrompt)
    const [guidance, focus] = registered
    assert.deepEqual([guidance.name, guidance.order, guidance.interpolate], ['dsh-mainline:guidance', 3050, false])
    assert.deepEqual([focus.name, focus.order, focus.interpolate], ['dsh-mainline:focus', 140, false])
    assert.equal(guidance.text({ agent: { id: 'session-1' } }), GUIDANCE_FULL)
    assert.equal(guidance.text({ agent: { id: 'other' } }), GUIDANCE_SHORT)
    assert.equal(guidance.text({}), GUIDANCE_SHORT)
    assert.equal(focus.text({ agent: { id: 'other' } }), '')
    assert.match(focus.text({ agent: { id: 'session-1' } }), /NAS→ZFS/, 'no focus lists projects')

    env.events.publish(human('view/focus', '聚焦', { project: 'p1', node: 's1' }))
    const rendered = focus.text({ agent: { id: 'session-1' } })
    assert.match(rendered, /位置：NAS→ZFS › 换盘/)
    assert.match(rendered, /id s1/)
    assert.match(rendered, /参考：校验/)
    assert.match(rendered, /上一项：开头/)
    assert.match(rendered, /下一项：两台机器/)
    assert.match(rendered, /dmesg \| grep ata/)

    const bare = []
    env.session.registerPrompt({ section: (d) => (bare.push(d), () => {}), context: (d) => (bare.push(d), () => {}) }, { guidance: false })
    assert.deepEqual(bare.map((d) => d.name), ['dsh-mainline:focus'])
  } finally {
    await env.cleanup()
  }
})
