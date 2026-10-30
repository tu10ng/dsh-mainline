/**
 * The file format (SPEC 2): one project = one Markdown file, heading depth = tree depth.
 *
 * The parser is total (any text yields a tree, nothing is dropped) and the writer is its
 * exact inverse on canonical text. Every escape below exists so that those two statements
 * hold at the same time; the reader and the writer share the helpers, never re-derive them.
 *
 * @module dsh-mainline/format
 */
import { TreeError } from './errors.js'

const HEADING = /^(#+)(?:[ \t]+([^\n]*))?$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
// A body line that would be read as structure: a heading, or a fence opener that has no
// closer in its own body. The latter is escaped too so that a closer-shaped line in a LATER
// body can never pair with it and swallow the headings between them.
const NEEDS_ESCAPE = /^ {0,3}\\*(?:#+(?:\s|$)|`{3,}|~{3,})/
const UNESCAPE = /^( {0,3})\\(\\*(?:#+(?:\s|$)|`{3,}|~{3,}))/
const TITLE_NEEDS_ESCAPE = /^(?:\\|(?:TODO|HALT|DONE|REF|FORK)(?:\s|$)|\?(?:\s|$))/
const KEY = /^[A-Za-z0-9_.:-]+$/
const TOKEN = /(?:#([A-Za-z0-9_-]+)|([A-Za-z0-9_.:-]+)(?:=(?:"([^"]*)"|([^\s}"]+)))?)(?=\s|$)/y
const BOM = /^﻿/

// ───────────────────────── fences ─────────────────────────

/** Flag every line that belongs to a CLOSED fence (opener and closer included). */
function scanFences(lines) {
  const code = new Uint8Array(lines.length)
  // once a search for (char, count) fails, no later opener needing at least as many can succeed
  const failed = { '`': Infinity, '~': Infinity }
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i])
    if (!open) {
      i += 1
      continue
    }
    const ch = open[1][0]
    const n = open[1].length
    let close = -1
    if (n < failed[ch]) {
      const closer = new RegExp(`^ {0,3}${ch}{${n},}\\s*$`)
      for (let j = i + 1; j < lines.length; j += 1) {
        if (closer.test(lines[j])) {
          close = j
          break
        }
      }
      if (close < 0) failed[ch] = n
    }
    if (close < 0) {
      i += 1
      continue
    }
    for (let k = i; k <= close; k += 1) code[k] = 1
    i = close + 1
  }
  return code
}

function escapeText(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const code = scanFences(lines)
  return lines.map((line, i) => (!code[i] && NEEDS_ESCAPE.test(line) ? line.replace(/^( {0,3})/, '$1\\') : line)).join('\n')
}

// ───────────────────────── attribute blocks ─────────────────────────

function parseBlock(inner) {
  const tokens = []
  let pos = 0
  for (;;) {
    while (pos < inner.length && (inner[pos] === ' ' || inner[pos] === '\t')) pos += 1
    if (pos >= inner.length) break
    TOKEN.lastIndex = pos
    const m = TOKEN.exec(inner)
    if (!m) return null
    if (m[1] !== undefined) tokens.push({ id: m[1] })
    else tokens.push({ key: m[2], value: m[3] !== undefined ? m[3] : (m[4] ?? '') })
    pos = TOKEN.lastIndex
  }
  return tokens.length ? tokens : null
}

/**
 * The rightmost `{...}` at the end of `s` that reads as an attribute block. `b` is the number
 * of backslashes written right before the `{`; `escaped` selects blocks with b >= 1 (title
 * text), b == 0 (the real block) or either ('any').
 */
function blockAtEnd(s, escaped) {
  if (!s.endsWith('}')) return null
  let k = s.lastIndexOf('{')
  while (k >= 0) {
    let b = 0
    while (k - b - 1 >= 0 && s[k - b - 1] === '\\') b += 1
    const p = k - b
    const boundary = p === 0 || s[p - 1] === ' ' || s[p - 1] === '\t'
    if (boundary && (escaped === 'any' || (escaped ? b >= 1 : b === 0))) {
      const tokens = parseBlock(s.slice(k + 1, -1))
      if (tokens) return { k, b, tokens }
    }
    if (k === 0) break
    k = s.lastIndexOf('{', k - 1)
  }
  return null
}

function setAttr(attrs, key, value) {
  // defineProperty so a key spelled __proto__ stays plain data
  Object.defineProperty(attrs, key, { value, enumerable: true, writable: true, configurable: true })
}

// ───────────────────────── reading ─────────────────────────

function fnv1a(text) {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0
  return h
}

function stemOf(file) {
  const stem = String(file ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
  return stem || '未命名'
}

/** Split into the preamble and heading items; bodies come back already unescaped. */
function split(lines) {
  const code = scanFences(lines)
  const preamble = []
  const items = []
  let target = preamble
  lines.forEach((line, i) => {
    const m = code[i] ? null : HEADING.exec(line)
    if (m) {
      const item = { depth: m[1].length, rest: (m[2] ?? '').trim(), lines: [] }
      items.push(item)
      target = item.lines
    } else {
      target.push(code[i] ? line : line.replace(UNESCAPE, '$1$2'))
    }
  })
  return { preamble, items }
}

function trimEdges(lines, leading) {
  let a = 0
  let b = lines.length
  if (leading) while (a < b && lines[a] === '') a += 1
  while (b > a && lines[b - 1] === '') b -= 1
  return lines.slice(a, b)
}

function decodeHeading(rest, parentKind, isRoot) {
  let s = rest
  let id = ''
  const attrs = {}
  const block = blockAtEnd(s, false)
  if (block) {
    s = s.slice(0, block.k).trimEnd()
    for (const t of block.tokens) {
      if (t.id !== undefined) id = id || t.id
      else setAttr(attrs, t.key, t.value)
    }
  }
  let state = ''
  let m = /^(TODO|HALT|DONE)(?:[ \t]+|$)/.exec(s)
  if (m) {
    state = m[1].toLowerCase()
    s = s.slice(m[0].length)
  }
  let marker = ''
  if (!isRoot) {
    // FORK is only a marker where a fork can occur; elsewhere it is title text (the writer escapes it)
    const forkOk = parentKind !== 'ref' && parentKind !== 'fork'
    m = /^(REF|FORK)(?:[ \t]+|$)/.exec(s)
    if (m && (m[1] === 'REF' || forkOk)) {
      marker = m[1]
      s = s.slice(m[0].length)
    }
  }
  let question = false
  m = /^\?(?:[ \t]+|$)/.exec(s)
  if (m) {
    question = true
    s = s.slice(m[0].length)
  }
  // inverse of escapeTitle, in the opposite order: tail first, then the leading backslash
  const tail = blockAtEnd(s, true)
  if (tail) s = s.slice(0, tail.k - 1) + s.slice(tail.k)
  if (s.startsWith('\\')) s = s.slice(1)
  // titles are one trimmed line; a hand-written `\ x` must not leave a title the writer would then change
  return { id, attrs, state, marker, question, title: s.trim() }
}

function kindFor(parentKind, marker) {
  if (parentKind === 'ref') return 'ref'
  if (parentKind === 'fork') return marker === 'REF' ? 'ref' : 'lane'
  if (marker === 'REF') return 'ref'
  return marker === 'FORK' ? 'fork' : 'step'
}

function buildNode(item, kind, head) {
  const node = {
    id: head.id,
    kind,
    title: head.title,
    state: head.state,
    question: head.question,
    body: trimEdges(item.lines, true).join('\n'),
    attrs: head.attrs,
    children: [],
  }
  if (kind === 'project') node.preamble = ''
  return node
}

function attach(container, items) {
  const stack = [{ depth: 0, node: container }]
  for (const item of items) {
    while (stack[stack.length - 1].depth >= item.depth) stack.pop()
    const parent = stack[stack.length - 1].node
    const head = decodeHeading(item.rest, parent.kind, false)
    const node = buildNode(item, kindFor(parent.kind, head.marker), head)
    parent.children.push(node)
    stack.push({ depth: item.depth, node })
  }
}

function assignIds(roots, file) {
  const used = new Set()
  const entries = []
  const collect = (node, path, index) => {
    const here = [...path, node.title]
    entries.push({ node, path: here, index })
    node.children.forEach((c, i) => collect(c, here, i))
  }
  roots.forEach((r, i) => collect(r, [], i))
  // explicit ids first, so a generated id can never steal one that appears later in the file
  for (const { node } of entries) {
    if (node.id && !used.has(node.id)) used.add(node.id)
    else node.id = ''
  }
  for (const { node, path, index } of entries) {
    if (node.id) continue
    const hash = fnv1a(`${file}\0${path.join('/')}\0${index}`).toString(36).padStart(5, '0')
    const base = `x${hash}`.slice(0, 6)
    let id = base
    for (let n = 2; used.has(id); n += 1) id = `${base}${n}`
    used.add(id)
    node.id = id
  }
}

function linesOf(text) {
  return String(text).replace(BOM, '').replace(/\r\n/g, '\n').split('\n')
}

/**
 * Parse a project file. Total: never throws on content.
 * @param {string} text
 * @param {{ file?: string }} [options] - `file` seeds deterministic ids and the fallback title
 * @returns {import('./tree.js').Node}
 */
export function parse(text, { file = '' } = {}) {
  const { preamble, items } = split(linesOf(text))
  let root
  let rest = items
  if (items.length && items[0].depth === 1) {
    root = buildNode(items[0], 'project', decodeHeading(items[0].rest, null, true))
    rest = items.slice(1)
  } else {
    // no leading H1: every heading (a later H1 included) lives under a project named after the file
    root = buildNode({ lines: [] }, 'project', { id: '', attrs: {}, state: '', question: false, title: stemOf(file) })
  }
  root.preamble = trimEdges(preamble, false).join('\n')
  attach(root, rest)
  assignIds([root], String(file ?? ''))
  return root
}

/**
 * Parse a fragment (the tools' `markdown`): the top-level nodes it contains.
 * Text before the first heading cannot be attached to anything, so it is refused rather than dropped.
 * @param {string} text
 * @param {{ file?: string, kindHint?: string }} [options] - `kindHint` is the kind of the node the fragment goes under (default 'step')
 * @returns {import('./tree.js').Node[]}
 */
export function parseSubtree(text, { file = '', kindHint = 'step' } = {}) {
  const { preamble, items } = split(linesOf(text))
  if (trimEdges(preamble, true).length) throw new TreeError('invalid-content', '片段必须以标题开头：标题之前的文字无处可放')
  const container = { kind: kindHint, children: [] }
  attach(container, items)
  assignIds(container.children, String(file ?? ''))
  return container.children
}

// ───────────────────────── writing ─────────────────────────

function escapeTitle(title) {
  let t = String(title ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (TITLE_NEEDS_ESCAPE.test(t)) t = `\\${t}`
  const tail = blockAtEnd(t, 'any')
  return tail ? `${t.slice(0, tail.k)}\\${t.slice(tail.k)}` : t
}

function attrToken(key, value) {
  if (!KEY.test(key)) throw new TreeError('invalid-attrs', `属性名不合法：${key}`)
  const v = String(value)
  if (/["\r\n]/.test(v)) throw new TreeError('invalid-attrs', `属性 ${key} 的值不能含引号或换行`)
  return /^[^\s}"]+$/.test(v) ? `${key}=${v}` : `${key}="${v}"`
}

function kindMarker(node, parentKind) {
  if (node.kind === 'fork') return 'FORK'
  // a ref under a ref is already implied by its parent; anywhere else the marker is what makes it one
  if (node.kind === 'ref') return parentKind === 'ref' ? '' : 'REF'
  return ''
}

function headingLine(node, depth, parentKind) {
  const parts = ['#'.repeat(depth)]
  if (node.state) parts.push(node.state.toUpperCase())
  const marker = kindMarker(node, parentKind)
  if (marker) parts.push(marker)
  if (node.question) parts.push('?')
  const title = escapeTitle(node.title)
  if (title) parts.push(title)
  const tokens = []
  if (node.id) tokens.push(`#${node.id}`)
  for (const [key, value] of Object.entries(node.attrs ?? {})) tokens.push(attrToken(key, value))
  if (tokens.length) parts.push(`{${tokens.join(' ')}}`)
  return parts.join(' ')
}

function emit(node, depth, parentKind, blocks) {
  blocks.push(headingLine(node, depth, parentKind))
  if (node.body) blocks.push(escapeText(node.body))
  for (const child of node.children) emit(child, depth + 1, node.kind, blocks)
}

/**
 * Serialize a node and everything below it, its heading at `depth`. A top-level ref always
 * carries its REF marker and a top-level lane none, since the parent is unknown here.
 * @param {import('./tree.js').Node} node
 * @param {number} [depth]
 * @returns {string}
 */
export function serializeSubtree(node, depth = 1) {
  const blocks = []
  emit(node, depth, null, blocks)
  return `${blocks.join('\n\n')}\n`
}

/**
 * Serialize a whole project, preamble first. Always `\n` line endings, one final newline.
 * @param {import('./tree.js').Node} root
 * @returns {string}
 */
export function serialize(root) {
  const blocks = []
  const preamble = String(root.preamble ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (preamble) blocks.push(escapeText(preamble))
  emit(root, 1, null, blocks)
  return `${blocks.join('\n\n')}\n`
}
