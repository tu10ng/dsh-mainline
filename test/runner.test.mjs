import { strict as assert } from 'node:assert'
import test from 'node:test'

import { extractFences, createRunner } from '../lib/runner.js'
import { makeCtx, makeEvents, makeService } from './helpers/host-fakes.mjs'

/** A shell whose executions finish when the test says so. */
function makeShell() {
  const shell = {
    resolved: [],
    executions: [],
    resolve(input) {
      shell.resolved.push(input)
      return { spec: input }
    },
    async execute() {
      let done
      const finished = new Promise((resolve) => (done = resolve))
      const execution = {
        killed: false,
        kill() {
          execution.killed = true
          done({ exitCode: null, signal: 'SIGTERM', timedOut: false, aborted: true, stdout: { text: '' }, stderr: { text: '' } })
        },
        result: () => finished,
        finish: (result) =>
          done({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: 'a\nlast' }, stderr: { text: '' }, ...result }),
      }
      shell.executions.push(execution)
      return execution
    },
  }
  return shell
}

const setup = (services = {}) => {
  const shell = makeShell()
  const events = makeEvents()
  const service = makeService()
  const ctx = makeCtx({ shell, ...services })
  const runner = createRunner({ ctx, service, events, logger: ctx.logger, cwd: '/session-cwd' })
  return { shell, events, service, runner }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const ACTOR = { kind: 'human' }

test('extractFences keeps only shell languages, indexes them in order, and ignores unclosed fences', () => {
  const body = ['```Bash', 'a', '```', '', '```python', 'no', '```', '', '~~~powershell title', 'b', '~~~', '', '```sh', 'never closed'].join('\n')
  const fences = extractFences(body)
  assert.deepEqual(fences.map((f) => [f.index, f.lang, f.code]), [[0, 'bash', 'a'], [1, 'powershell', 'b']])
  assert.equal(body.slice(fences[0].start, fences[0].end), '```Bash\na\n```')
})

test('extractFences honours the closing-fence length rule and CRLF', () => {
  const fences = extractFences('````sh\r\n```\r\nstill code\r\n````')
  assert.equal(fences.length, 1)
  assert.equal(fences[0].code, '```\nstill code')
})

test('the command comes from the stored body, never from the request', async () => {
  const { runner, shell } = setup()
  const run = await runner.run({ project: 'p1', node: 's1', index: 1, command: 'rm -rf /', body: 'evil' }, ACTOR)
  assert.equal(run.command, 'echo two')
  assert.equal(shell.resolved[0].command, 'echo two')
  assert.equal(shell.resolved[0].timeoutMs, 120000)
})

test('cwd: nearest attrs.cwd on the node or an ancestor, else the session cwd', async () => {
  const { runner, shell, service } = setup()
  await runner.run({ project: 'p1', node: 's3', index: 0 }, ACTOR) // inside lane l1 (cwd /lane)
  assert.equal(shell.resolved[0].workdir, '/lane')
  await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR) // only the project has cwd /work
  assert.equal(shell.resolved[1].workdir, '/work')
  service.getProject('p1').root.attrs = {}
  await runner.run({ project: 'p1', node: 's1', index: 1 }, ACTOR)
  assert.equal(shell.resolved[2].workdir, '/session-cwd')
})

test('a missing shell service is shell-unavailable', async () => {
  const { runner } = setup({ shell: undefined })
  await assert.rejects(runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR), { code: 'shell-unavailable' })
})

test('unknown node or fence index is not-found; a bad index is invalid-request', async () => {
  const { runner } = setup()
  await assert.rejects(runner.run({ project: 'p1', node: 'zzz', index: 0 }, ACTOR), { code: 'not-found' })
  await assert.rejects(runner.run({ project: 'p1', node: 's1', index: 9 }, ACTOR), { code: 'not-found' })
  await assert.rejects(runner.run({ project: 'p1', node: 's1', index: -1 }, ACTOR), { code: 'invalid-request' })
})

test('one run per fence at a time: a second start answers the running one', async () => {
  const { runner, shell } = setup()
  const first = await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  const second = await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  assert.equal(second.runId, first.runId)
  assert.equal(shell.executions.length, 1)
  assert.equal(second.status, 'running')
})

test('finishing records the tails, flips status and publishes run events with the last line', async () => {
  const { runner, shell, events } = setup()
  const started = await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  shell.executions[0].finish({ exitCode: 2, stdout: { text: 'x'.repeat(30_000) + '\nboom' } })
  await tick()
  const [done] = runner.list({ project: 'p1', node: 's1' })
  assert.equal(done.runId, started.runId)
  assert.equal(done.status, 'failed')
  assert.equal(done.exitCode, 2)
  assert.ok(done.stdout.length <= 20_000)
  assert.deepEqual(events.published.map((e) => e.type), ['run/started', 'run/finished'])
  assert.match(events.published[1].summary, /退出码 2.*boom/)
  assert.equal(events.published[1].actor.kind, 'human')
  // a finished fence can run again
  const again = await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  assert.notEqual(again.runId, started.runId)
})

test('exit code 0 is done', async () => {
  const { runner, shell } = setup()
  await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  shell.executions[0].finish({})
  await tick()
  assert.equal(runner.list()[0].status, 'done')
})

test('cancel kills a running execution and reports aborted; unknown id is false', async () => {
  const { runner, shell } = setup()
  const run = await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  assert.equal(runner.cancel('nope'), false)
  assert.equal(runner.cancel(run.runId), true)
  await tick()
  assert.equal(shell.executions[0].killed, true)
  const [rec] = runner.list()
  assert.equal(rec.aborted, true)
  assert.equal(rec.status, 'failed')
  assert.equal(runner.cancel(run.runId), false, 'already finished')
})

test('a shell that fails to start yields a failed record, not a throw', async () => {
  const { runner, shell } = setup()
  shell.resolve = () => {
    throw new Error('sandbox refused')
  }
  const run = await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  assert.equal(run.status, 'failed')
  assert.match(run.stderr, /sandbox refused/)
})

test('the sandbox policy is passed through when the host has one', async () => {
  const { runner, shell } = setup({ sandboxPolicy: { resolve: () => ({ mode: 'strict' }) } })
  await runner.run({ project: 'p1', node: 's1', index: 0 }, ACTOR)
  assert.deepEqual(shell.resolved[0].sandboxPolicy, { mode: 'strict' })
})
