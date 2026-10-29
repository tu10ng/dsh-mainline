import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parse, serialize, serializeSubtree, parseSubtree } from '../lib/format.js'
import { canContain, walk, findNode } from '../lib/tree.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const fixtureFiles = readdirSync(FIXTURES).filter((f) => f.endsWith('.md')).sort()

const kinds = (root) => {
  const out = []
  walk(root, (node) => { out.push(`${node.kind}:${node.title}`) })
  return out
}
const find = (root, title) => {
  let hit = null
  walk(root, (node) => { if (!hit && node.title === title) hit = node })
  return hit
}

// ───────────────────────── fixtures ─────────────────────────

test('there are the six fixture projects', () => {
  assert.deepEqual(fixtureFiles, ['backup.md', 'blog.md', 'cleanup.md', 'homelab.md', 'printer.md', 'router.md'])
})

for (const file of fixtureFiles) {
  test(`fixture ${file} round-trips byte for byte`, () => {
    const text = readFileSync(join(FIXTURES, file), 'utf8')
    assert.ok(!text.includes('\r'))
    assert.equal(serialize(parse(text, { file })), text)
  })
}

test('fixtures: explicit ids everywhere, unique across all files, valid shape', () => {
  const seen = new Map()
  for (const file of fixtureFiles) {
    const text = readFileSync(join(FIXTURES, file), 'utf8')
    const headings = text.split('\n').filter((l) => /^#+ /.test(l))
    walk(parse(text, { file }), (node) => {
      assert.match(node.id, /^[a-z0-9]{4,8}$/, `${file}: ${node.title}`)
      assert.ok(!seen.has(node.id), `${node.id} in ${file} and ${seen.get(node.id)}`)
      seen.set(node.id, file)
    })
    assert.ok(headings.length > 0)
    // no node needed a generated id: serializing adds nothing the file does not already say
    assert.ok(!/\{#x[a-z0-9]{1,5}\}/.test(text))
  }
})

test('homelab keeps the prototype structure', () => {
  const root = parse(readFileSync(join(FIXTURES, 'homelab.md'), 'utf8'), { file: 'homelab.md' })
  assert.equal(root.kind, 'project')
  assert.equal(root.state, 'halt')
  assert.deepEqual(root.attrs, {})
  assert.equal(root.title.startsWith('NAS 迁移到 ZFS'), true)
  const refs = root.children.filter((c) => c.kind === 'ref').map((c) => c.title)
  assert.deepEqual(refs, ['设计笔记', '磁盘清单', '(cmd) 状态', '回滚预案', '参考'])
  assert.deepEqual(find(root, '磁盘清单').children.map((c) => `${c.kind}:${c.title}`), ['ref:旧阵列', 'ref:新盘', 'ref:zpool 布局'])
  const fork = find(root, '两台机器')
  assert.equal(fork.kind, 'fork')
  assert.deepEqual(fork.children.map((c) => `${c.kind}:${c.title}`), ['lane:nas-a', 'lane:nas-b'])
  assert.deepEqual(find(root, 'nas-b').children.map((c) => c.title), ['清点旧盘', '换盘', '内核日志', '验证'])
  const q = find(root, '确认 ashift 是否设为 12')
  assert.equal(q.question, true)
  assert.equal(q.state, 'halt')
  assert.match(find(root, '内核日志').body, /```bash\ndmesg \| grep -i ata\n```/)
  const sig = findNode(root, find(root, '校验').id)
  assert.equal(sig.parent.title, '换盘')
  assert.equal(root.children.at(-1).title, '收尾')
})

test('backup: the doubt is a todo question followed by a fork of two hypotheses', () => {
  const root = parse(readFileSync(join(FIXTURES, 'backup.md'), 'utf8'), { file: 'backup.md' })
  const line = root.children.filter((c) => c.kind !== 'ref')
  assert.equal(line[0].question, true)
  assert.equal(line[0].state, 'todo')
  assert.equal(line[1].kind, 'fork')
  assert.deepEqual(line[1].children.map((c) => c.kind), ['lane', 'lane'])
})

// ───────────────────────── total parse, canonical form ─────────────────────────

test('CRLF input parses like LF input and is written back with LF', () => {
  const lf = '# P {#proj}\n\nbody line\n\n## step {#st01}\n\n```bash\nls\n```\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.deepEqual(parse(crlf, { file: 'p.md' }), parse(lf, { file: 'p.md' }))
  assert.equal(serialize(parse(crlf, { file: 'p.md' })), lf)
})

test('a leading BOM is ignored', () => {
  assert.equal(parse('\uFEFF# P {#proj}\n', { file: 'p.md' }).title, 'P')
})

test('file without H1: project named after the stem, headings become descendants, preamble kept', () => {
  const root = parse('intro line\n\n## a {#aaaa}\n\n### b {#bbbb}\n\n## c {#cccc}\n', { file: 'D:\\notes dir\\我的 notes.md' })
  assert.equal(root.title, '我的 notes')
  assert.equal(root.preamble, 'intro line')
  assert.deepEqual(root.children.map((c) => c.title), ['a', 'c'])
  assert.equal(root.children[0].children[0].title, 'b')
  assert.equal(serialize(parse(serialize(root), { file: 'x.md' })).includes('# 我的 notes'), true)
})

test('empty file and file with text only', () => {
  const empty = parse('', { file: 'e.md' })
  assert.equal(empty.title, 'e')
  assert.deepEqual(empty.children, [])
  const text = parse('just words\nmore words\n', { file: 't.md' })
  assert.equal(text.preamble, 'just words\nmore words')
  assert.match(serialize(text), /^just words\nmore words\n\n# t \{#/)
})

test('preamble before the H1 is kept and written back', () => {
  const text = 'a note\n\nwith two paragraphs\n\n# P {#proj}\n\n## s {#st01}\n'
  const root = parse(text)
  assert.equal(root.preamble, 'a note\n\nwith two paragraphs')
  assert.equal(serialize(root), text)
})

test('skipped heading levels attach to the nearest shallower heading and normalize on write', () => {
  const root = parse('# P {#proj}\n\n#### deep {#deep}\n\n## mid {#midd}\n\n###### deeper {#dpr6}\n')
  assert.deepEqual(root.children.map((c) => c.title), ['deep', 'mid'])
  assert.equal(root.children[1].children[0].title, 'deeper')
  assert.equal(serialize(root), '# P {#proj}\n\n## deep {#deep}\n\n## mid {#midd}\n\n### deeper {#dpr6}\n')
})

test('a second H1 is a top-level step; headings after it nest under it', () => {
  const root = parse('# One {#one1}\n\n# Two {#two2}\n\n## child {#chld}\n')
  assert.equal(root.title, 'One')
  assert.equal(root.children.length, 1)
  assert.equal(root.children[0].kind, 'step')
  assert.equal(root.children[0].title, 'Two')
  assert.equal(root.children[0].children[0].title, 'child')
  assert.equal(serialize(root), '# One {#one1}\n\n## Two {#two2}\n\n### child {#chld}\n')
})

test('first heading deeper than H1: virtual project, a later H1 is still a descendant', () => {
  const root = parse('## a {#aaaa}\n\n# late {#late}\n', { file: 'f.md' })
  assert.equal(root.title, 'f')
  assert.deepEqual(root.children.map((c) => c.title), ['a', 'late'])
})

test('parse -> serialize -> parse is a fixpoint for non-canonical input', () => {
  const messy = [
    '\r\n\r\npre\r\n\r\n#   P   {#proj cwd="D:/a b"}   \r\n\r\n\r\n\r\ntext\r\n\r\n\r\n### no id\r\n#### TODO  ?  q  \r\n##### REF r\r\n###### nested ref\r\n',
    '# P\n## FORK f\n### lane one\n#### s\n### REF r\n## HALT\n## ?\n##\n',
    '# P {#same}\n## a {#same}\n## b {#same}\n## c {#same}\n',
    '```\n# not a heading\n```\n# P\n```\n## swallowed? no, unclosed\n## real\n',
    'x\n# P\n~~~\ncode\n```\n## inside\n~~~~\n## after\n',
  ]
  for (const text of messy) {
    const once = parse(text, { file: 'm.md' })
    const out = serialize(once)
    const twice = parse(out, { file: 'm.md' })
    assert.deepEqual(twice, once, text)
    assert.equal(serialize(twice), out)
  }
})

// ───────────────────────── kind inference ─────────────────────────

test('kind inference: REF/FORK markers, lanes under forks, refs under refs', () => {
  const root = parse([
    '# P {#proj}',
    '## FORK f {#fork}',
    '### lane a {#lana}',
    '#### step {#stp1}',
    '#### FORK inner {#inn1}',
    '##### l1 {#l1id}',
    '##### l2 {#l2id}',
    '### REF fork ref {#frr1}',
    '#### under ref marker optional {#urm1}',
    '#### REF with marker {#urm2}',
    '### FORK looks like a marker but is a lane {#lanb}',
    '## REF top ref {#tref}',
    '### FORK under ref is plain title text {#fur1}',
    '## step with children {#swc1}',
    '### REF step ref {#sref}',
    '### FORK chapter fork {#chf1}',
  ].join('\n\n') + '\n')
  assert.deepEqual(kinds(root), [
    'project:P', 'fork:f', 'lane:lane a', 'step:step', 'fork:inner', 'lane:l1', 'lane:l2',
    'ref:fork ref', 'ref:under ref marker optional', 'ref:with marker',
    'lane:FORK looks like a marker but is a lane',
    'ref:top ref', 'ref:FORK under ref is plain title text',
    'step:step with children', 'ref:step ref', 'fork:chapter fork',
  ])
  walk(root, (node, parent) => { if (parent) assert.ok(canContain(parent.kind, node.kind), `${parent.kind} > ${node.kind}`) })
})

test('writer emits a kind marker only where the context does not imply it', () => {
  const root = parse('# P {#proj}\n\n## FORK f {#fork}\n\n### a {#lana}\n\n### REF r {#rr01}\n\n#### rr {#rr02}\n\n## REF t {#tr01}\n')
  assert.equal(serialize(root), '# P {#proj}\n\n## FORK f {#fork}\n\n### a {#lana}\n\n### REF r {#rr01}\n\n#### rr {#rr02}\n\n## REF t {#tr01}\n')
  assert.equal(serializeSubtree(find(root, 'rr'), 3), '### REF rr {#rr02}\n')
  assert.equal(serializeSubtree(find(root, 'r'), 5), '##### REF r {#rr01}\n\n###### rr {#rr02}\n')
})

// ───────────────────────── attributes ─────────────────────────

test('attrs keep their order, quoting and empty values', () => {
  const text = '# P {#proj cwd="D:/work dir/x" zed=1 alpha=b=c empty=""}\n'
  const root = parse(text)
  assert.deepEqual(Object.entries(root.attrs), [['cwd', 'D:/work dir/x'], ['zed', '1'], ['alpha', 'b=c'], ['empty', '']])
  assert.equal(serialize(root), text)
})

test('bare attribute keys read as empty values; __proto__ stays data', () => {
  const root = parse('# P {#proj flag __proto__=x}\n')
  assert.equal(root.attrs.flag, '')
  assert.equal(Object.getPrototypeOf(root.attrs), Object.prototype)
  assert.equal(Object.keys(root.attrs).includes('__proto__'), true)
  assert.equal(serialize(root), '# P {#proj flag="" __proto__=x}\n')
})

test('writing an attribute that cannot be represented throws a typed error', () => {
  const root = parse('# P {#proj}\n')
  root.attrs.bad = 'a"b'
  assert.throws(() => serialize(root), { code: 'invalid-attrs' })
  root.attrs = { 'bad key': 'x' }
  assert.throws(() => serialize(root), { code: 'invalid-attrs' })
})

// ───────────────────────── ids ─────────────────────────

test('missing ids are deterministic across re-parses and unique', () => {
  const text = '# P\n\n## a\n\n## a\n\n### a\n\n## a\n'
  const one = parse(text, { file: 'p.md' })
  const two = parse(text, { file: 'p.md' })
  assert.deepEqual(one, two)
  const ids = []
  walk(one, (node) => { ids.push(node.id) })
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^x[a-z0-9]{1,}$/)
  assert.ok(ids.every((id) => id.length >= 4))
  assert.notDeepEqual(parse(text, { file: 'other.md' }).id, one.id)
})

test('generated ids avoid an explicit id that appears later in the file', () => {
  const probe = parse('# P\n\n## a\n', { file: 'p.md' })
  const taken = probe.children[0].id
  const root = parse(`# P\n\n## a\n\n## b {#${taken}}\n`, { file: 'p.md' })
  assert.equal(root.children[1].id, taken)
  assert.notEqual(root.children[0].id, taken)
})

test('duplicate ids: the later one is replaced deterministically', () => {
  const root = parse('# P {#dupe}\n\n## a {#dupe}\n\n## b {#dupe}\n', { file: 'p.md' })
  assert.equal(root.id, 'dupe')
  assert.notEqual(root.children[0].id, 'dupe')
  assert.notEqual(root.children[0].id, root.children[1].id)
  assert.deepEqual(parse('# P {#dupe}\n\n## a {#dupe}\n\n## b {#dupe}\n', { file: 'p.md' }), root)
})

// ───────────────────────── escapes ─────────────────────────

const rootWith = (children) => ({
  id: 'proj', kind: 'project', title: 'P', state: '', question: false, body: '', attrs: {}, preamble: '', children,
})
const stepOf = (id, title, body = '', extra = {}) => ({
  id, kind: 'step', title, state: '', question: false, body, attrs: {}, children: [], ...extra,
})

test('titles that look like markers or attribute blocks survive', () => {
  const titles = [
    'TODO x', 'HALT x', 'REF x', 'FORK x', '? x', '?', 'TODO', '\\TODO x', '\\', '\\\\x', 'x {a}', '{a}', 'x \\{a}', 'x {#id}',
    'x {a="b c"}', 'ends with \\', 'a } b', 'a { b', '# hash', '#', 'TODO ? REF x', '"quoted"', 'REF', 'FORK',
  ]
  for (const state of ['', 'todo', 'halt']) {
    for (const question of [false, true]) {
      const kids = titles.map((t, i) => stepOf(`s${String(i).padStart(3, '0')}`, t, '', { state, question }))
      const root = rootWith(kids)
      const back = parse(serialize(root))
      assert.deepEqual(back, root, `${state}/${question}`)
    }
  }
})

test('a title written escaped looks as the spec says', () => {
  const text = serialize(rootWith([stepOf('aaaa', 'TODO x'), stepOf('bbbb', 'x {a}'), stepOf('cccc', '? x')]))
  assert.equal(text, '# P {#proj}\n\n## \\TODO x {#aaaa}\n\n## x \\{a} {#bbbb}\n\n## \\? x {#cccc}\n')
})

test('body lines that look like headings are escaped outside fences and verbatim inside', () => {
  const body = ['# heading-looking', '  ## indented', '\\# already', '#hashtag', 'text', '```bash', '# comment in code', '## also code', '```', '### after'].join('\n')
  const root = rootWith([stepOf('aaaa', 's', body)])
  const text = serialize(root)
  assert.equal(text, [
    '# P {#proj}', '', '## s {#aaaa}', '',
    '\\# heading-looking', '  \\## indented', '\\\\# already', '#hashtag', 'text', '```bash', '# comment in code', '## also code', '```', '\\### after', '',
  ].join('\n'))
  assert.deepEqual(parse(text), root)
})

test('unclosed fences are plain text and cannot swallow later headings', () => {
  const root = rootWith([stepOf('aaaa', 'first', 'before\n```bash\nnever closed\n# heading-ish'), stepOf('bbbb', 'second', '```\nclosed\n```'), stepOf('cccc', 'third', '~~~\nopen')])
  const back = parse(serialize(root))
  assert.deepEqual(back, root)
  assert.deepEqual(back.children.map((c) => c.title), ['first', 'second', 'third'])
})

test('in raw input an unclosed fence is plain text; a closed one hides headings', () => {
  const open = parse('# P {#proj}\n\n## a {#aaaa}\n\n```\ntext\n\n## b {#bbbb}\n')
  assert.deepEqual(open.children.map((c) => c.title), ['a', 'b'])
  assert.equal(open.children[0].body, '```\ntext')
  const closed = parse('# P {#proj}\n\n## a {#aaaa}\n\n```\ntext\n## not b\n```\n\n## b {#bbbb}\n')
  assert.deepEqual(closed.children.map((c) => c.title), ['a', 'b'])
  assert.equal(closed.children[0].body, '```\ntext\n## not b\n```')
})

test('fence closing needs the same char, at least as many, nothing after', () => {
  const body = '````\n```\n# inside\n````\n# outside-heading-looking'
  const root = rootWith([stepOf('aaaa', 's', body)])
  assert.equal(serialize(root).includes('\n\\# outside-heading-looking'), true)
  assert.deepEqual(parse(serialize(root)), root)
  const tilde = rootWith([stepOf('aaaa', 's', '~~~\n```\n# x\n~~~ trailing\n~~~')])
  assert.deepEqual(parse(serialize(tilde)), tilde)
  assert.equal(serialize(tilde).includes('\\#'), false)
})

test('deep nesting past six levels writes more hashes and reads back', () => {
  let node = stepOf('d000', 'level 0')
  const top = node
  for (let i = 1; i < 12; i += 1) {
    const child = stepOf(`d${String(i).padStart(3, '0')}`, `level ${i}`, i % 2 ? `body ${i}\n\n# not a heading` : '')
    node.children.push(child)
    node = child
  }
  const root = rootWith([top])
  const text = serialize(root)
  assert.match(text, /^#{13} level 11 \{#d011\}$/m)
  assert.deepEqual(parse(text), root)
})

test('CJK titles, bodies, empty bodies and attrs round-trip', () => {
  const root = rootWith([
    stepOf('cj01', '备份旧数据：先备份', '从dsd合入新增CF卡访问异常告警头文件。\n\n- 条目一\n- 条目二'),
    stepOf('cj02', '空'),
  ])
  root.attrs = { cwd: 'D:/工作 目录/路由' }
  assert.deepEqual(parse(serialize(root)), root)
})

// ───────────────────────── random trees ─────────────────────────

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TITLE_POOL = [
  'plain', 'TODO x', 'HALT x', 'REF x', 'FORK x', '? x', 'x {a}', '{a=1}', '\\x', 'ends\\', '中文标题', '换盘（第 3 步）', 'a | b', '# h', '"q"',
  'REF', '?', 'x {#abc}', 'tail }', 'k=v', 'a  b', 'TODO ? REF', '`code`', 'x \\{a}',
]
const BODY_LINES = [
  'plain text', '# heading-looking', '## two', '#hashtag', '  # indented', '\\# escaped already', '\\\\## double', '', '', '中文 正文',
  '```', '```bash', '~~~', '````', '```  ', '- item', '> quote', '#', '##', '# ', '    code', 'text with {braces}', '   ```js',
]
const WORDS = ['alpha', 'beta', '合入', 'x', 'y', 'TODO', '{z}', 'REF']

function randomTitle(r) {
  if (r() < 0.04) return ''
  const base = TITLE_POOL[Math.floor(r() * TITLE_POOL.length)]
  return r() < 0.3 ? `${base} ${WORDS[Math.floor(r() * WORDS.length)]}`.trim() : base
}

function randomBody(r) {
  if (r() < 0.4) return ''
  const count = 1 + Math.floor(r() * 7)
  const lines = []
  for (let i = 0; i < count; i += 1) lines.push(BODY_LINES[Math.floor(r() * BODY_LINES.length)])
  // the format normalizes edge blank lines (a body never starts or ends blank)
  while (lines.length && lines[0] === '') lines.shift()
  while (lines.length && lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

const CHILD_CHOICES = {
  project: ['step', 'step', 'fork', 'ref'],
  step: ['step', 'step', 'fork', 'ref'],
  fork: ['lane', 'lane', 'ref'],
  lane: ['step', 'step', 'fork', 'ref'],
  ref: ['ref'],
}

function randomTree(seed) {
  const r = rng(seed)
  let counter = 0
  const make = (kind, depth) => {
    const node = {
      id: `n${(counter += 1).toString(36).padStart(4, '0')}`,
      kind,
      title: randomTitle(r),
      state: r() < 0.5 ? '' : r() < 0.5 ? 'todo' : 'halt',
      question: r() < 0.15,
      body: randomBody(r),
      attrs: {},
      children: [],
    }
    if (kind === 'project') {
      node.preamble = r() < 0.3 ? 'preamble line\n# heading-ish\n```\nunclosed' : ''
      if (r() < 0.6) node.attrs = { cwd: r() < 0.5 ? 'D:/a b/c' : 'x', note: '中文 {v}' }
    }
    // a chain guarantees nesting well past six levels in some trees
    const room = depth < 14 ? Math.floor(r() * (depth < 3 ? 5 : 3)) : 0
    const options = CHILD_CHOICES[kind]
    for (let i = 0; i < room; i += 1) node.children.push(make(options[Math.floor(r() * options.length)], depth + 1))
    if (depth < 9 && node.children.length === 0 && r() < 0.5 && kind !== 'fork') node.children.push(make(kind === 'ref' ? 'ref' : 'step', depth + 1))
    if (kind === 'fork' && node.children.length === 0) node.children.push(make('lane', depth + 1))
    return node
  }
  return make('project', 0)
}

test('random trees survive serialize -> parse deep-equal', () => {
  let deepest = 0
  for (let seed = 1; seed <= 400; seed += 1) {
    const tree = randomTree(seed)
    walk(tree, (_node, _parent, depth) => { deepest = Math.max(deepest, depth) })
    const text = serialize(tree)
    const back = parse(text, { file: 'r.md' })
    assert.deepEqual(back, tree, `seed ${seed}\n${text}`)
    assert.equal(serialize(back), text, `seed ${seed} not idempotent`)
  }
  assert.ok(deepest > 6, `deepest generated tree was only ${deepest}`)
})

test('arbitrary garbage parses totally and reaches a fixpoint after one write', () => {
  const r = rng(99)
  const alphabet = ['#', '#', ' ', '\n', '\n', '`', '~', '\\', '{', '}', '#', 'a', 'TODO ', 'REF ', 'FORK ', '? ', '中', '"', '=', '\t', '\r\n']
  for (let i = 0; i < 300; i += 1) {
    let text = ''
    const len = Math.floor(r() * 80)
    for (let k = 0; k < len; k += 1) text += alphabet[Math.floor(r() * alphabet.length)]
    const once = parse(text, { file: 'g.md' })
    const out = serialize(once)
    const twice = parse(out, { file: 'g.md' })
    assert.deepEqual(twice, once, JSON.stringify(text))
    assert.equal(serialize(twice), out)
  }
})

// ───────────────────────── subtrees ─────────────────────────

test('serializeSubtree starts at the given depth and ends with one newline', () => {
  const root = parse('# P {#proj}\n\n## a {#aaaa}\n\nbody\n\n### b {#bbbb}\n')
  assert.equal(serializeSubtree(root.children[0], 4), '#### a {#aaaa}\n\nbody\n\n##### b {#bbbb}\n')
  assert.equal(serializeSubtree(root), serialize(root))
})

test('parseSubtree returns the top-level nodes, honouring kindHint', () => {
  const nodes = parseSubtree('### a {#aaaa}\n\nbody\n\n#### b {#bbbb}\n\n### FORK f {#ffff}\n\n#### l1 {#l111}\n', { file: 'f.md' })
  assert.deepEqual(nodes.map((n) => `${n.kind}:${n.title}`), ['step:a', 'fork:f'])
  assert.equal(nodes[0].children[0].title, 'b')
  assert.equal(nodes[1].children[0].kind, 'lane')

  const lanes = parseSubtree('## one {#one1}\n\n## REF r {#rrr1}\n', { kindHint: 'fork' })
  assert.deepEqual(lanes.map((n) => n.kind), ['lane', 'ref'])
  const refs = parseSubtree('## x {#xxxx}\n', { kindHint: 'ref' })
  assert.equal(refs[0].kind, 'ref')
})

test('parseSubtree: serializeSubtree output parses back, ids kept, missing ids deterministic', () => {
  const root = parse(readFileSync(join(FIXTURES, 'homelab.md'), 'utf8'), { file: 'homelab.md' })
  const fork = find(root, '两台机器')
  const back = parseSubtree(serializeSubtree(fork, 2), { kindHint: 'project' })
  assert.deepEqual(back, [fork])
  const anon = parseSubtree('# a\n\n## b\n', { file: 's.md' })
  assert.deepEqual(anon, parseSubtree('# a\n\n## b\n', { file: 's.md' }))
  assert.equal(anon[0].children[0].title, 'b')
})

test('parseSubtree refuses text that precedes the first heading instead of dropping it', () => {
  assert.throws(() => parseSubtree('loose words\n\n## a\n'), { code: 'invalid-content' })
  assert.deepEqual(parseSubtree('\n\n'), [])
})
