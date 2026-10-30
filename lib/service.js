/**
 * The single write path for the tree.
 *
 * The panel (through the routes) and the model (through the tools) both end up in `apply` or
 * `writeMarkdown`, so a rule added here holds for both at once. Every op validates its input
 * strictly, mutates a freshly parsed tree inside `store.update` (which holds the lock), then
 * announces what happened and asks git to record it.
 *
 * Mutations run **inside** the store's read-modify-write, and the store may run them again on
 * newer text, so each one only touches the tree it is given and returns what it learned; the
 * events are built from that return value afterwards.
 *
 * @module dsh-mainline/service
 */

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { atomicWrite } from './atomic.js'
import { TreeError } from './errors.js'
import { parse, parseSubtree, serialize, serializeSubtree } from './format.js'
import { createStore } from './store.js'
import { KINDS, STATES, canContain, clone, counts, describePath, findNode, makeNode, newId, walk } from './tree.js'
import { createWatch, diffTrees } from './watch.js'

const MAX_TITLE = 300
const MAX_BODY = 100_000
const MAX_MARKDOWN = 2_000_000
const MAX_LANES = 50
const ACTOR_KINDS = ['human', 'agent', 'external', 'system']
const ATTR_KEY = /^[A-Za-z0-9_.:-]+$/

const KIND_ZH = { project: '项目', step: '步骤', fork: '分叉', lane: '支线', ref: '参考' }
const STATE_ZH = { '': '记录', todo: '要做', halt: '不用做' }

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalidOp = (message) => new TreeError('invalid-op', message)

// ───────────────────────── validation ─────────────────────────

/** Unknown keys are refused: a typo like `parnet` must fail loudly, not be ignored. */
function checkKeys(object, allowed, label) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw invalidOp(`${label} 不认识字段 ${key}`)
}

function requireString(value, name) {
  if (typeof value !== 'string' || value === '') throw invalidOp(`缺少 ${name}`)
  return value
}

function optionalId(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalidOp(`${name} 必须是字符串`)
  return value
}

/** Trim, fold newlines to spaces, enforce 1–300 chars (a fork may have no title). */
function cleanTitle(value, allowEmpty = false) {
  if (typeof value !== 'string') throw new TreeError('invalid-title', '标题必须是文字')
  const title = value.replace(/[\r\n]+/g, ' ').trim()
  if (title.length > MAX_TITLE) throw new TreeError('invalid-title', `标题最多 ${MAX_TITLE} 个字符（现在 ${title.length}）`)
  if (title === '' && !allowEmpty) throw new TreeError('invalid-title', '标题不能为空')
  return title
}

/** `\n` endings, no blank edges: the shape the parser hands back, so the cache never disagrees with the file. */
function cleanBody(value) {
  if (typeof value !== 'string') throw new TreeError('invalid-content', '正文必须是文字')
  if (value.length > MAX_BODY) throw new TreeError('invalid-content', `正文最多 ${MAX_BODY} 个字符（现在 ${value.length}）`)
  return value.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '')
}

function cleanState(value) {
  if (!STATES.includes(value)) throw new TreeError('invalid-state', `状态必须是 ${STATES.map((s) => `'${s}'`).join(' / ')}`)
  return value
}

function cleanQuestion(value) {
  if (typeof value !== 'boolean') throw invalidOp('question 必须是 true 或 false')
  return value
}

function cleanAttrValue(key, value) {
  if (typeof value !== 'string' || /[\r\n"]/.test(value)) throw new TreeError('invalid-attrs', `属性 ${key} 的值必须是不含换行和引号的文字`)
  return value
}

function cleanAttrs(value) {
  if (!isPlain(value)) throw new TreeError('invalid-attrs', 'attrs 必须是对象')
  const out = {}
  for (const [key, v] of Object.entries(value)) {
    if (!ATTR_KEY.test(key)) throw new TreeError('invalid-attrs', `属性名不合法：${key}`)
    out[key] = cleanAttrValue(key, v)
  }
  return out
}

function cleanSetAttrs(value) {
  if (!isPlain(value)) throw new TreeError('invalid-attrs', 'setAttrs 必须是对象')
  for (const [key, v] of Object.entries(value)) {
    if (!ATTR_KEY.test(key)) throw new TreeError('invalid-attrs', `属性名不合法：${key}`)
    if (v !== null) cleanAttrValue(key, v)
  }
  return value
}

function cleanKind(value) {
  if (!KINDS.includes(value) || value === 'project') throw new TreeError('invalid-kind', `不能创建这种节点：${value}`)
  return value
}

function normalizeActor(actor) {
  if (!isPlain(actor) || !ACTOR_KINDS.includes(actor.kind)) return { kind: 'system' }
  return actor.session === undefined ? { kind: actor.kind } : { kind: actor.kind, session: String(actor.session) }
}

/** Content that comes from Markdown is parsed total, so it is only checked for size, never reshaped. */
function checkParsed(nodes) {
  for (const root of nodes) {
    walk(root, (node) => {
      if (node.title.length > MAX_TITLE) throw new TreeError('invalid-title', `标题最多 ${MAX_TITLE} 个字符：「${node.title.slice(0, 20)}…」`)
      if (node.body.length > MAX_BODY) throw new TreeError('invalid-content', `正文最多 ${MAX_BODY} 个字符：「${node.title.slice(0, 20)}」`)
    })
  }
}

// ───────────────────────── tree helpers ─────────────────────────

const idsOf = (tree) => {
  const ids = new Set()
  walk(tree, (node) => ids.add(node.id))
  return ids
}

function locateOrThrow(tree, id, name = '节点') {
  const hit = findNode(tree, id)
  if (!hit) throw new TreeError('not-found', `找不到${name} ${id}`)
  return hit
}

/** Where a new child goes: omitted = last, '' = first, otherwise right after that sibling. */
function placeIndex(parent, after) {
  if (after === undefined) return parent.children.length
  if (after === '') return 0
  const index = parent.children.findIndex((child) => child.id === after)
  if (index < 0) throw invalidOp(`${after} 不是 ${parent.title || parent.id} 的子节点，放不到它后面`)
  return index + 1
}

function subtreeSize(node) {
  let n = 0
  walk(node, () => (n += 1))
  return n
}

const wrap = (children) => ({ id: '\0', title: '', state: '', question: false, body: '', attrs: {}, children })

function attrsText(attrs) {
  return Object.entries(attrs ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')
}

/** Rebuild an inserted subtree: validated, with every colliding id replaced. Lenient on empty titles — this is undo. */
function rebuild(raw, parentKind, used) {
  if (!isPlain(raw)) throw invalidOp('node 必须是对象')
  const kind = cleanKind(raw.kind)
  if (!canContain(parentKind, kind)) throw new TreeError('invalid-kind', `${KIND_ZH[parentKind]}下不能放${KIND_ZH[kind]}`)
  const node = makeNode(
    {
      id: typeof raw.id === 'string' ? raw.id : undefined,
      kind,
      title: cleanTitle(raw.title ?? '', true),
      state: cleanState(raw.state ?? ''),
      question: raw.question === undefined ? false : cleanQuestion(raw.question),
      body: cleanBody(raw.body ?? ''),
      attrs: raw.attrs === undefined ? {} : cleanAttrs(raw.attrs),
    },
    used,
  )
  const children = raw.children === undefined ? [] : raw.children
  if (!Array.isArray(children)) throw invalidOp('children 必须是数组')
  node.children = children.map((child) => rebuild(child, kind, used))
  return node
}

// ───────────────────────── the service ─────────────────────────

/**
 * @param {{ root: string, logger?: object, events: object, git?: object, now?: () => number, renameAttempts?: number, watchDebounceMs?: number, lockTimeoutMs?: number }} options
 */
export function createService({ root, logger, events, git, watchDebounceMs, lockTimeoutMs, renameAttempts }) {
  const store = createStore({ root, logger, lockTimeoutMs, renameAttempts })
  let readyPromise = null
  let watcher = null

  // ── events and git ──

  const gitSchedule = (summary, actor) => {
    try {
      git?.schedule?.(summary, actor)
    } catch (error) {
      logger?.warn?.(`dsh-mainline: git.schedule 失败：${error?.message ?? error}`)
    }
  }

  /** Announce `parts` as events of `projectId`, then ask git to record the op once. */
  function announce(parts, projectId, actor) {
    const published = parts.map((part) => events.publish({ ...part, project: projectId, actor }))
    if (published.length > 0) gitSchedule(published[0].summary, actor)
    return published
  }

  const projectView = (entry) => ({ id: entry.id, file: entry.file, rev: entry.rev, root: entry.root })

  // ── reading ──

  function listProjects() {
    return store.list().map(({ id, file, root: tree }) => {
      const { todo, halt, steps } = counts(tree)
      return { id, file, title: tree.title, state: tree.state, todo, halt, steps }
    })
  }

  const getProject = (id) => projectView(store.get(String(id)))

  function locate(projectId, nodeId) {
    const entry = store.find(projectId)
    return entry ? findNode(entry.root, nodeId) : null
  }

  function where(projectId, nodeId) {
    const entry = store.find(projectId)
    return entry ? describePath(entry.root, nodeId) : ''
  }

  function readMarkdown(projectId, nodeId) {
    const entry = store.get(projectId)
    if (!nodeId || nodeId === entry.root.id) {
      return { markdown: serialize(entry.root), rev: entry.rev, where: describePath(entry.root, entry.root.id) }
    }
    const hit = locateOrThrow(entry.root, nodeId)
    return { markdown: serializeSubtree(hit.node, 1), rev: entry.rev, where: describePath(entry.root, nodeId) }
  }

  // ── ops: each returns { nodeId, removed?, parts: [event], noop? } ──

  const OPS = {
    async create(op) {
      checkKeys(op, ['type', 'project', 'parent', 'after', 'kind', 'title', 'state', 'question', 'body', 'attrs'], 'create')
      const entry = store.get(requireString(op.project, 'project'))
      const parentId = requireString(op.parent, 'parent')
      const after = optionalId(op.after, 'after')
      const kind = cleanKind(op.kind)
      const spec = {
        kind,
        title: cleanTitle(op.title, kind === 'fork'),
        state: cleanState(op.state ?? ''),
        question: op.question === undefined ? false : cleanQuestion(op.question),
        body: cleanBody(op.body ?? ''),
        attrs: op.attrs === undefined ? {} : cleanAttrs(op.attrs),
      }
      const { value } = await store.update(entry.id, (tree) => {
        const parent = locateOrThrow(tree, parentId, '父节点').node
        if (!canContain(parent.kind, kind)) throw new TreeError('invalid-kind', `${KIND_ZH[parent.kind]}下不能放${KIND_ZH[kind]}`)
        const index = placeIndex(parent, after)
        const node = makeNode(spec, idsOf(tree))
        parent.children.splice(index, 0, node)
        return { id: node.id, where: describePath(tree, node.id) }
      })
      return {
        nodeId: value.id,
        parts: [{ type: 'node/created', node: value.id, summary: `添加了${KIND_ZH[kind]}：${value.where}`, data: { kind, title: spec.title, parent: parentId, after: after ?? null } }],
      }
    },

    async update(op) {
      checkKeys(op, ['type', 'project', 'id', 'patch'], 'update')
      const entry = store.get(requireString(op.project, 'project'))
      const id = requireString(op.id, 'id')
      if (!isPlain(op.patch)) throw invalidOp('patch 必须是对象')
      const patch = op.patch
      checkKeys(patch, ['title', 'state', 'question', 'body', 'attrs', 'append', 'setAttrs'], 'patch')
      if (patch.body !== undefined && patch.append !== undefined) throw invalidOp('body 和 append 不能同时给')
      if (patch.attrs !== undefined && patch.setAttrs !== undefined) throw invalidOp('attrs 和 setAttrs 不能同时给')
      const want = {}
      if (patch.title !== undefined) want.title = cleanTitle(patch.title, true)
      if (patch.state !== undefined) want.state = cleanState(patch.state)
      if (patch.question !== undefined) want.question = cleanQuestion(patch.question)
      if (patch.body !== undefined) want.body = cleanBody(patch.body)
      if (patch.attrs !== undefined) want.attrs = cleanAttrs(patch.attrs)
      const append = patch.append === undefined ? undefined : cleanBody(patch.append)
      const setAttrs = patch.setAttrs === undefined ? undefined : cleanSetAttrs(patch.setAttrs)

      const { value } = await store.update(entry.id, (tree) => {
        const node = locateOrThrow(tree, id).node
        const next = { ...want }
        // append and setAttrs are computed from the text under the lock, which is the whole point of them
        if (append !== undefined && append !== '') next.body = node.body ? `${node.body}\n\n${append}` : append
        if (next.body !== undefined && next.body.length > MAX_BODY) throw new TreeError('invalid-content', `正文最多 ${MAX_BODY} 个字符`)
        if (setAttrs !== undefined) {
          const merged = { ...node.attrs }
          for (const [key, v] of Object.entries(setAttrs)) {
            if (v === null) delete merged[key]
            else merged[key] = v
          }
          next.attrs = merged
        }
        if (next.title === '' && node.kind !== 'fork' && node.kind !== 'lane') throw new TreeError('invalid-title', '标题不能为空')
        const fields = ['title', 'state', 'question', 'body', 'attrs'].filter((f) => {
          if (next[f] === undefined) return false
          return f === 'attrs' ? attrsText(next.attrs) !== attrsText(node.attrs) || Object.keys(next.attrs).length !== Object.keys(node.attrs).length : next[f] !== node[f]
        })
        if (fields.length === 0) return { noop: true, id }
        const before = {}
        const after = {}
        for (const f of fields) {
          if (f === 'body') (before.body = node.body.length, after.body = next.body.length)
          else if (f === 'attrs') (before.attrs = attrsText(node.attrs), after.attrs = attrsText(next.attrs))
          else (before[f] = node[f], after[f] = next[f])
          node[f] = next[f]
        }
        return { id, fields, before, after, where: describePath(tree, id) }
      })
      if (value.noop) return { nodeId: id, parts: [], noop: true }
      const pieces = []
      if (value.fields.includes('title')) pieces.push(`改名为「${value.after.title}」`)
      if (value.fields.includes('state')) pieces.push(`标为${STATE_ZH[value.after.state]}`)
      if (value.fields.includes('question')) pieces.push(value.after.question ? '标为疑问' : '取消疑问')
      if (value.fields.includes('body')) pieces.push('改了正文')
      if (value.fields.includes('attrs')) pieces.push('改了属性')
      return {
        nodeId: id,
        parts: [{ type: 'node/updated', node: id, summary: `修改了 ${value.where}：${pieces.join('、')}`, data: { fields: value.fields, before: value.before, after: value.after } }],
      }
    },

    async move(op) {
      checkKeys(op, ['type', 'project', 'id', 'parent', 'after'], 'move')
      const entry = store.get(requireString(op.project, 'project'))
      const id = requireString(op.id, 'id')
      const parentId = requireString(op.parent, 'parent')
      const after = optionalId(op.after, 'after')
      const { value } = await store.update(entry.id, (tree) => {
        const hit = locateOrThrow(tree, id)
        if (!hit.parent) throw new TreeError('invalid-move', '项目本身不能移动')
        const target = locateOrThrow(tree, parentId, '目标父节点').node
        // findNode on the moved node finds it too, which covers "into itself"
        if (findNode(hit.node, parentId)) throw new TreeError('invalid-move', '不能把节点移进它自己或它的子孙里')
        if (!canContain(target.kind, hit.node.kind)) throw new TreeError('invalid-move', `${KIND_ZH[target.kind]}下不能放${KIND_ZH[hit.node.kind]}`)
        if (after === id) throw new TreeError('invalid-move', '不能放在自己后面')
        const whereBefore = describePath(tree, id)
        const from = hit.parent
        from.children.splice(hit.index, 1)
        const index = placeIndex(target, after)
        target.children.splice(index, 0, hit.node)
        if (from === target && index === hit.index) return { noop: true }
        return { whereBefore, whereAfter: describePath(tree, id), fromParent: from.id, toParent: target.id }
      })
      if (value.noop) return { nodeId: id, parts: [], noop: true }
      return {
        nodeId: id,
        parts: [{ type: 'node/moved', node: id, summary: `移动了 ${value.whereBefore}，现在在 ${value.whereAfter}`, data: { fromParent: value.fromParent, toParent: value.toParent, after: after ?? null } }],
      }
    },

    async remove(op) {
      checkKeys(op, ['type', 'project', 'id'], 'remove')
      const entry = store.get(requireString(op.project, 'project'))
      const id = requireString(op.id, 'id')
      const { value } = await store.update(entry.id, (tree) => {
        const hit = locateOrThrow(tree, id)
        if (!hit.parent) throw invalidOp('项目本身要用 removeProject 删除')
        const result = { removed: clone(hit.node), where: describePath(tree, id), count: subtreeSize(hit.node) }
        hit.parent.children.splice(hit.index, 1)
        return result
      })
      const { removed, count } = value
      return {
        nodeId: null,
        removed,
        parts: [{ type: 'node/removed', node: id, summary: `删除了${KIND_ZH[removed.kind]}：${value.where}${count > 1 ? `（连同下面共 ${count} 个节点）` : ''}`, data: { kind: removed.kind, title: removed.title, count } }],
      }
    },

    async insert(op) {
      checkKeys(op, ['type', 'project', 'parent', 'after', 'node'], 'insert')
      const entry = store.get(requireString(op.project, 'project'))
      const parentId = requireString(op.parent, 'parent')
      const after = optionalId(op.after, 'after')
      const { value } = await store.update(entry.id, (tree) => {
        const parent = locateOrThrow(tree, parentId, '父节点').node
        const node = rebuild(op.node, parent.kind, idsOf(tree))
        parent.children.splice(placeIndex(parent, after), 0, node)
        return { id: node.id, kind: node.kind, title: node.title, where: describePath(tree, node.id) }
      })
      return {
        nodeId: value.id,
        parts: [{ type: 'node/created', node: value.id, summary: `恢复了${KIND_ZH[value.kind]}：${value.where}`, data: { kind: value.kind, title: value.title, parent: parentId, after: after ?? null } }],
      }
    },

    async fork(op) {
      checkKeys(op, ['type', 'project', 'after', 'title', 'lanes'], 'fork')
      const entry = store.get(requireString(op.project, 'project'))
      const afterId = requireString(op.after, 'after')
      const title = op.title === undefined ? '' : cleanTitle(op.title, true)
      if (!Array.isArray(op.lanes) || op.lanes.length < 2) throw invalidOp('分叉至少要两条支线')
      if (op.lanes.length > MAX_LANES) throw invalidOp(`分叉最多 ${MAX_LANES} 条支线`)
      const names = op.lanes.map((lane) => cleanTitle(lane))
      const { value } = await store.update(entry.id, (tree) => {
        const hit = locateOrThrow(tree, afterId, '位置')
        if (!hit.parent || (hit.node.kind !== 'step' && hit.node.kind !== 'fork')) throw new TreeError('invalid-kind', '分叉只能接在步骤或分叉后面')
        if (!canContain(hit.parent.kind, 'fork')) throw new TreeError('invalid-kind', `${KIND_ZH[hit.parent.kind]}下不能放分叉`)
        const used = idsOf(tree)
        const fork = makeNode({ kind: 'fork', title }, used)
        fork.children = names.map((name) => makeNode({ kind: 'lane', title: name }, used))
        hit.parent.children.splice(hit.index + 1, 0, fork)
        return { id: fork.id, where: describePath(tree, hit.node.id) }
      })
      return {
        nodeId: value.id,
        parts: [{ type: 'node/created', node: value.id, summary: `在 ${value.where} 之后分出 ${names.length} 条支线：${names.join('、')}`, data: { kind: 'fork', title, parent: null, after: afterId } }],
      }
    },

    /**
     * A new step beside `parent`'s line, parallel to it rather than after anything. A line that
     * is already nothing but one split (a fork, nothing after it) gets one more lane; any other
     * line is split first — its items into an unnamed lane, the step into a second; an empty
     * line just gets the step. Nothing has to be named, and the line beside it stays exactly as
     * it was, two levels deeper.
     */
    async branch(op) {
      checkKeys(op, ['type', 'project', 'parent', 'title', 'state', 'question', 'body'], 'branch')
      const entry = store.get(requireString(op.project, 'project'))
      const parentId = requireString(op.parent, 'parent')
      const spec = {
        kind: 'step',
        title: cleanTitle(op.title),
        state: cleanState(op.state ?? ''),
        question: op.question === undefined ? false : cleanQuestion(op.question),
        body: cleanBody(op.body ?? ''),
      }
      const { value } = await store.update(entry.id, (tree) => {
        const parent = locateOrThrow(tree, parentId, '父节点').node
        if (!canContain(parent.kind, 'fork')) throw new TreeError('invalid-kind', `${KIND_ZH[parent.kind]}下不能分叉`)
        const used = idsOf(tree)
        const step = makeNode(spec, used)
        const lane = makeNode({ kind: 'lane', title: '' }, used)
        lane.children = [step]
        const line = parent.children.filter((child) => child.kind !== 'ref')
        // Beside nothing is simply the first step: a split with one lane would only add depth.
        if (line.length === 0) {
          parent.children.push(step)
          return { id: step.id, fork: null, where: describePath(tree, step.id), moved: 0 }
        }
        let fork = line.length === 1 && line[0].kind === 'fork' ? line[0] : null
        let moved = 0
        if (fork) {
          const last = fork.children.findLastIndex((child) => child.kind === 'lane')
          fork.children.splice(last + 1, 0, lane)
        } else {
          fork = makeNode({ kind: 'fork', title: '' }, used)
          const first = makeNode({ kind: 'lane', title: '' }, used)
          first.children = line
          fork.children = [first, lane]
          moved = line.length
          // The references stay with the parent, above the line, as they were in the file.
          parent.children = [...parent.children.filter((child) => child.kind === 'ref'), fork]
        }
        return { id: step.id, fork: fork.id, where: describePath(tree, step.id), moved }
      })
      return {
        nodeId: value.id,
        parts: [
          {
            type: 'node/created',
            node: value.id,
            summary: value.moved > 0 ? `另起一条线：${value.where}（原来的 ${value.moved} 项放进旁边那条）` : `另起一条线：${value.where}`,
            data: { kind: 'step', title: spec.title, parent: parentId, after: null, fork: value.fork, kept: value.moved },
          },
        ],
      }
    },

    async createProject(op) {
      checkKeys(op, ['type', 'title', 'body', 'markdown'], 'createProject')
      const title = cleanTitle(op.title)
      const body = op.body === undefined ? undefined : cleanBody(op.body)
      if (op.markdown !== undefined && (typeof op.markdown !== 'string' || op.markdown.length > MAX_MARKDOWN)) {
        throw new TreeError('invalid-content', `markdown 必须是不超过 ${MAX_MARKDOWN} 字符的文字`)
      }
      const entry = await store.createProject({
        title,
        build({ file, used }) {
          let tree
          if (op.markdown !== undefined) {
            tree = parse(op.markdown, { file })
            checkParsed([tree])
            // the name the caller gave wins over an H1 in the import: they asked for it by name
            tree.title = title
            if (body) tree.body = body
          } else {
            tree = makeNode({ kind: 'project', title, body: body ?? '' }, used)
          }
          return tree
        },
      })
      return {
        projectId: entry.id,
        nodeId: entry.id,
        parts: [{ type: 'project/created', node: entry.id, summary: `新建了项目「${title}」（${entry.file}）`, data: { file: entry.file, title } }],
      }
    },

    async removeProject(op) {
      checkKeys(op, ['type', 'project'], 'removeProject')
      const entry = await store.removeProject(requireString(op.project, 'project'))
      return {
        projectId: entry.id,
        nodeId: null,
        gone: true,
        parts: [{ type: 'project/removed', summary: `删除了项目「${entry.root.title}」（${entry.file}，历史还在）`, data: { file: entry.file, title: entry.root.title } }],
      }
    },

    async renameProject(op) {
      checkKeys(op, ['type', 'project', 'title'], 'renameProject')
      const id = requireString(op.project, 'project')
      return OPS.update({ type: 'update', project: id, id, patch: { title: cleanTitle(op.title) } })
    },

    async reorderProjects(op) {
      checkKeys(op, ['type', 'order'], 'reorderProjects')
      if (!Array.isArray(op.order) || op.order.some((id) => typeof id !== 'string')) throw invalidOp('order 必须是项目 id 数组')
      if (new Set(op.order).size !== op.order.length) throw invalidOp('order 里有重复的项目')
      const result = await store.reorder(op.order)
      if (!result.changed) return { projectId: null, nodeId: null, parts: [], noop: true }
      return { projectId: null, nodeId: null, parts: [{ type: 'projects/reordered', summary: '调整了项目的顺序', data: { order: result.order } }] }
    },

    async restore(op) {
      checkKeys(op, ['type', 'project', 'rev'], 'restore')
      const entry = store.get(requireString(op.project, 'project'))
      const rev = requireString(op.rev, 'rev')
      if (!git) throw new TreeError('git-unavailable', '没有 git，没法恢复历史版本')
      const text = await git.show(rev, entry.file)
      const old = parse(text, { file: entry.file })
      checkParsed([old])
      const { value } = await store.update(entry.id, (tree) => {
        const restored = { ...old, id: tree.id }
        // a restore is written like any edit: through the lock, as a new version on top
        if (serialize(restored) === serialize(tree)) return { noop: true }
        Object.assign(tree, restored)
        return { title: tree.title }
      })
      if (value.noop) return { nodeId: null, parts: [], noop: true }
      return {
        nodeId: null,
        parts: [{ type: 'project/restored', summary: `把项目「${value.title}」恢复到了版本 ${rev.slice(0, 7)}`, data: { file: entry.file, title: value.title, rev } }],
      }
    },
  }

  /**
   * Run one op.
   *
   * @param {object} op `{ type, ... }` per the table in SPEC 3.6
   * @param {{ kind: string, session?: string }} actor
   * @returns {Promise<{ project: object | null, nodeId: string | null, removed?: object, events: object[] }>}
   */
  async function apply(op, actor) {
    if (!isPlain(op)) throw invalidOp('op 必须是对象')
    const handler = typeof op.type === 'string' && Object.hasOwn(OPS, op.type) ? OPS[op.type] : null
    if (!handler) throw invalidOp(`不认识的操作：${String(op.type)}`)
    const who = normalizeActor(actor)
    const result = await handler(op)
    const projectId = result.projectId ?? (typeof op.project === 'string' ? op.project : null)
    const published = announce(result.parts, projectId, who)
    const entry = result.gone ? null : projectId ? store.find(projectId) : null
    return {
      project: entry ? projectView(entry) : null,
      nodeId: result.nodeId ?? null,
      ...(result.removed === undefined ? {} : { removed: result.removed }),
      events: published,
    }
  }

  /**
   * Replace a node's subtree (or the whole project when `nodeId` is null) with Markdown in the file format.
   * Ids present in the text are kept; ids already used elsewhere in the project are replaced.
   */
  async function writeMarkdown(projectId, nodeId, markdown, actor) {
    if (typeof markdown !== 'string') throw new TreeError('invalid-content', 'markdown 必须是文字')
    if (markdown.length > MAX_MARKDOWN) throw new TreeError('invalid-content', `markdown 最多 ${MAX_MARKDOWN} 个字符`)
    const entry = store.get(String(projectId))
    const whole = nodeId === null || nodeId === undefined || nodeId === '' || nodeId === entry.root.id
    const { value } = await store.update(entry.id, (tree) => {
      if (whole) {
        const next = parse(markdown, { file: entry.file })
        checkParsed([next])
        next.id = tree.id
        const diff = diffTrees(tree, next)
        if (serialize(next) === serialize(tree)) return { noop: true }
        Object.assign(tree, next)
        return { ...diff, where: describePath(tree, tree.id), nodeId: null }
      }
      const hit = locateOrThrow(tree, nodeId)
      const parent = hit.parent
      // the parent decides what an unmarked heading means (a step under a project, a lane under a fork)
      const nodes = parseSubtree(markdown, { file: entry.file, kindHint: parent.kind })
      if (nodes.length === 0) throw new TreeError('invalid-content', 'markdown 里没有任何标题；要删除节点请用 remove')
      for (const node of nodes) {
        if (!canContain(parent.kind, node.kind)) throw new TreeError('invalid-kind', `${KIND_ZH[parent.kind]}下不能放${KIND_ZH[node.kind]}`)
      }
      checkParsed(nodes)
      const used = idsOf(tree)
      walk(hit.node, (n) => used.delete(n.id))
      const kept = new Set()
      for (const top of nodes) {
        walk(top, (n) => {
          if (used.has(n.id) || kept.has(n.id)) n.id = newId(new Set([...used, ...kept]))
          kept.add(n.id)
        })
      }
      // text that already says what the tree says is not an edit
      if (nodes.length === 1 && serializeSubtree(nodes[0], 1) === serializeSubtree(hit.node, 1)) return { noop: true }
      const diff = diffTrees(wrap([hit.node]), wrap(nodes))
      parent.children.splice(hit.index, 1, ...nodes)
      return { ...diff, where: describePath(tree, nodes[0].id), nodeId: nodes[0].id }
    })
    const who = normalizeActor(actor)
    if (value.noop) return { project: projectView(store.get(entry.id)), nodeId: null, events: [] }
    const target = whole ? entry.root.id : value.nodeId
    const published = announce(
      [
        {
          type: 'node/updated',
          node: target,
          summary: `用 Markdown 重写了 ${value.where}（新增 ${value.added.length}、删除 ${value.removed.length}、改动 ${value.changed.length} 个节点）`,
          data: { fields: ['markdown'], before: { length: 0 }, after: { length: markdown.length }, added: value.added, removed: value.removed, changed: value.changed },
        },
      ],
      entry.id,
      who,
    )
    return { project: projectView(store.get(entry.id)), nodeId: value.nodeId, events: published }
  }

  async function history(projectId, limit) {
    if (!git) throw new TreeError('git-unavailable', '没有 git，看不了历史')
    const file = projectId ? store.get(String(projectId)).file : undefined
    return git.log({ file, limit })
  }

  function focus(projectId, nodeId, actor) {
    const entry = store.get(String(projectId))
    const place = describePath(entry.root, nodeId || entry.root.id) || describePath(entry.root, entry.root.id)
    events.publish({
      type: 'view/focus',
      actor: normalizeActor(actor),
      project: entry.id,
      node: nodeId || null,
      summary: `聚焦 ${place}`,
      data: { where: place },
    })
  }

  // ── view state: per-user, local, never committed, so no project lock ──

  const viewFile = (projectId) => {
    store.get(String(projectId)) // not-found for a stale id
    return path.join(store.local, 'view', `${String(projectId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }

  async function readView(projectId) {
    const file = viewFile(projectId)
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      return isPlain(parsed) ? parsed : {}
    } catch {
      // missing or damaged: a view is only a convenience, start from the defaults
      return {}
    }
  }

  async function writeView(projectId, view) {
    if (!isPlain(view)) throw new TreeError('invalid-request', 'view 必须是对象')
    const file = viewFile(projectId)
    await mkdir(path.dirname(file), { recursive: true })
    await atomicWrite(file, JSON.stringify(view))
  }

  // ── life cycle ──

  function onExternalEdit({ id, file, title, added, removed, changed }) {
    const same = added.length + removed.length + changed.length === 0
    const detail = same ? '只有格式变化' : `新增 ${added.length}、删除 ${removed.length}、改动 ${changed.length} 处`
    const event = events.publish({
      type: 'tree/external',
      actor: { kind: 'external' },
      project: id,
      summary: `在外部改了项目「${title}」（${file}）：${detail}`,
      data: { file, added, removed, changed },
    })
    gitSchedule(event.summary, event.actor)
  }

  function onAppear({ id, file, title }) {
    const event = events.publish({ type: 'project/created', actor: { kind: 'external' }, project: id, node: id, summary: `外部新增了项目「${title}」（${file}）`, data: { file, title } })
    gitSchedule(event.summary, event.actor)
  }

  function onDisappear({ id, file, title }) {
    const event = events.publish({ type: 'project/removed', actor: { kind: 'external' }, project: id, summary: `项目「${title}」的文件 ${file} 被外部移走或删除`, data: { file, title } })
    gitSchedule(event.summary, event.actor)
  }

  function onOrder() {
    const event = events.publish({ type: 'projects/reordered', actor: { kind: 'external' }, summary: '外部调整了项目的顺序', data: { order: store.list().map((e) => e.id) } })
    gitSchedule(event.summary, event.actor)
  }

  async function start() {
    try {
      await mkdir(root, { recursive: true })
    } catch (error) {
      throw new TreeError('store-unwritable', `建不了目录 ${root}：${error?.message ?? error}`)
    }
    // git first, so the first commit already contains whatever is in the folder
    try {
      await git?.init?.()
    } catch (error) {
      logger?.warn?.(`dsh-mainline: git.init 失败：${error?.message ?? error}`)
    }
    const { changed } = await store.load()
    watcher = createWatch({ root, store, logger, debounceMs: watchDebounceMs, onEdit: onExternalEdit, onAppear, onDisappear, onOrder })
    watcher.start()
    if (git?.available && (changed || (await git.dirty?.()))) gitSchedule('整理工作树', { kind: 'system' })
  }

  return {
    root,
    ready: () => (readyPromise ??= start()),
    async close() {
      watcher?.close()
      try {
        await git?.flush?.()
      } catch (error) {
        logger?.warn?.(`dsh-mainline: 关闭时提交失败：${error?.message ?? error}`)
      }
    },
    /** Resolves when pending external edits have been processed (tests). */
    idle: async () => watcher?.idle(),
    listProjects,
    getProject,
    apply,
    readMarkdown,
    writeMarkdown,
    history,
    where,
    locate,
    focus,
    readView,
    writeView,
  }
}
