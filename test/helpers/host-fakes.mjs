/** Fakes for the Host services and the tree service. No real Host, no files, no network. */

import { TreeError } from '../../lib/errors.js'

export const node = (id, kind, title, extra = {}) => ({
  id,
  kind,
  title,
  state: '',
  question: false,
  body: '',
  attrs: {},
  children: [],
  ...extra,
})

export const FENCED = ['先看日志：', '', '```bash', 'dmesg | grep ata', '```', '', '```text', 'not a shell', '```', '', '```sh', 'echo two', '```'].join('\n')

/** A project `p1` (cwd on the root) with a step carrying fences and a lane inside a fork. */
export function makeTree() {
  const patch = node('s1', 'step', '换盘', { state: 'todo', body: FENCED, children: [node('g1', 'ref', '校验')] })
  const lane = node('l1', 'lane', 'nas-b', { attrs: { cwd: '/lane' }, children: [node('s3', 'step', '深层', { body: '```bash\npwd\n```' })] })
  return node('p1', 'project', 'NAS→ZFS', {
    attrs: { cwd: '/work' },
    children: [node('s0', 'step', '开头'), patch, node('f1', 'fork', '两台机器', { children: [lane] }), node('s2', 'step', '收尾', { state: 'halt' })],
  })
}

export function makeService(rootNode = makeTree()) {
  const calls = []
  const index = new Map()
  const walk = (n, parent, path) => {
    index.set(n.id, { node: n, parent, path })
    for (const child of n.children) walk(child, n, [...path, n])
  }
  walk(rootNode, null, [])
  const service = {
    root: '/tree-root',
    calls,
    listProjects: () => [{ id: 'p1', file: 'homelab.md', title: rootNode.title, state: '', todo: 1, halt: 1, steps: 4 }],
    getProject(id) {
      if (id !== 'p1') throw new TreeError('not-found', `找不到项目 ${id}`)
      return { id: 'p1', file: 'homelab.md', rev: 'abc123abc123', root: rootNode }
    },
    locate(project, id) {
      const hit = index.get(id)
      if (project !== 'p1' || !hit) return null
      return { node: hit.node, parent: hit.parent, index: hit.parent ? hit.parent.children.indexOf(hit.node) : 0, path: hit.path }
    },
    where: (project, id) => `NAS→ZFS › ${index.get(id)?.node.title ?? id}`,
    readMarkdown: (project, id) => ({ markdown: `# ${id ?? 'p1'}\n\n## a\n\n### b\n\n\`\`\`bash\n# not a heading\n\`\`\`\n\n## c`, rev: 'abc123abc123', where: 'W' }),
    async apply(op, actor) {
      calls.push(['apply', op, actor])
      if (op.type === 'create') return { project: service.getProject('p1'), nodeId: 'n1', events: [] }
      if (op.type === 'remove') return { project: null, nodeId: null, removed: node('x', 'step', '被删', { children: [node('y', 'ref', 'r')] }), events: [] }
      if (op.type === 'fork') return { project: service.getProject('p1'), nodeId: 'f1', events: [] }
      if (op.type === 'createProject') return { project: null, nodeId: 'p1', events: [] }
      return { project: service.getProject('p1'), nodeId: op.id ?? null, events: [] }
    },
    async writeMarkdown(...args) {
      calls.push(['writeMarkdown', ...args])
      return { project: service.getProject('p1'), nodeId: null, events: [] }
    },
    async history(project, limit) {
      calls.push(['history', project, limit])
      return [{ rev: 'r1', short: 'r1', author: 'a', at: 1, message: 'm' }]
    },
    focus: (...args) => calls.push(['focus', ...args]),
    readView: async () => ({ camera: 1 }),
    writeView: async (...args) => calls.push(['writeView', ...args]),
  }
  return service
}

export function makeEvents() {
  const subscribers = new Set()
  const published = []
  return {
    published,
    subscribers,
    publish(partial) {
      const event = { id: `e${published.length}`, seq: published.length, at: 1_700_000_000_000, data: {}, project: null, node: null, ...partial }
      published.push(event)
      for (const fn of subscribers) fn(event)
      return event
    },
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    recent: () => published,
  }
}

export function makeAgent(id = 'session-1', status = 'idle') {
  const agent = {
    id,
    status,
    injected: [],
    followups: [],
    inbox: {
      claimed: new Set(),
      replaced: [],
      replace(messageId, message) {
        if (agent.inbox.claimed.has(messageId)) return false
        agent.inbox.replaced.push([messageId, message])
        const at = agent.injected.findIndex((m) => m.id === messageId)
        if (at >= 0) agent.injected[at] = message
        return true
      },
      remove: () => true,
    },
    inject: (message) => agent.injected.push(message),
    followup: async (message) => agent.followups.push(message),
  }
  return agent
}

/** ctx whose `root.get` serves the given services. */
export function makeCtx(services = {}) {
  const listeners = new Map()
  return {
    listeners,
    root: { get: (name) => services[name] },
    logger: { warn() {}, info() {}, debug() {} },
    on(name, fn) {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
  }
}

export const text = (message) => message.content[0].text
