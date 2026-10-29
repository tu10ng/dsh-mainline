import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { createEvents } from '../lib/events.js'
import { cleanup, makeRoot } from './helpers/env.mjs'

after(cleanup)

const logFile = () => path.join(makeRoot(), '.mainline', 'events.jsonl')
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

test('publish fills id, seq and at, and keeps what the caller gave', () => {
  const events = createEvents({ now: () => 42 })
  const a = events.publish({ type: 'node/created', summary: 's', project: 'p', node: 'n', actor: { kind: 'human' }, data: { x: 1 } })
  const b = events.publish({ type: 'node/removed' })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  assert.equal(a.at, 42)
  assert.match(a.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual([b.project, b.node, b.summary, b.data, b.actor], [null, null, '', {}, { kind: 'system' }])
  assert.equal(a.data.x, 1)
})

test('every non-view event lands in events.jsonl, view events do not', async () => {
  const file = logFile()
  const events = createEvents({ file })
  events.publish({ type: 'node/created', summary: '一' })
  events.publish({ type: 'view/focus', summary: 'focus' })
  events.publish({ type: 'git/committed', summary: '二' })
  await events.idle()
  assert.deepEqual(lines(file).map((e) => e.type), ['node/created', 'git/committed'])
  assert.equal(lines(file)[0].summary, '一')
})

test('emit gets the generic and the typed name', () => {
  const seen = []
  const events = createEvents({ emit: (name, e) => seen.push([name, e.type]) })
  events.publish({ type: 'tree/external' })
  assert.deepEqual(seen, [['mainline/event', 'tree/external'], ['mainline/tree/external', 'tree/external']])
})

test('a throwing emit or subscriber does not break the publish or the other listeners', async () => {
  const file = logFile()
  const warnings = []
  const events = createEvents({
    file,
    logger: { warn: (m) => warnings.push(m) },
    emit: () => {
      throw new Error('boom')
    },
  })
  const got = []
  events.subscribe(() => {
    throw new Error('bad subscriber')
  })
  events.subscribe((e) => got.push(e.type))
  const event = events.publish({ type: 'node/updated' })
  assert.equal(event.type, 'node/updated')
  assert.deepEqual(got, ['node/updated'])
  assert.ok(warnings.length >= 3)
  await events.idle()
  assert.equal(lines(file).length, 1)
})

test('subscribe returns a disposer; recent returns the tail', () => {
  const events = createEvents({})
  const got = []
  const dispose = events.subscribe((e) => got.push(e.seq))
  events.publish({ type: 'a' })
  dispose()
  events.publish({ type: 'b' })
  events.publish({ type: 'c' })
  assert.deepEqual(got, [1])
  assert.deepEqual(events.recent(2).map((e) => e.type), ['b', 'c'])
})

test('the log rotates past the size limit and keeps writing', async () => {
  const file = logFile()
  const events = createEvents({ file, rotateBytes: 300 })
  for (let i = 0; i < 12; i += 1) events.publish({ type: 'node/created', summary: 'x'.repeat(60) })
  await events.idle()
  assert.ok(existsSync(path.join(path.dirname(file), 'events.1.jsonl')))
  assert.ok(lines(file).length >= 1)
})

test('an unwritable log never throws', async () => {
  const file = path.join(makeRoot(), 'x')
  const warnings = []
  // `x` is a file, so a log path below it can never be created
  writeFileSync(file, '')
  const events = createEvents({ file: path.join(file, 'events.jsonl'), logger: { warn: (m) => warnings.push(m) } })
  assert.doesNotThrow(() => events.publish({ type: 'node/created' }))
  await events.idle()
  assert.equal(warnings.length, 1)
})
