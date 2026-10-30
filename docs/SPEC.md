# dsh-mainline — implementation contract

This file is the contract between the parts of the plugin. Each part is written by a different
person (or agent) at the same time, so **the names, shapes and behaviours below are binding**: if
something here is wrong or missing, say so in your report instead of silently diverging.

`docs/prototype/mainline.html` is the approved interaction prototype (open it in a browser). The
product idea, in the user's words: a game walkthrough. A *video* walkthrough has a **main line** you
follow; a *wiki* has every detail but no line. A work item here is a walkthrough: a main line of
steps, **forks** where the line splits into lanes that run side by side and merge back into what
follows (two environments, two competing hypotheses — or, with nothing following, several unrelated
things in one project), and **references** (commands, code locations, register
values, links, design docs) hanging off a step — looked up, not followed, and never drawn as part of
the line.

## 0. Hard constraints (all parts)

- No runtime dependencies. Node ≥ 22, ESM in `lib/` (host), except `lib/client.js` which is a
  **classic browser script** (no `import`/`export`) registering with `window.__ModuleLoader__`.
- No build step, no TypeScript, no generated files.
- Never `import` an `@deepseek-ai/*` package. Host services are reached with `ctx.root.get(name)`
  (guarded: may be `undefined`) or `ctx.inject([...], cb)`.
- Every write to a project file goes through `lib/service.js` → `lib/store.js` under the lock.
- Typed failures: `throw new TreeError(code, message)` from `lib/errors.js`; codes must be listed in
  `ERROR_CODES`. Tools return `{ ok: false, reason, error }` instead of throwing.
- Host-side user-facing strings are Chinese. The client has `zh` and `en` dictionaries.
- Client colours: theme tokens only (`var(--dsw-alias-*)`). A hex or `rgb()` literal in
  `lib/client.js` fails the check. The look is **monochrome** (black/white body, greys); no
  per-project colours.
- Comments explain *why*, not what. Small functions, plain data, no classes (except `TreeError`).
- Windows is the primary platform: paths with spaces and CJK, CRLF input, antivirus holding files
  (see `lib/atomic.js`), `fs.watch` quirks.

Existing files you may rely on: `lib/errors.js` (`TreeError`, `asTreeError`, `ERROR_CODES`),
`lib/atomic.js` (`atomicWrite(file, text)`), `lib/lockfile.js` (`createFileLock({ file, logger })`
→ `{ acquire(), release() }`, throws `store-busy` after 5 s).

## 1. The tree

### 1.1 Node (in memory and on the wire — the same JSON)

```js
{
  id: 'k3f2',              // [a-z0-9]{4,8}; unique within its project; project ids unique across projects
  kind: 'project' | 'step' | 'fork' | 'lane' | 'ref',
  title: string,           // one line, trimmed, ≤ 300 chars; may be '' only transiently in the UI
  state: '' | 'todo' | 'halt',  // '' = a record; 'todo' = still to do; 'halt' = not to do (done OR paused —
                           // the user deliberately does not distinguish the two)
  question: boolean,       // a doubt. Usually todo while open, halt once answered in its body
  body: string,            // markdown, '\n' line endings, no trailing newline, may be ''
  attrs: { [key]: string },// extra heading attributes, preserved verbatim (e.g. cwd on a project)
  children: Node[],        // file order; see 1.2 for what each kind may contain
}
```

The project root node additionally carries `preamble: string` (text before its H1, usually '').

### 1.2 What a kind may contain, and what it means

| parent | children allowed | meaning |
|---|---|---|
| project | step, fork, ref | non-ref children in order = the **main line**; refs = project references |
| step | step, fork, ref | non-ref children = the step's **chapter** (a sub-line); refs = its references |
| fork | lane, ref | each lane runs side by side; after the last item of every lane the line merges back into what follows the fork — with nothing following, the lanes run to their own ends |
| lane | step, fork, ref | the lane's own line |
| ref | ref | nested references |

Derived (never stored): `refsOf(n) = n.children.filter(c => c.kind === 'ref')`,
`lineOf(n) = n.children.filter(c => c.kind !== 'ref')`.
**Every line is a line** — the project's, a chapter, a lane: the same rules everywhere, and none
is the only one. A line can split anywhere, its head included, so a project can hold several
unrelated things side by side (a fork at the head of the project's line). **Lanes merge into
whatever follows them; with nothing following, they run to their own ends and never merge.**
"Following" looks all the way out: a fork ending a chapter merges into the frame when that step
has something after it, and runs open when the step itself is the end of an open line.
`state` is meaningful for project and step; it is preserved but ignored for fork, lane and ref.
A **live** item is a step whose state is `todo`, or anything that contains one (not inside a
`halt` step). The UI greys out non-live lines.

### 1.3 Tree helpers (`lib/tree.js`, pure, no I/O)

```js
KINDS                                   // ['project','step','fork','lane','ref']
STATES                                  // ['', 'todo', 'halt']
canContain(parentKind, childKind) → boolean      // table 1.2
refsOf(node) → Node[]; lineOf(node) → Node[]
isLive(node) → boolean                  // 1.2
walk(root, fn(node, parent, depth))     // pre-order, file order
findNode(root, id) → { node, parent, index, path } | null   // path: ancestors, root first, excluding node
newId(used: Set<string>) → string       // random [a-z0-9]{4}, grows to 8 on collisions
counts(root) → { todo, halt, steps, questions }
describePath(root, id) → string         // 1.4
clone(node) → Node                      // deep copy
makeNode({ kind, title, state?, question?, body?, attrs?, children? }, used) → Node
```

### 1.4 Path description (`where`)

`describePath(projectRoot, nodeId)` → a Chinese one-liner the AI and the panel use, e.g.
`NAS→ZFS › 两台机器 › nas-b › 换盘（第 3 步）`:
project title (clipped to 24), then each ancestor below the project — a fork contributes its title
if it has one, a lane its title, a step its title (clipped to 18) — then the node's title (clipped
to 24) and, for a step, `（第 N 步）` where N is its 1-based index in `lineOf(parent)`. A ref ends
with `（参考）`. Clipping uses `…`.

## 2. The file format (`lib/format.js`)

One project = one UTF-8 Markdown file. **Heading depth is tree depth**; the body of a node is the
text between its heading and the next heading.

```markdown
# HALT NAS 迁移到 ZFS {#hl01 cwd="D:/homelab"}

把家里的 NAS 从旧阵列迁到 ZFS……

## REF 设计文档 {#d1}

存放选型笔记与回滚预案的链接。

## 备份旧数据 {#h1}

先把旧阵列整体备份到外接硬盘。

### REF 磁盘清单 {#o1}

## FORK 两台机器 {#f1}

### nas-a {#l1}

#### nas-a c {#s1}

### nas-b {#l2}

#### 换盘 {#s2}

加载后验证：

```bash
dmesg | grep -i ata
```

##### REF 校验 {#g1}

zpool status 里 errors 一栏应为 No known data errors。

## TODO ? mpu 是否不跑该函数，只有 lpu 跑 {#q1}

## HALT 收尾 {#t1}
```

### 2.1 Heading grammar

```
heading := '#'{depth} ' ' [STATE ' '] [KIND ' '] ['? '] title [' ' attrblock]
STATE   := 'TODO' | 'HALT'
KIND    := 'REF' | 'FORK'
attrblock := '{' token (' ' token)* '}'      token := '#'id | key '=' value | key
value   := bare (no space, no '}', no '"') | '"' chars-without-'"' '"'
```

- `depth` = node depth: project 1, its children 2, … **Depth above 6 is written with more `#`**
  (`#######`). Markdown renderers show those as text; editors' outline modes still fold them. The
  parser accepts any count.
- On read the kind comes from the marker **and the parent**: under a `ref` every heading is a ref
  (marker optional); under a `fork` a `REF` heading is a ref and any other heading is a lane;
  elsewhere `REF` → ref, `FORK` → fork, no marker → step. On write a KIND marker is emitted only
  where the context does not already imply it (refs under refs and lanes under forks get none).
- A heading that skips levels (`###` right under `#`) is a child of the nearest shallower heading.
  The writer always emits canonical depths, so such a file is normalized on the first write.
- The first H1 is the project. Any further H1 is parsed as a top-level step of that project. A file
  without any H1 gets a project titled after the file stem, and every heading becomes a descendant.
- The parse is **total**: any text produces a tree; nothing is dropped. Text before the first
  heading is `preamble`.
- Escapes, so every title and body round-trips:
  - a title that would read as a marker (`TODO x`, `HALT x`, `REF x`, `FORK x`, `? x`) is written
    with a leading backslash (`\TODO x`) and the parser removes exactly one leading backslash
    from a title that starts with one;
  - a title that ends with something shaped like an attribute block gets its `{` written as `\{`;
  - a body line **outside fenced code** that matches `/^ {0,3}\\*#+(\s|$)/` is written with one
    extra leading backslash and read back with one removed. Lines inside fences are verbatim.
- Fences: a line `/^ {0,3}(`{3,}|~{3,})/` opens; the closing line uses the same character, at
  least as many, and nothing but whitespace after. Inside a **closed** fence every line is code (a
  `# x` line there is not a heading and is never escaped). An opening line **without** a matching
  close before the end of the file is plain text — an unclosed fence must not be able to swallow
  the rest of the tree. Reader and writer apply the same rule, so escapes stay symmetric.
- Ids: `{#id}`. A heading without an id gets a **deterministic** id (stable across re-parses of
  the same text): `'x' + base36(fnv1a32(file + '\0' + titles-path + '\0' + sibling-index))`
  clipped to 6 chars, de-duplicated by appending a counter. The id is persisted the next time the
  plugin writes the file. Duplicate ids in one file: the later one is replaced by a deterministic id.
- CRLF input is accepted; output always uses `\n`.

### 2.2 Writing

```
<preamble, verbatim, if any, followed by one blank line>
<heading>
<blank line, then body, if body is non-empty>
<blank line before every following heading>
```
The file ends with exactly one `\n`. `serialize(parse(text))` must equal `text` for any text that is
already canonical (fixtures in `fixtures/` are canonical).

### 2.3 API

```js
parse(text, { file }) → root            // root.kind === 'project'
serialize(root) → string
serializeSubtree(node, depth) → string  // the same format starting at `depth`; used by tools
parseSubtree(text, { file, kindHint }) → Node[]  // top-level nodes of a markdown fragment
```

## 3. Store, git, watch, events, service (core)

### 3.1 Directory

```
<root>/                       default: $DSH_HOME/mainline (DSH_HOME env, else ~/.dsh)
  mainline.json               { "version": 1, "order": ["blog.md", "homelab.md"] } — committed
  *.md                        one file per project — committed
  .gitignore                  ".mainline/\n" — committed
  .mainline/                  local, ignored by git
    lock                      the cross-process write lock (lib/lockfile.js)
    events.jsonl              append-only event log (view/* events are not logged)
    session.json              { "sessionId": "session-…" }
    view/<projectId>.json     per-user view state (fold, offsets, camera)
```

New project file name: the title with `\ / : * ? " < > | # { }` and whitespace runs replaced by
`-`, trimmed of `-`, clipped to 60 chars, `.md`, de-duplicated with `-2`, `-3`. A rename never
renames the file. Files present on disk but missing from `order` are appended (by name); names in
`order` without a file are dropped.

### 3.2 Writes

`store.update(projectId, mutate)`: take the lock → read the file → parse → `mutate(root)` →
serialize → **re-read the file and compare with what was read; if it changed (an editor saved in
between), re-run from the read** (max 3 attempts) → `atomicWrite` → release. The in-memory cache
is updated, and the written content's hash is remembered so the watcher ignores our own write.

### 3.3 External edits (`lib/watch.js`)

`fs.watch(root)` (non-recursive) with a 300 ms debounce per file. A `.md` change whose content hash
is not one we wrote is an external edit: re-parse, diff against the cached tree by id
(added / removed / changed = title, state, question or body differs), update the cache, publish
`tree/external`, schedule a git commit with actor `external`. A file that appears or disappears
updates the project list. Never write a file in response to an external edit (it would fight the
editor).

### 3.4 Git (`lib/git.js`)

Plain `child_process.execFile('git', args, { cwd: root })`; no shell.
- `init()`: if `git` is missing → `available = false` and everything else is a no-op (history
  routes answer `git-unavailable`). If `<root>` is not a repo → `git init -b main`, write
  `.gitignore`, first commit.
- Identity: every commit passes `-c user.name=… -c user.email=…` **only when** `git config
  user.name` / `user.email` are unset (fallback `dsh-mainline` / `mainline@localhost`). An agent
  write is committed with `--author="DSH Agent <agent@dsh.local>"`.
- `schedule(summary, actor)`: debounce (`commitDelayMs`, default 4000). When it fires:
  `git add -A -- *.md mainline.json .gitignore` then commit with message = first summary, plus
  `（另有 N 处改动）` when several were batched. Nothing staged → no commit.
- `flush()`: commit now (used on unload). `log({ file, limit })` → `[{ rev, short, author, at,
  message }]`. `show(rev, file)` → text. Never `reset`, never rewrite history: a restore is a new
  commit.
- After a commit, publish `git/committed`.

### 3.5 Events (`lib/events.js`)

```js
event = {
  id: string,          // randomUUID
  seq: number,         // monotonic per process
  type: string,        // see below
  at: number,          // epoch ms
  actor: { kind: 'human' | 'agent' | 'external' | 'system', session?: string },
  project: string | null,
  node: string | null,
  summary: string,     // one Chinese sentence, ready to show a person or a model
  data: object,
}
```

| type | data |
|---|---|
| `node/created` | `{ kind, title, parent, after }` |
| `node/updated` | `{ fields: string[], before: {…}, after: {…} }` — scalar fields only; for `body` only lengths |
| `node/moved` | `{ fromParent, toParent, after }` |
| `node/removed` | `{ kind, title, count }` (subtree size) |
| `project/created` / `project/removed` / `project/restored` | `{ file, title, rev? }` |
| `projects/reordered` | `{ order }` |
| `tree/external` | `{ file, added: [], removed: [], changed: [] }` |
| `view/focus` | `{ where }` (not logged) |
| `run/started` / `run/finished` | `{ runId, index, command, cwd }` / `+ { exitCode, timedOut, aborted, tail }` |
| `session/asked` | `{ text }` |
| `git/committed` | `{ rev, message }` |

`createEvents({ file, logger, emit, now })` → `{ publish(partial) → event, subscribe(fn) →
dispose, recent(limit) }`. `publish` fills `id/seq/at`, appends to `events.jsonl` (best effort,
chained, never throws), calls `emit('mainline/event', event)` and `emit('mainline/' + type, event)`
(index.js passes `(name, e) => ctx.emit(name, e)`; a throwing listener must not break the write),
then calls every subscriber (same isolation). `events.jsonl` is rotated to `events.1.jsonl` past
5 MB.

### 3.6 Service (`lib/service.js`) — the single write path

```js
createService({ root, logger, events, git, now }) → {
  ready(): Promise<void>,               // mkdir, git.init, load every project, start watcher
  close(): Promise<void>,               // stop watcher, git.flush
  root: string,
  listProjects(): ProjectSummary[],     // sync, from cache, in order
  getProject(id): Project,              // sync, from cache; throws not-found
  apply(op, actor): Promise<ApplyResult>,
  readMarkdown(projectId, nodeId?): { markdown, rev, where },
  writeMarkdown(projectId, nodeId | null, markdown, actor): Promise<ApplyResult>,
  history(projectId | null, limit): Promise<Commit[]>,
  where(projectId, nodeId): string,     // describePath, '' when unknown
  locate(projectId, nodeId): { node, parent, index, path } | null,   // path: ancestors root→parent
  focus(projectId, nodeId | null, actor): void,   // publishes view/focus only
  readView(projectId): Promise<object>, writeView(projectId, view): Promise<void>,
}
ProjectSummary = { id, file, title, state, todo, halt, steps }   // counts over the whole tree
Project        = { id, file, rev, root }                          // rev: first 12 hex of sha1(file text)
ApplyResult    = { project: Project | null, nodeId: string | null, removed?: Node, events: Event[] }
```

`actor` = `{ kind: 'human' | 'agent' | 'external' | 'system', session?: string }`. Every successful
op publishes its events (summary uses `where`) and calls `git.schedule(summary, actor)`.

Ops (`op.type`), validated strictly (unknown keys → `invalid-op`):

| type | fields | notes |
|---|---|---|
| `create` | `project, parent, after?, kind, title, state?, question?, body?, attrs?` | `after` omitted → append; `''` → first; else insert after that sibling. Kind must be allowed under parent (`invalid-kind`). Returns `nodeId`. |
| `update` | `project, id, patch: { title?, state?, question?, body?, append?, attrs?, setAttrs? }` | `attrs` replaces the whole map; `setAttrs` merges (`null` deletes a key); `append` adds a paragraph to the body under the lock. `body`+`append` or `attrs`+`setAttrs` together → `invalid-op`. No change → no event, no commit. |
| `move` | `project, id, parent, after?` | within one project; refuses moving a node into itself/descendants, the project root, or a kind not allowed under the new parent (`invalid-move`) |
| `remove` | `project, id` | returns the removed subtree in `removed` (for undo) |
| `insert` | `project, parent, after?, node` | re-inserts a subtree (undo of remove); ids that now collide are regenerated |
| `fork` | `project, after, title?, lanes: string[]` | inserts a fork right after step `after` in the same line, one empty lane per name (≥ 2 names) |
| `branch` | `project, parent, title, state?, question?, body?` | a new step **beside** `parent`'s line rather than after it — the way to put another thing next to a line. A line that is nothing but one fork gets one more lane; any other line is split: its items, untouched (ids kept, two levels deeper), into an unnamed lane, the step into a second unnamed lane; into an empty line it is simply the first step. References stay with `parent`. Returns the step's id. |
| `createProject` | `title, body?, markdown?` | `markdown` = a whole file to start from (import); returns the project id in `nodeId` |
| `removeProject` | `project` | deletes the file (git keeps it) |
| `renameProject` | `project, title` | title only; file name stays |
| `reorderProjects` | `order: string[]` | project ids |
| `restore` | `project, rev` | file content from `git show rev:file`, written through the lock |

Validation: titles trimmed, newlines → spaces, 1–300 chars (`invalid-title`); body ≤ 100 000 chars
(`invalid-content`); state in `['', 'todo', 'halt']` (`invalid-state`); `attrs` values strings
without newlines (`invalid-attrs`).

## 4. Host integration (`lib/session.js`, `lib/runner.js`, `lib/prompt.js`, `lib/tools.js`, `lib/routes.js`, `lib/index.js`)

### 4.1 The session — one ordinary DSH conversation

There is no "butler": it is a normal DSH session, created the way the Host's own "new
conversation" creates one, so every plugin, tool, approval and model picker works in it.

- `ensure()`: read `.mainline/session.json`; if the id resolves (`ctx.root.get('agents').get(id)`
  or `sessionController.resolveAgent(id)` returns `{ agent }`) reuse it. Otherwise create:
  `const sc = ctx.root.get('sessionController')`; prefer a workspace for `sessionCwd`
  (`workspaceRegistry.resolveByPath(cwd) ?? workspaceRegistry.create(cwd, '工作树')`, both optional
  and guarded) → `sc.create({ workspaceId })`, fallback `sc.create({ cwd })`. Persist the id.
  No sessionController → `session-unavailable`.
- `sessionCwd` config (default: home directory). Never the tree root itself (a file tool aimed at
  the project files would bypass the lock).
- `reset()`: forget the id; the old session stays in the sidebar as the conversation it was.
- **Events → the model, without starting a turn.** Subscribe to events; skip `git/committed`,
  `view/*` duplicates (keep only the latest focus in the pending batch), and events whose
  `actor.session` is this session (the model already knows what its own tools did). Pending events
  accumulate in one message that is kept up to date with `agent.inbox.replace(pendingId, msg)`;
  when `replace` returns false (claimed) a new message is started with `agent.inject(msg)`.
  Inject only while `agent.status === 'idle'`; while running, hold the batch and flush when
  `ctx.on('agent/status', p => …)` reports `p.agent.id === id && p.status === 'idle'`. Cap the
  batch at 40 lines (drop the oldest, keep a count).
  Message: `{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind:
  'plugin:dsh-mainline', form: 'notice', summary: '工作树：N 项操作' } }` with text
  `【工作树】用户在面板上的操作（较早的在前）：\n- 10:31 聚焦 BLOG › …\n- 10:32 ……`.
- `ask(text, summary)`: `agent.followup(msg)` — starts (or queues) a real turn. Used by "交给 AI".
- Focus context: `systemPrompt.context({ name: 'dsh-mainline:focus', order: 140, interpolate:
  false, text: c => c.agent?.id === id ? renderFocus() : '' })` (registered through
  `ctx.inject(['systemPrompt'])`). `renderFocus()` = current project title + file, the focused
  node's `where`, its title/state/question, body (first 1500 chars), its references' titles, and
  the previous/next items of its line. No focus → the project list with todo counts.
- Guidance: `systemPrompt.section({ name: 'dsh-mainline:guidance', order: 3050, interpolate: false,
  text: c => c.agent?.id === id ? GUIDANCE_FULL : GUIDANCE_SHORT })`. Write GUIDANCE in
  `lib/prompt.js`. It must teach: the tree is the user's engineering record across **many
  projects**; each project is a walkthrough (main line, forks for parallel environments/hypotheses
  that merge back into what follows — or, at the head of a line with nothing following, unrelated
  things side by side — references for lookup material, `?` for doubts); the focus context says which
  project/step the user is on — keep projects apart, never mix their context, ask when unsure which
  project a remark belongs to; record findings where they belong (a result → the step's body or a
  ref; a new doubt → a `?` step; competing hypotheses → a fork); `halt` means "no longer to do"
  (done or paused, deliberately not distinguished); use `mainline_*` tools, never edit the
  Markdown files with file tools; history is git (`mainline_history` / `mainline_restore`).
- The session must keep working after a plugin reload (it is owned by the Host, not this plugin).

### 4.2 Running a command from a card (`lib/runner.js`)

`extractFences(body)` → `[{ index, lang, code, start, end }]` for fences whose info string's first
word is one of `bash sh shell zsh console pwsh powershell ps1 cmd bat` (case-insensitive).

- `run({ project, node, index }, actor)`: the command is taken **from the stored body** (never
  from the request — the route must not become "execute arbitrary text"). cwd = the nearest
  `attrs.cwd` on the node or its ancestors, else `sessionCwd`. `shell = ctx.root.get('shell')`
  (missing → `shell-unavailable`); `policy = ctx.root.get('sandboxPolicy')?.resolve?.()`;
  `spec = shell.resolve({ command, workdir: cwd, timeoutMs: 120000, sandboxPolicy: policy })`;
  `execution = await shell.execute(spec)`; `result = await execution.result()` →
  `{ exitCode, signal, timedOut, aborted, stdout: { text, truncated }, stderr: { … } }`.
  Keep the last run per `project/node/index` in memory: `{ runId, index, status: 'running' |
  'done' | 'failed', command, cwd, startedAt, endedAt, exitCode, timedOut, aborted, stdout,
  stderr }` (stdout/stderr tails ≤ 20 000 chars). Publish `run/started` / `run/finished` (summary
  includes the exit code and the last line of output). `cancel(runId)` → `execution.kill()`.
  One run per fence at a time (a second start answers the running one).
- "交给 AI" for a fence: `session.ask(text)` with the card's `where`, the cwd and the command in a
  fenced block, asking the model to run it with its shell tool and record the conclusion back on
  the card. For a whole card: "请继续推进「where」这一步……".

### 4.3 Agent tools (`lib/tools.js`)

Schemas use **only** `type` (a single string) / `oneOf` / `properties` / `required` /
`additionalProperties` / `items` / `enum` / `const` plus annotations (`description`, `title`,
`default`, `examples`). Nullability is `oneOf: [{type:'string'},{type:'null'}]`. A schema outside
the subset is silently rejected by the Host, so `test/schema.test.mjs` walks every schema.
Each definition: `{ name, description, parameters, timeoutMs, isConcurrencySafe: () => bool,
output: { schema, render: (args, value) => [{ type: 'text', text }] }, execute(args, exec) }`.
The actor is `{ kind: 'agent', session: exec?.agent?.id }`. States on the wire are
`'none' | 'todo' | 'halt'` (`'none'` ↔ `''`).

| tool | parameters | result |
|---|---|---|
| `mainline_projects` | — | `{ ok, projects }` |
| `mainline_read` | `project, node?, depth?` | `{ ok, where, rev, markdown }` (the file format, ids included; `depth` limits levels) |
| `mainline_add` | `project, parent, after?, kind, title, state?, question?, body?` | `{ ok, id, where }` |
| `mainline_update` | `project, id, title?, state?, question?, body?, append?, cwd?` | `{ ok, where }` — `append` adds a paragraph to the body |
| `mainline_move` | `project, id, parent, after?` | `{ ok, where }` |
| `mainline_remove` | `project, id` | `{ ok, removed: { title, count } }` |
| `mainline_fork` | `project, after, lanes, title?` | `{ ok, id, lanes: [{ id, title }] }` |
| `mainline_branch` | `project, parent?, title, state?, question?, body?` | `{ ok, id, where }` — the `branch` op; `parent` omitted = the project |
| `mainline_write` | `project, node?, markdown` | `{ ok, rev }` — replace a subtree (or the whole project) with Markdown in the file format; ids present are kept |
| `mainline_create_project` | `title, body?, markdown?` | `{ ok, id, file }` |
| `mainline_history` | `project?, limit?` | `{ ok, commits }` |
| `mainline_restore` | `project, rev` | `{ ok, rev }` |

`project` accepts a project id, a file name or an exact title.

### 4.4 HTTP (`lib/routes.js`) — prefix `/api/mainline`

Registered with `webServer.register({ kind: 'exact', path, handler })`; one verb per path (405
otherwise). Every handler is fenced exactly like dsh-global-todo's `route()` (the Host
`connection.requestRejection(request)` resolved per request, a loopback-only rule when there is no
fence, credential-less local scripts allowed on loopback). Replies `{ ok: true, data }` or
`{ ok: false, reason, error }` with `statusForCode` (`not-found` 404, `payload-too-large` 413,
`forbidden` 403, `store-busy` 503, `store-corrupt|store-unwritable|internal` 500,
`git-unavailable|shell-unavailable|session-unavailable` 503, else 400). Body ≤ 1 MiB.

| verb | path | body / query | data |
|---|---|---|---|
| GET | `/api/mainline/health` | | `{ version, root, git, session, tools, projects }` |
| GET | `/api/mainline/projects` | | `{ projects }` |
| GET | `/api/mainline/project` | `?id=` | `{ project }` |
| POST | `/api/mainline/op` | `{ op }` | `{ project, nodeId, removed?, events }` (`project` is the full tree after the op, or null) |
| POST | `/api/mainline/focus` | `{ project, node }` | `{}` |
| GET | `/api/mainline/stream` | | **SSE**: `event: mainline` / `data: <event JSON>`; `: ping` every 25 s; `retry: 3000` |
| GET | `/api/mainline/session` | | `{ sessionId, cwd }` (ensures one exists) |
| POST | `/api/mainline/session/reset` | `{}` | `{ sessionId }` |
| POST | `/api/mainline/run` | `{ project, node, index }` | `{ run }` |
| POST | `/api/mainline/run/cancel` | `{ runId }` | `{ cancelled }` |
| GET | `/api/mainline/runs` | `?project=&node=` | `{ runs }` |
| POST | `/api/mainline/ask` | `{ project, node, index?, text? }` | `{ sent: true }` |
| GET | `/api/mainline/history` | `?project=&limit=` | `{ commits }` |
| GET | `/api/mainline/view` | `?project=` | `{ view }` |
| POST | `/api/mainline/view` | `{ project, view }` | `{}` |

Routes record the actor `{ kind: 'human' }`. SSE: set `content-type: text/event-stream`,
`cache-control: no-store`, keep the response open, unsubscribe on `close`.

### 4.5 Wiring (`lib/index.js`)

`export const name = 'dsh-mainline'`, `export const VERSION` (= package.json version),
`export function apply(ctx, config)`, `export default { name, apply }`. Config (`DEFAULTS`):
`{ root: '', sessionCwd: '', commitDelayMs: 4000, guidance: true }`. `apply` creates events →
git → service (`ready()` in an effect; `close()` on dispose) → session → runner; registers tools
(`ctx.inject(['tools'])`), routes (`ctx.inject(['webServer'])`), prompt pieces
(`ctx.inject(['systemPrompt'])`) and the `agent/status` listener, each in its own effect with a
disposer that never throws.

## 5. The panel (`lib/client.js`)

Classic script. `window.__ModuleLoader__.load({ id: 'dsh-mainline', factory(require) { … return {
inject: ['sessions', 'uiWorkspace', 'slots', 'locale'], apply(ctx) { … } } } })`. React comes from
`require('react')`; `h = React.createElement` (no JSX). Registrations, in effects with disposers:
`sidebar.panellist` entry id `mainline` (order 85), `main` key `mainline` with a session-scoped
child slot `mainline.chat.conversation` (`children: { 'mainline.chat.conversation': { kind:
'single', scope: 'session' } }`), and that child slot rendering the Host conversation factory —
copy the proven pattern from `../dsh-global-todo/lib/client.js` (`ChatEmbed`, `ButlerConversation`,
`PinnedChatView`, `withLocale`, `resolveLang`, the error boundary). Calls are **document-relative**
(`api/mainline/...`, no leading slash). Live updates: `new EventSource('api/mainline/stream')`;
on an event for the open project, refetch it (debounced 150 ms); fall back to polling every 15 s
when `EventSource` is missing or errors repeatedly.

### 5.1 Layout

```
┌ tabs: BLOG 27 │ NAS→ZFS │ … │ + 新项目 ─────────── 历史 ▾ · 回到焦点 · 适应窗口 · 92% ┐┌ detail ───────────┐
│                                                                                        ││ path › path       │
│                     canvas: the walkthrough of the open project                         ││ title  [记录|要做|不用做] ? │
│                     (cards, lane pills, fork labels, edges, chapter frames)             ││ body (markdown)    │
│                                                                                        ││ 参考 (tree)        │
│                                                                                        │├ DSH 会话 ↗ ⟲ ─────┤
│                                                                                        ││ embedded Host      │
│                                                                                        ││ conversation       │
└────────────────────────────────────────────────────────────────────────────────────────┘└───────────────────┘
```

The right column is ~400 px (draggable splitter, remembered in `localStorage`), split between the
detail (top) and the conversation (bottom) by a second draggable splitter. The detail and the
conversation layout are approved by the user — keep them.

Canvas layout: port the prototype's algorithm (`mLine`/`mStep`/`mFork` measure, `pLine`/`pStep`/
`pFork` place, `elbow` edges, chapter frames). Lanes are **selectable and foldable** like cards.
A fork with nothing following it (1.2) draws no merge: each lane ends at its last item and the
block is as tall as its tallest lane.

### 5.2 Look — monochrome

- Body text `--dsw-alias-label-primary`, secondary text `--dsw-alias-label-secondary`, surfaces
  `--dsw-alias-bg-base` / `bg-layer-1` / `bg-layer-2`, borders `border-l1` / `border-l2`.
- `todo`: a 3 px bar in label-primary on the card's left edge, title in label-primary.
- `halt`: title in label-secondary, dashed border, no shadow.
- record (`''`): plain card.
- `question`: a small outlined "?" before the title.
- Selected: 1.5 px label-primary border and a soft shadow. Edges on the path from the project to the
  selected node: label-primary, 2.5 px. Other live edges: border-l2, 1.5 px. Edges of non-live
  segments: border-l1, dashed.
- No hue anywhere except the error token for errors.

### 5.3 Cards and folding (org-like)

A card shows: question mark, title, and — when folded — a one-line peek of the body, a 📎 chip
with the reference count and the first two titles, and a `▸ N 步` chip for a chapter.
Each node has a fold state in the view: `folded` | `open` | `all`.
- `folded`: title + peek; its chapter/lane line is hidden.
- `open`: the body rendered as Markdown **inside the card** (the card widens to 360 px), and its
  line is shown (children themselves keep their own fold state).
- `all`: the node and every descendant `open`.
- **Tab** on the selected node cycles `folded → open → all → folded` (skipping states that change
  nothing). **Shift+Tab** cycles the whole project: overview (every node folded, the main line
  visible) → contents (every line visible, bodies folded) → show all → overview.
Defaults: steps with a chapter `folded`, lanes `open`, everything else `folded`.

### 5.4 Interaction

- Click a card or a lane pill → select (and `POST focus`, debounced 300 ms). Click empty canvas →
  deselect.
- Double-click a title → rename inline (Enter saves, Esc cancels). Double-click the body of an
  `open` card (not a link, button, checkbox or code) → edit it in place with the same raw-Markdown
  textarea as the detail column (5.6), as tall as its wrapped text up to the body's own cap
  (560 px), so editing never shows less than the rendered body did.
- **Ctrl+Enter** → add a next step after the selection (same line) and rename it inline. An empty
  title on Enter/blur removes the new card.
- ↑ / ↓ → previous / next item in visual order; ← / → → the same position in the neighbouring lane.
  Alt+↑ / Alt+↓ → reorder within the line. Enter → rename. Delete → remove, with an 8 s undo toast
  (`insert` op with the `removed` subtree).
- Alt+→ / Alt+← → a level in / out, org-style, the subtree moving along (one `move` op; steps and
  forks only). In: the last step of the previous item's chapter — after a fork, the end of its last
  lane. Out: right after the parent step — from a lane, right after the fork (where the lanes merge
  back). A folded chapter it goes into opens. Nowhere to go → a short toast. Alt+← is always
  claimed on the canvas: it is also the browser's Back.
- Ctrl+X → cut the selection (mark it); Ctrl+V on a target → move it after the target;
  Ctrl+Shift+V → move it into the target as the last child.
- **Free dragging**: drag a card (or lane pill) anywhere; it and everything drawn beneath it
  (its chapter / lane line) move together. Stored as a view offset `{ dx, dy }` per node, applied
  on top of the automatic layout and inherited by descendants; edges follow. **R** resets the
  selected node's offset (back to its place relative to the previous element); Shift+R resets every
  offset in the project. Dragging is never a structural move.
- **Right-click context menu** (custom, at the pointer) instead of letter shortcuts:
  on a card — 加下一步 (Ctrl+Enter) · 加子步骤 · 从这里分叉… · 加参考 · 要做 / 不用做 / 记录 ·
  标为疑问 / 取消疑问 · 交给 AI 继续 · 剪切 (Ctrl+X) / 粘贴为下一步 (Ctrl+V) / 粘贴为子步骤 ·
  恢复位置 (R) · 删除 (Del); on a lane — 改名 · 加一条支线 · 删除这条支线 · 恢复位置;
  on empty canvas — 另起一条线 · 在项目末尾加一步 · 全部折叠 / 全部展开 · 适应窗口.
  **另起一条线** (on a card, the project card included, and on a lane as 在这条支线里再分) puts a
  draft card right away **beside** that card's line — no form, nothing to name — and its title
  makes a `branch` op. On the project card it is the first item and **Ctrl+Enter**: a new thing
  in a project stands beside what is there; 在项目末尾加一步 is the other way to grow it. Otherwise
  the project card has the step card's items, minus those that need a line around it (加下一步,
  从这里分叉, cut, 恢复位置, 删除).
  An unnamed lane draws as a small dot where the line splits (double-click to name it); unnamed
  forks and lanes add nothing to the detail crumbs or to `where`.
  "从这里分叉…" opens a small inline form (lane names, comma separated), never `window.prompt`.
- Canvas: drag empty space to pan; the wheel zooms (0.3–1.6) around the pointer, and so do
  Ctrl+wheel and a trackpad pinch; Shift+wheel or a sideways wheel pans sideways. A box in a card
  that scrolls along the wheel (body, code, table, run output) keeps the wheel, even at its end.
  F → fit, 回到焦点 → centre the selection.
- View state (fold, offsets, camera) is saved per project via `POST view`, debounced 600 ms.

### 5.5 Markdown and commands

A small built-in renderer producing React elements (never `innerHTML`): paragraphs, ATX-less
bodies (a `\#` line shows as `#`), fenced code, inline code, bold, italic, strikethrough, links
(`[t](u)` and bare `http(s)://`; open in a new tab), block quotes, ordered/unordered/task lists with
nesting, GFM pipe tables, horizontal rules. Expose its pure parse function for tests.

Every shell fence (4.2's languages) gets two buttons: **▶ 运行** (`POST run`, output shown under the
fence: running indicator, exit code, stdout/stderr tails, collapsible; a cancel button while
running) and **交给 AI** (`POST ask`). Runs survive a refetch (`GET runs`).

### 5.6 Detail column

Path (clickable crumbs), title (double-click to rename), state segmented control (记录 / 要做 /
不用做), a `?` toggle, the body rendered as Markdown with an 编辑 button (a textarea with the raw
Markdown; Ctrl+Enter or blur saves, Esc cancels), then 参考: the reference tree — each reference
foldable (title; body rendered when open), with add / rename / edit / delete. For the project
itself also a 工作目录 field (`attrs.cwd`).

### 5.7 Conversation

`GET session` gives the id. Render the Host conversation factory through the session-scoped child
slot exactly as dsh-global-todo does (`sessions.retain(id)`, `SessionProvider`, `renderSlot`,
pinned chat view). Header: "DSH 会话", 在主界面打开 (`ctx.uiWorkspace.openSession(id)`), 新开会话
(`POST session/reset`, with an inline confirm). Fallback when the factory or the standard props are
missing: a short note and the 在主界面打开 button — no hand-rolled chat.
