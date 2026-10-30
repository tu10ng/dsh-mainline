/**
 * The panel's pure core, tested without a browser.
 *
 * `lib/client.js` is a classic script: it is run in a `node:vm` context against a fake
 * `window.__ModuleLoader__`, its factory is called with a stub `require('react')`, and the
 * helpers it exposes on `__test` are exercised directly — the Markdown parser, the layout
 * (with a `measure` function instead of a DOM), folding, and the contract details that
 * break silently in a Host (slot ids, document-relative routes, theme tokens only).
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8')

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (component) => component,
  Fragment: 'Fragment',
  Component: class {},
}

function load() {
  let registered = null
  const window = { __ModuleLoader__: { load: (definition) => (registered = definition) } }
  vm.runInNewContext(source, { window, console })
  const required = []
  const plugin = registered.factory((name) => {
    required.push(name)
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  return { registered, plugin, required }
}

const { registered, plugin, required } = load()
/** Values built inside the vm have another realm's prototypes; compare their JSON shape. */
const plain = (value) => JSON.parse(JSON.stringify(value))
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message)
const T = plugin.__test

// ------------------------------------------------------------------ sample trees

let serial = 0
const node = (kind, title, extra = {}) => ({
  id: extra.id ?? `n${(serial += 1).toString(36).padStart(3, '0')}`,
  kind,
  title,
  state: extra.state ?? '',
  question: extra.question ?? false,
  body: extra.body ?? '',
  attrs: {},
  children: extra.children ?? [],
})
const step = (title, extra) => node('step', title, extra)
const ref = (title, extra) => node('ref', title, extra)
const lane = (title, children, extra) => node('lane', title, { ...extra, children })
const fork = (title, lanes, extra) => node('fork', title, { ...extra, children: lanes })

/** A NAS→ZFS-shaped walkthrough: refs, a chapter, a fork with a long and a short lane. */
function sample() {
  serial = 0
  return node('project', 'NAS→ZFS', {
    id: 'proj',
    body: '存储卡 DFX',
    children: [
      ref('设计文档', { id: 'refa' }),
      step('备份旧数据', { id: 'head', body: '先备份', children: [ref('磁盘清单', { id: 'refb' })] }),
      step('告警建模', { id: 'model', children: [step('属性', { id: 'attr', state: 'todo' }), step('trap', { id: 'trap' })] }),
      fork('两台机器', [
        lane('nas-a', [step('nas-a c', { id: 'v1' })], { id: 'lv' }),
        lane('nas-b', [step('nas-b c', { id: 'q1' }), step('清点旧盘', { id: 'q2' }), step('换盘', { id: 'q3', state: 'todo' })], { id: 'lq' }),
      ], { id: 'fk' }),
      step('修改 lua', { id: 'lua' }),
      step('收尾', { id: 'done', state: 'halt' }),
    ],
  })
}

/** Every element has a known size: cards 224×40 (360 when open), project 400×80, pills 60×20, labels 70×16. */
function measureFor(root, folds) {
  const index = T.indexTree(root)
  return (id) => {
    const kind = index.get(id)?.node.kind
    if (kind === 'project') return { w: 400, h: 80 }
    if (kind === 'lane') return { w: 60, h: 20 }
    if (kind === 'fork') return { w: 70, h: 16 }
    return { w: folds?.get(id)?.bodyShown ? 360 : 224, h: 40 }
  }
}

function place(root, options = {}) {
  const folds = T.computeFolds(root, options.fold ?? {})
  return T.layout(root, { measure: measureFor(root, folds), folds, offsets: options.offsets, selected: options.selected })
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Start and end point of an SVG path made of M / V / H / Q segments. */
function endpoints(d) {
  const tokens = d.match(/[MVHQ]|-?\d+(?:\.\d+)?/g)
  let x = 0
  let y = 0
  let start = null
  for (let at = 0; at < tokens.length; ) {
    const op = tokens[at++]
    if (op === 'M') {
      x = Number(tokens[at++])
      y = Number(tokens[at++])
      start = { x, y }
    } else if (op === 'V') y = Number(tokens[at++])
    else if (op === 'H') x = Number(tokens[at++])
    else if (op === 'Q') {
      at += 2
      x = Number(tokens[at++])
      y = Number(tokens[at++])
    }
  }
  return { start, end: { x, y } }
}

// ------------------------------------------------------------------ bundle contract

test('the bundle is a classic script that registers one factory under the package id', () => {
  assert.equal(registered.id, 'dsh-mainline')
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'no ESM syntax in a classic script')
  same(required, ['react'], 'only react is required')
  same(plugin.inject, ['sessions', 'uiWorkspace', 'slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the sidebar entry, the main panel with its session-scoped child, and that child', () => {
  const registrations = []
  const effects = []
  const ctx = {
    effect: (fn, label) => effects.push({ label, dispose: fn() }),
    locale: { register: () => () => {}, getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    sessions: { retain: () => ({ release() {} }) },
    uiWorkspace: { openSession() {} },
  }
  plugin.apply(ctx)
  const entry = registrations.find((r) => r.spec.name === 'sidebar.panellist')
  const main = registrations.find((r) => r.spec.name === 'main')
  const chat = registrations.find((r) => r.spec.name === 'mainline.chat.conversation')
  assert.equal(entry.spec.id, 'mainline')
  assert.equal(entry.spec.order, 85)
  assert.equal(entry.spec.label(), '工作树')
  assert.equal(main.spec.key, 'mainline', 'the main key must equal the sidebar entry id')
  same(main.spec.children, { 'mainline.chat.conversation': { kind: 'single', scope: 'session' } })
  assert.equal(typeof chat.component, 'function')
  assert.ok(effects.every((effect) => typeof effect.dispose === 'function'), 'every effect returns a disposer')
  assert.equal(T.constants.SLOT_ID, 'mainline')
  assert.equal(T.constants.CHAT_SLOT, 'mainline.chat.conversation')
})

test('routes are called document-relative, and every one exists on the host', () => {
  assert.equal(T.constants.API, 'api/mainline', 'no leading slash: the GUI serves under <base href="./">')
  assert.doesNotMatch(source, /fetch\(\s*['"`]\/api/, 'no root-absolute fetch')
  const called = new Set()
  for (const match of source.matchAll(/\bcall\('([^']+)'/g)) called.add(match[1])
  for (const match of source.matchAll(/`\$\{API\}\/([a-z/]+)/g)) called.add(match[1])
  assert.ok(called.size >= 12, `found ${[...called].join(', ')}`)
  for (const expected of ['projects', 'project', 'op', 'focus', 'stream', 'session', 'session/reset', 'run', 'run/cancel', 'runs', 'ask', 'history', 'view']) {
    assert.ok(called.has(expected), `the panel calls ${expected}`)
  }
  const routesFile = path.join(repo, 'lib', 'routes.js')
  if (!existsSync(routesFile)) return
  const routes = readFileSync(routesFile, 'utf8')
  const served = new Set()
  for (const match of routes.matchAll(/exact(?:Verbs)?\((?:'(?:GET|POST)',\s*)?'\/([^']+)'/g)) served.add(match[1])
  for (const path of called) assert.ok(served.has(path), `host serves /api/mainline/${path}`)
})

test('colours are theme tokens only: no hex and no rgb literal anywhere in the file', () => {
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(source, /\brgba?\(/)
  const tokens = new Set([...T.CSS.matchAll(/var\(--(dsw-[a-z0-9-]+)\)/g)].map((match) => match[1]))
  for (const token of tokens) assert.match(token, /^dsw-alias-/, `${token} is an alias token`)
})

test('both dictionaries carry the same keys', () => {
  same(Object.keys(T.DICTS.en).sort(), Object.keys(T.DICTS.zh).sort())
  assert.equal(T.translate('en', 'card.steps', { n: 3 }), '3 steps')
  assert.equal(T.translate('zh', 'card.steps', { n: 3 }), '3 步')
})

// ------------------------------------------------------------------ Markdown

test('fences: closed fences are code with a run index, unclosed ones stay text', () => {
  const blocks = T.parseMarkdown(['加载后验证：', '', '```bash', 'dmesg | grep -i ata', '```', '', '~~~~ text', 'not run', '~~~~~', '', '```sh', 'ls', '```'].join('\n'))
  same(blocks.map((b) => b.type), ['paragraph', 'code', 'code', 'code'])
  same(blocks.slice(1).map((b) => [b.lang, b.code, b.run]), [['bash', 'dmesg | grep -i ata', 0], ['text', 'not run', null], ['sh', 'ls', 1]])

  const unclosed = T.parseMarkdown('before\n\n```bash\nrm -rf /\n# not a heading')
  assert.ok(unclosed.every((b) => b.type === 'paragraph'), 'an unclosed fence cannot swallow the rest')
  assert.match(T.plainInline(unclosed[1].inline), /```bash rm -rf \/ # not a heading/)

  const shorter = T.parseMarkdown('````bash\n```\nstill code\n````')
  assert.equal(shorter.length, 1)
  assert.equal(shorter[0].code, '```\nstill code')
})

test('extractFences numbers shell fences only, the way POST run { index } names them', () => {
  const body = ['```python', 'print(1)', '```', '```Bash extra', 'make', '```', '- item', '  ```pwsh', '  Get-Item .', '  ```', '```', 'no lang', '```'].join('\r\n')
  const fences = T.extractFences(body)
  same(fences.map((f) => [f.index, f.lang]), [[0, 'bash'], [1, 'pwsh']])
  const nested = T.parseMarkdown(body)[2].items[0].blocks
  assert.equal(nested[1].type, 'code')
  assert.equal(nested[1].run, 1, 'a fence inside a list keeps its body-wide index')
})

test('extractFences agrees with the host runner', async (t) => {
  const runner = path.join(repo, 'lib', 'runner.js')
  if (!existsSync(runner)) return t.skip('lib/runner.js not written yet')
  const { extractFences } = await import(pathToFileURL(runner).href)
  const body = [
    '```bash', 'a', '```', 'text', '~~~ sh', 'b', '~~~', '``` `not a fence`', '```console', 'unclosed', '',
    '```js', 'x', '```', '  ```cmd', '  dir', '  ```', '````PWSH', '```', 'nested', '````',
  ].join('\r\n')
  const strip = (list) => list.map(({ index, lang, code, start, end }) => ({ index, lang, code, start, end }))
  same(strip(T.extractFences(body)), strip(extractFences(body)))
  assert.ok(T.extractFences(body).length >= 3)
})

test('lists nest, number, and carry task boxes', () => {
  const [list] = T.parseMarkdown(['- a', '  - b', '    - c', '- [x] done', '- [ ] open', 'lazy line'].join('\n'))
  assert.equal(list.type, 'list')
  assert.equal(list.ordered, false)
  assert.equal(list.items.length, 3)
  const nested = list.items[0].blocks[1]
  assert.equal(nested.type, 'list')
  assert.equal(nested.items[0].blocks[1].type, 'list', 'three levels')
  same(list.items.map((item) => item.checked), [null, true, false])
  assert.equal(T.plainInline(list.items[2].blocks[0].inline), 'open lazy line')

  const [ordered] = T.parseMarkdown('3. three\n4. four')
  assert.equal(ordered.ordered, true)
  assert.equal(ordered.start, 3)
  assert.equal(ordered.items.length, 2)

  assert.equal(T.toggleTask('- [ ] a\n- [x] b', 0), '- [x] a\n- [x] b')
  assert.equal(T.toggleTask('- [ ] a\n  - [x] b', 1), '- [ ] a\n  - [ ] b')
  assert.equal(list.items[1].line, 3, 'a task item knows its body line')
})

test('pipe tables keep alignment, escaped pipes, and ragged rows', () => {
  const [table] = T.parseMarkdown(['| 寄存器 | 值 | 含义 |', '|---|---:|:-:|', '| `ctl_reg` | 0x252 | a \\| b |', '| short |'].join('\n'))
  assert.equal(table.type, 'table')
  same(table.align, [null, 'right', 'center'])
  assert.equal(table.header.length, 3)
  same(table.rows[0][0], [{ type: 'code', text: 'ctl_reg' }])
  assert.equal(T.plainInline(table.rows[0][2]), 'a | b')
  assert.equal(table.rows[1].length, 3, 'a short row is padded')
  assert.equal(T.parseMarkdown('a | b\n---')[0].type, 'paragraph', 'a delimiter without pipes is not a table')
})

test('inline marks: code, bold, italic, strike, links, and snake_case left alone', () => {
  const nodes = T.parseInline('**粗** *斜* ~~删~~ `a*b*c` [文档](https://x.example/doc) zfs_scrub_check')
  same(
    nodes.filter((n) => n.type !== 'text').map((n) => n.type),
    ['strong', 'em', 'del', 'code', 'link'],
  )
  assert.equal(nodes.find((n) => n.type === 'code').text, 'a*b*c')
  assert.equal(nodes.find((n) => n.type === 'link').href, 'https://x.example/doc')
  assert.match(T.plainInline(nodes), /zfs_scrub_check$/)

  const bare = T.parseInline('见 https://wiki.example.com/bsp/ata。然后 (https://a.example/x_(y)).')
  const links = bare.filter((n) => n.type === 'link').map((n) => n.href)
  same(links, ['https://wiki.example.com/bsp/ata', 'https://a.example/x_(y)'])

  const unsafe = T.parseInline('[x](javascript:alert(1)) [y](docs/a.md)')
  same(unsafe.filter((n) => n.type === 'link').map((n) => n.href), [null, null], 'only http(s) / mailto are followed')
})

test('bodies are ATX-less: `# x` is text and `\\#` unescapes to `#`', () => {
  const blocks = T.parseMarkdown('# not a heading\n\\# escaped\n\\*literal\\* C:\\work\\homelab')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'paragraph')
  assert.equal(T.plainInline(blocks[0].inline), '# not a heading # escaped *literal* C:\\work\\homelab')
})

test('quotes, rules and the peek a folded card shows', () => {
  const blocks = T.parseMarkdown('> 注意\n> `ttq`\n\n---\n\ntail')
  same(blocks.map((b) => b.type), ['quote', 'hr', 'paragraph'])
  assert.equal(T.peekOf('```bash\ndmesg | tail\n```\nmore'), '$ dmesg | tail')
  assert.equal(T.peekOf('- [ ] 校验校验\n- b'), '☐ 校验校验')
  assert.equal(T.peekOf('**粗**体\n第二行'), '粗体 第二行')
  assert.equal(T.peekOf(''), '')
})

// ------------------------------------------------------------------ layout

test('lanes run side by side and the line merges below the longest lane', () => {
  const root = sample()
  const out = place(root)
  const { boxes } = out
  assert.equal(boxes.lv.y, boxes.lq.y, 'lane pills share a row')
  assert.ok(boxes.lv.x + boxes.lv.w < boxes.lq.x, 'lanes do not overlap')
  assert.ok(boxes.q1.x > boxes.v1.x + boxes.v1.w, 'lane lines are side by side')
  assert.equal(boxes.v1.y, boxes.q1.y, 'both lanes start on the same row')
  const longest = boxes.q3.y + boxes.q3.h
  assert.ok(boxes.lua.y > longest + T.constants.FB, 'the next step sits below the longest lane')
  assert.equal(boxes.lua.x + boxes.lua.w / 2, boxes.head.x + boxes.head.w / 2, 'the main line keeps one axis')
  const cards = Object.entries(boxes).filter(([, box]) => box.kind !== 'fork')
  for (const [a, boxA] of cards) for (const [b, boxB] of cards) if (a < b) assert.ok(!overlaps(boxA, boxB), `${a} and ${b} overlap`)
  same(out.order, ['proj', 'head', 'model', 'lv', 'v1', 'lq', 'q1', 'q2', 'q3', 'lua', 'done'])
  assert.equal(boxes.attr, undefined, 'a folded chapter is not drawn')
  assert.equal(boxes.refa, undefined, 'references are never drawn on the line')
})

test('edges have no dangling ends: each end is on an element or meets another edge', () => {
  const root = sample()
  for (const offsets of [{}, { model: { dx: 90, dy: 30 }, q2: { dx: -50, dy: 12 } }]) {
    const { boxes, edges } = place(root, { fold: { model: 'children' }, offsets })
    const anchors = []
    for (const box of Object.values(boxes)) {
      if (box.kind !== 'fork') anchors.push({ x: box.x + box.w / 2, y: box.y }, { x: box.x + box.w / 2, y: box.y + box.h })
    }
    const ends = edges.flatMap((edge) => {
      const { start, end } = endpoints(edge.d)
      return [start, end]
    })
    const close = (a, b) => Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6
    for (const point of ends) {
      // Merge points and chapter bottoms are free points where two edges meet.
      const onElement = anchors.some((anchor) => close(anchor, point))
      const shared = ends.filter((other) => close(other, point)).length >= 2
      assert.ok(onElement || shared, `dangling edge end at ${point.x},${point.y}`)
    }
    for (const id of ['head', 'model', 'attr', 'trap', 'v1', 'q1', 'q2', 'q3', 'lua', 'done', 'lv', 'lq']) {
      const box = boxes[id]
      const top = { x: box.x + box.w / 2, y: box.y }
      assert.ok(ends.some((point) => close(point, top)), `an edge enters ${id}`)
    }
  }
})

test('an open chapter is framed, and its frame encloses the chapter', () => {
  const root = sample()
  const { boxes, frames } = place(root, { fold: { model: 'children' } })
  assert.equal(frames.length, 1)
  const [frame] = frames
  assert.equal(frame.id, 'model')
  for (const id of ['attr', 'trap']) {
    const box = boxes[id]
    assert.ok(box.x >= frame.x && box.x + box.w <= frame.x + frame.w && box.y >= frame.y && box.y + box.h <= frame.y + frame.h, `${id} inside the frame`)
  }
  assert.ok(boxes.model.y + boxes.model.h <= frame.y, 'the card sits above its chapter')
  assert.ok(Object.values(boxes).filter((b) => b.kind === 'lane').every((b) => b.y > frame.y + frame.h), 'the fork comes after the chapter')
})

test('a view offset moves the node and everything drawn beneath it, never its siblings', () => {
  const root = sample()
  const before = place(root, { fold: { model: 'children' } }).boxes
  const after = place(root, { fold: { model: 'children' }, offsets: { model: { dx: 120, dy: -15 }, lq: { dx: 40, dy: 0 } } }).boxes
  for (const id of ['model', 'attr', 'trap']) {
    assert.equal(after[id].x - before[id].x, 120, `${id} moved right`)
    assert.equal(after[id].y - before[id].y, -15, `${id} moved up`)
  }
  for (const id of ['q1', 'q2', 'q3', 'lq']) assert.equal(after[id].x - before[id].x, 40, `${id} follows its lane`)
  for (const id of ['head', 'lua', 'v1', 'lv']) same(after[id], before[id], `${id} stays`)
})

test('the walk to the selection is hot; dead segments are not live', () => {
  const root = sample()
  const { edges } = place(root, { selected: 'q2' })
  const hot = edges.filter((edge) => edge.hot)
  assert.ok(hot.length >= 5, 'project → head → model → fork → nas-b → q1 → q2')
  const chain = T.chainOf(T.indexTree(root), 'q2')
  assert.equal(chain.get('proj'), 2, 'the fork is the third item of the main line (references do not count)')
  assert.equal(chain.get('lq'), 1)
  assert.equal(chain.has('lv'), false)
  const tail = place(root, { selected: 'done' }).edges
  assert.ok(tail.filter((edge) => edge.hot).length > hot.length, 'a selection after the fork passes every lane')
  assert.equal(T.isLive(root.children.find((c) => c.id === 'done')), false)
  assert.equal(T.isLive(root.children.find((c) => c.id === 'fk')), true)
  assert.equal(T.isLive(step('sr', { state: 'done', children: [step('x', { state: 'todo' })] })), false)
})

test('lane folding collapses one lane and keeps the merge', () => {
  const root = sample()
  const { boxes } = place(root, { fold: { lq: 'folded' } })
  assert.equal(boxes.q1, undefined)
  assert.ok(boxes.lq)
  assert.ok(boxes.lua.y > boxes.v1.y + boxes.v1.h, 'the line still merges below the open lane')
  assert.equal(T.laneNeighbour(root, 'v1', 1, T.computeFolds(root, { lq: 'folded' })), 'lq', 'a hop into a folded lane lands on its pill')
  assert.equal(T.laneNeighbour(root, 'q3', -1, T.computeFolds(root, {})), 'v1', 'the same row, clamped to the shorter lane')
})

test('Alt+→ goes under the previous step, Alt+← comes back out after the parent', () => {
  const root = sample()
  const into = (id) => T.indentTarget(root, id, 1)
  const out = (id) => T.indentTarget(root, id, -1)
  same(into('model'), { parent: 'head' }, 'the end of the previous step’s chapter')
  same(into('trap'), { parent: 'attr' }, 'inside a chapter too')
  same(into('fk'), { parent: 'model' }, 'a fork goes along like a step')
  same(into('lua'), { parent: 'lq' }, 'after a fork: the end of its last lane')
  same(into('head'), { reason: 'first' }, 'a reference before it is not a step')
  same(into('q1'), { reason: 'first' })
  same(out('attr'), { parent: 'proj', after: 'model' }, 'right after the parent step')
  same(out('q3'), { parent: 'proj', after: 'fk' }, 'out of a lane: after the fork, where the lanes merge')
  same(out('head'), { reason: 'top' })
  for (const id of ['lq', 'refb', 'proj', 'nope']) same(into(id), { reason: 'kind' }, id)
})

/** A project split at its head: the old line in one lane, an unrelated thing in another. */
function splitProject() {
  serial = 100
  return node('project', 'LWD', {
    id: 'proj',
    children: [
      ref('设计文档', { id: 'refa' }),
      fork('', [
        lane('A2 验收', [step('部署', { id: 'a1' }), step('验收', { id: 'a2', state: 'todo' }), step('性能', { id: 'a3' })], { id: 'la' }),
        lane('另一件事', [step('它的第一步', { id: 'b1', state: 'todo' })], { id: 'lb' }),
      ], { id: 'fk' }),
    ],
  })
}

const endsAt = (edges, point) => edges.filter((edge) => {
  const { end } = endpoints(edge.d)
  return Math.abs(end.x - point.x) < 0.5 && Math.abs(end.y - point.y) < 0.5
})
const startsAt = (edges, point) => edges.filter((edge) => {
  const { start } = endpoints(edge.d)
  return Math.abs(start.x - point.x) < 0.5 && Math.abs(start.y - point.y) < 0.5
})

test('lanes with nothing after them run to their own ends: no merge, no line after', () => {
  const root = splitProject()
  const { boxes, edges } = place(root)
  assert.ok(boxes.lb.x > boxes.la.x + boxes.la.w, 'side by side')
  same([boxes.a1.y, boxes.b1.y], [boxes.a1.y, boxes.a1.y], 'both lines start level')
  for (const id of ['a3', 'b1']) {
    const bottom = { x: boxes[id].x + boxes[id].w / 2, y: boxes[id].y + boxes[id].h }
    same(startsAt(edges, bottom), [], `${id} ends its lane: nothing leaves it`)
  }
  assert.ok(place(root).bounds.y1 <= boxes.a3.y + 40 + 0.5, 'no merge gap below the longest lane')
  // Something after the split makes it merge again: the next step is reached from both lanes.
  root.children.push(step('都做完以后', { id: 'after' }))
  const merged = place(root)
  const top = { x: merged.boxes.after.x + merged.boxes.after.w / 2, y: merged.boxes.after.y }
  assert.ok(merged.boxes.after.y > merged.boxes.a3.y + 40, 'below the longest lane')
  const merge = endpoints(endsAt(merged.edges, top)[0].d).start
  assert.equal(merged.edges.filter((edge) => {
    const { end } = endpoints(edge.d)
    return Math.abs(end.x - merge.x) < 0.5 && Math.abs(end.y - merge.y) < 0.5
  }).length, 2, 'both lanes merge, then the line goes on')
})

test('an open end is open all the way down: a chapter or a lane ending in a split does not merge either', () => {
  const root = sample()
  // The last main-line item gets a chapter that ends in a split; nothing follows it anywhere.
  const tail = root.children.find((child) => child.id === 'done')
  tail.children = [fork('', [lane('x', [step('x1', { id: 'x1' })], { id: 'lx' }), lane('y', [step('y1', { id: 'y1' })], { id: 'ly' })], { id: 'fz' })]
  const { boxes, edges } = place(root, { fold: { done: 'children' } })
  for (const id of ['x1', 'y1']) same(startsAt(edges, { x: boxes[id].x + boxes[id].w / 2, y: boxes[id].y + boxes[id].h }), [], `${id} leads nowhere`)
  // The fork in the middle of the main line still merges into 修改 lua.
  const lua = { x: boxes.lua.x + boxes.lua.w / 2, y: boxes.lua.y }
  assert.equal(endsAt(edges, lua).length, 1)
  // A split in a chapter that is followed (head's chapter, then model) merges back into the frame.
  const head = root.children.find((child) => child.id === 'head')
  head.children.push(fork('', [lane('p', [step('p1', { id: 'p1' })], { id: 'lp' }), lane('q', [step('q9', { id: 'q9' })], { id: 'lq9' })], { id: 'fh' }))
  const followed = place(root, { fold: { head: 'children' } })
  assert.ok(startsAt(followed.edges, { x: followed.boxes.p1.x + followed.boxes.p1.w / 2, y: followed.boxes.p1.y + followed.boxes.p1.h }).length > 0, 'p1 merges: the chapter is followed by model')
})

// ------------------------------------------------------------------ folding

/** Presses Tab on `id` in a row, like org: each press knows what the previous one left. */
function tabs(root, id, count, fold = {}, last = null) {
  const states = []
  for (let i = 0; i < count; i += 1) {
    const result = T.nextFold(root, fold, id, last)
    states.push(result.state)
    fold = result.fold
    last = result.state
  }
  return { states, fold }
}

test('Tab in a row: folded → children → subtree → folded, skipping states that change nothing', () => {
  const root = sample()
  same(tabs(root, 'head', 2).states, ['open', 'folded'], 'all is the same as open for a leaf: skipped')
  same(tabs(root, 'model', 3).states, ['open', 'folded', 'open'], 'model has no body and no grandchildren: open == all')
  const deep = node('project', 'p', { id: 'p', children: [step('s', { id: 's', children: [step('t', { id: 't', body: 'x' })] })] })
  same(tabs(deep, 's', 4).states, ['open', 'all', 'folded', 'open'])
  assert.equal(T.nextFold(root, {}, 'lua', null).changed, false, 'no body, no line: Tab is a no-op')
})

test('a Tab after anything else folds an open node instead of going on to the subtree', () => {
  const deep = node('project', 'p', { id: 'p', children: [step('s', { id: 's', children: [step('t', { id: 't', body: 'x' })] })] })
  const opened = T.nextFold(deep, {}, 's', null)
  assert.equal(opened.state, 'open')
  assert.equal(T.nextFold(deep, opened.fold, 's', null).state, 'folded', 'the run was broken')
  assert.equal(T.nextFold(deep, { s: 'all' }, 's', null).state, 'folded')
  assert.equal(T.nextFold(deep, { s: 'children' }, 's', null).state, 'folded', 'contents, then Tab: folded')
})

test('opening shows one level: children folded, lanes folded to their labels, nothing below remembered', () => {
  const deep = node('project', 'p', {
    id: 'p',
    children: [
      step('s', {
        id: 's',
        children: [
          step('t', { id: 't', body: 'x', children: [step('u', { id: 'u' })] }),
          fork('', [lane('a', [step('a1', { id: 'a1' })], { id: 'la' }), lane('b', [step('b1', { id: 'b1' })], { id: 'lb' })], { id: 'fs' }),
        ],
      }),
    ],
  })
  const { fold } = T.nextFold(deep, { s: 'folded', t: 'open', la: 'open' }, 's', null)
  const folds = T.computeFolds(deep, fold)
  assert.equal(folds.get('s').lineShown, true)
  assert.equal(folds.get('t').lineShown, false, 't was open before; org forgets it')
  assert.equal(folds.get('t').bodyShown, false)
  for (const id of ['la', 'lb']) assert.equal(folds.get(id).lineShown, false, `${id} shows only its label`)
  same(tabs(deep, 's', 1, fold, 'open').states, ['all'])
  assert.equal(T.computeFolds(deep, tabs(deep, 's', 1, fold, 'open').fold).get('la').lineShown, true, 'the subtree shows every lane')
})

test('Tab under a "show all" folds just that node; the rest stays as it was', () => {
  const root = sample()
  const result = T.nextFold(root, { proj: 'all' }, 'model', null)
  assert.equal(result.state, 'folded')
  assert.equal(result.fold.proj, 'open', 'the all above is pushed down')
  const folds = T.computeFolds(root, result.fold)
  assert.equal(folds.get('model').lineShown, false)
  assert.equal(folds.get('lq').lineShown, true, 'the rest stays open')
  assert.equal(folds.get('head').bodyShown, true)
  assert.equal(folds.get('proj').bodyShown, true)
})

test('Shift+Tab: overview → contents → show all → overview, skipping views that change nothing', () => {
  const root = sample()
  const modes = []
  let fold = {}
  let mode = null
  for (let i = 0; i < 4; i += 1) {
    const result = T.nextGlobalFold(root, fold, mode)
    modes.push(result.mode)
    fold = result.fold
    mode = result.mode
  }
  same(modes, ['overview', 'contents', 'all', 'overview'])
  const contentsView = T.globalFold(root, 'contents')
  assert.equal(T.nextGlobalFold(root, contentsView, null).mode, 'overview', 'after anything else, Shift+Tab starts at the overview')
  // The toolbar button reads the view off the screen, so its clicks go on through the cycle.
  assert.equal(T.globalModeOf(root, contentsView), 'contents')
  assert.equal(T.nextGlobalFold(root, contentsView, T.globalModeOf(root, contentsView)).mode, 'all')
  assert.equal(T.globalModeOf(root, { ...contentsView, head: 'open' }), null, 'a mix of the reader’s own')
  const overview = T.computeFolds(root, T.globalFold(root, 'overview'))
  assert.equal(overview.get('lq').lineShown, false, 'overview folds lanes')
  assert.equal(overview.get('proj').lineShown, true, 'the main line stays visible')
  const contents = T.computeFolds(root, T.globalFold(root, 'contents'))
  assert.equal(contents.get('model').lineShown, true)
  assert.equal(contents.get('head').bodyShown, false, 'contents keeps bodies folded')

  const flat = node('project', 'flat', { id: 'f', children: [step('a', { id: 'a', body: 'x' })] })
  const first = T.nextGlobalFold(flat, {}, null)
  assert.equal(first.mode, 'all', 'overview and contents look the same as now: skipped')
})

test('defaults: lanes open, everything else folded; a selection reveals its path', () => {
  const root = sample()
  const folds = T.computeFolds(root, {})
  assert.equal(folds.get('lq').lineShown, true)
  assert.equal(folds.get('model').lineShown, false)
  assert.equal(folds.get('proj').bodyShown, false)
  const fold = T.revealPath(root, { lq: 'folded' }, 'q2', false)
  assert.equal(fold.lq, 'open')
  const child = T.revealPath(root, {}, 'lua', true)
  assert.equal(child.lua, 'children', 'a step about to get its first sub-step opens')
})

test('a draft card is inserted where the new step will go', () => {
  const root = sample()
  const after = T.withDraft(root, { parent: 'proj', after: 'model', kind: 'step' })
  same(T.lineOf(after).map((n) => n.id).slice(0, 3), ['head', 'model', T.constants.DRAFT_ID])
  const first = T.withDraft(root, { parent: 'lq', after: '', kind: 'step' })
  assert.equal(T.lineOf(T.indexTree(first).get('lq').node)[0].id, T.constants.DRAFT_ID)
  assert.equal(root.children.length, 6, 'the stored tree is not touched')
  assert.equal(after.children[1], root.children[1], 'untouched branches are shared')
})

test('the wheel zooms; Shift and a sideways wheel pan; a scrolling box keeps the wheel', () => {
  const wheel = (extra) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...extra })
  const box = (extra) => ({ scrollTop: 0, scrollLeft: 0, scrollHeight: 100, scrollWidth: 100, clientHeight: 100, clientWidth: 100, ...extra })
  same(T.wheelIntent(wheel({ deltaY: 100 }), [], 600), { kind: 'zoom', delta: 100 })
  same(T.wheelIntent(wheel({ deltaY: 3, deltaMode: 1 }), [], 600), { kind: 'zoom', delta: 48 }, 'line mode is in pixels')
  same(T.wheelIntent(wheel({ deltaY: -4, ctrlKey: true }), [], 600), { kind: 'zoom', delta: -4 }, 'a pinch zooms')
  same(T.wheelIntent(wheel({ deltaY: 100, shiftKey: true }), [], 600), { kind: 'pan', dx: 100 })
  same(T.wheelIntent(wheel({ deltaX: 100, shiftKey: true }), [], 600), { kind: 'pan', dx: 100 }, 'Shift already turned sideways')
  same(T.wheelIntent(wheel({ deltaX: 40, deltaY: 2 }), [], 600), { kind: 'pan', dx: 40 }, 'a sideways wheel')

  const tall = box({ scrollHeight: 400 })
  same(T.wheelIntent(wheel({ deltaY: 100 }), [tall], 600), { kind: 'native' })
  same(T.wheelIntent(wheel({ deltaY: -100 }), [tall], 600), { kind: 'hold' }, 'at its top it holds, never zooms')
  same(T.wheelIntent(wheel({ deltaY: 100, ctrlKey: true }), [tall], 600), { kind: 'zoom', delta: 100 })
  const wide = box({ scrollWidth: 400 })
  same(T.wheelIntent(wheel({ deltaY: 100 }), [wide], 600), { kind: 'zoom', delta: 100 }, 'a wide code block does not take a vertical wheel')
  same(T.wheelIntent(wheel({ deltaY: 100 }), [wide, tall], 600), { kind: 'native' }, 'the card body around it does')
  same(T.wheelIntent(wheel({ deltaY: 100, shiftKey: true }), [wide], 600), { kind: 'native' })
})

test('a stored view is cleaned before use', () => {
  const view = T.normalizeView({ fold: { a: 'open', b: 'sideways' }, offsets: { a: { dx: 3, dy: 'x' }, z: { dx: 0, dy: 0 } }, camera: { x: 1, y: 2 }, cycle: 'all', selected: 7 })
  same(view, { fold: { a: 'open' }, offsets: { a: { dx: 3, dy: 0 } }, camera: null, selected: null }, 'a Shift+Tab run is not kept')
  assert.equal(T.shortTitle('(工单 1234) NAS 迁移到 ZFS【存储】旧盘换新盘'), 'NAS 迁移到 ZFS')
  assert.equal(T.shortTitle('BLOG'), 'BLOG')
})
