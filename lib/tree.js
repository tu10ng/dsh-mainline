/**
 * Pure helpers over the work tree (SPEC 1.3). No I/O, no dependencies: the service, the
 * tools and the format layer all lean on these, so they must stay free of side effects.
 *
 * @module dsh-mainline/tree
 */
import { TreeError } from './errors.js'

/** @typedef {{ id: string, kind: string, title: string, state: string, question: boolean, body: string, attrs: Record<string, string>, children: any[], preamble?: string }} Node */

export const KINDS = Object.freeze(['project', 'step', 'fork', 'lane', 'ref'])
export const STATES = Object.freeze(['', 'todo', 'halt'])

const ALLOWED = Object.freeze({
  project: ['step', 'fork', 'ref'],
  step: ['step', 'fork', 'ref'],
  fork: ['lane', 'ref'],
  lane: ['step', 'fork', 'ref'],
  ref: ['ref'],
})

/**
 * Whether a node of `parentKind` may hold a child of `childKind` (SPEC 1.2 table).
 * @param {string} parentKind
 * @param {string} childKind
 * @returns {boolean}
 */
export function canContain(parentKind, childKind) {
  return Object.hasOwn(ALLOWED, parentKind) && ALLOWED[parentKind].includes(childKind)
}

/** References hung on a node. @param {Node} node @returns {Node[]} */
export function refsOf(node) {
  return node.children.filter((c) => c.kind === 'ref')
}

/** The followed line of a node: everything that is not a reference. @param {Node} node @returns {Node[]} */
export function lineOf(node) {
  return node.children.filter((c) => c.kind !== 'ref')
}

/**
 * Live = a todo step, or something that contains one, never through a halted step.
 * Refs are looked up, not followed, so a todo flag on one never makes a line live.
 * @param {Node} node
 * @returns {boolean}
 */
export function isLive(node) {
  if (node.kind === 'ref') return false
  if (node.kind === 'step' || node.kind === 'project') {
    if (node.state === 'halt') return false
    if (node.state === 'todo') return true
  }
  return lineOf(node).some(isLive)
}

/**
 * Pre-order walk in file order. The root has depth 0. Returning `false` from `fn` skips
 * that node's children (the walk itself continues with its siblings).
 * @param {Node} root
 * @param {(node: Node, parent: Node | null, depth: number) => unknown} fn
 */
export function walk(root, fn) {
  const visit = (node, parent, depth) => {
    if (fn(node, parent, depth) === false) return
    for (const child of node.children) visit(child, node, depth + 1)
  }
  visit(root, null, 0)
}

/**
 * Locate a node by id. `index` is the position in `parent.children` (-1 for the root);
 * `path` lists the ancestors, root first, excluding the node itself.
 * @param {Node} root
 * @param {string} id
 * @returns {{ node: Node, parent: Node | null, index: number, path: Node[] } | null}
 */
export function findNode(root, id) {
  const path = []
  const search = (node, parent, index) => {
    if (node.id === id) return { node, parent, index, path: path.slice() }
    path.push(node)
    for (let i = 0; i < node.children.length; i += 1) {
      const hit = search(node.children[i], node, i)
      if (hit) return hit
    }
    path.pop()
    return null
  }
  return search(root, null, -1)
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomId(length) {
  let id = ''
  for (let i = 0; i < length; i += 1) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  return id
}

/**
 * A fresh random id, registered in `used` so a caller cannot forget to. Starts at four
 * characters and grows (up to eight) only when collisions keep happening.
 * @param {Set<string>} used
 * @returns {string}
 */
export function newId(used) {
  let length = 4
  let misses = 0
  for (;;) {
    const id = randomId(length)
    if (!used.has(id)) {
      used.add(id)
      return id
    }
    misses += 1
    if (misses >= 8 && length < 8) {
      length += 1
      misses = 0
    }
  }
}

/**
 * Totals over the whole tree. `todo`/`halt`/`steps` count steps only (a project's own
 * state is not a step); `questions` counts every node flagged as a doubt.
 * @param {Node} root
 * @returns {{ todo: number, halt: number, steps: number, questions: number }}
 */
export function counts(root) {
  const total = { todo: 0, halt: 0, steps: 0, questions: 0 }
  walk(root, (node) => {
    if (node.kind === 'step') {
      total.steps += 1
      if (node.state === 'todo') total.todo += 1
      if (node.state === 'halt') total.halt += 1
    }
    if (node.question) total.questions += 1
  })
  return total
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const UNNAMED = '（未命名）'

/**
 * The one-line "where" the panel and the model share, e.g.
 * `NAS→ZFS › 两台机器 › nas-b › 换盘（第 3 步）`. Returns '' for an unknown id.
 * @param {Node} root
 * @param {string} id
 * @returns {string}
 */
export function describePath(root, id) {
  const hit = findNode(root, id)
  if (!hit) return ''
  const parts = [clip(root.title || UNNAMED, 24)]
  if (hit.node === root) return parts[0]
  for (const ancestor of hit.path.slice(1)) {
    // an untitled fork is only a split in the line; naming it would add noise, not place
    if (ancestor.kind === 'fork' && !ancestor.title) continue
    parts.push(clip(ancestor.title || UNNAMED, 18))
  }
  const { node, parent } = hit
  const label = clip(node.title || (node.kind === 'fork' ? '（分叉）' : UNNAMED), 24)
  if (node.kind === 'step') parts.push(`${label}（第 ${lineOf(parent).indexOf(node) + 1} 步）`)
  else if (node.kind === 'ref') parts.push(`${label}（参考）`)
  else parts.push(label)
  return parts.join(' › ')
}

/** Deep copy. @param {Node} node @returns {Node} */
export function clone(node) {
  const copy = { ...node, attrs: { ...node.attrs }, children: node.children.map(clone) }
  return copy
}

function oneLine(title) {
  return String(title ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Build a node from a partial spec. The id is registered in `used`; a spec id is kept when
 * it is free (undo/insert re-uses ids), otherwise a new one is drawn.
 * @param {{ kind: string, title?: string, state?: string, question?: boolean, body?: string, attrs?: Record<string, string>, children?: Node[], id?: string }} spec
 * @param {Set<string>} [used]
 * @returns {Node}
 */
export function makeNode(spec, used = new Set()) {
  if (!spec || typeof spec !== 'object') throw new TreeError('invalid-op', '节点描述缺失')
  if (!KINDS.includes(spec.kind)) throw new TreeError('invalid-kind', `不支持的节点类型：${spec.kind}`)
  const state = spec.state ?? ''
  if (!STATES.includes(state)) throw new TreeError('invalid-state', `不支持的状态：${state}`)
  let id = typeof spec.id === 'string' && spec.id && !used.has(spec.id) ? spec.id : ''
  if (id) used.add(id)
  else id = newId(used)
  const node = {
    id,
    kind: spec.kind,
    title: oneLine(spec.title),
    state,
    question: Boolean(spec.question),
    body: spec.body ?? '',
    attrs: { ...(spec.attrs ?? {}) },
    children: spec.children ?? [],
  }
  if (spec.kind === 'project') node.preamble = ''
  return node
}
