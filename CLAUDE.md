# dsh-mainline — notes for coding agents

A DeepSeek Harness (DSH) plugin: a host half (`lib/*.js`, ESM) and a browser half (`lib/client.js`,
a classic script). `docs/SPEC.md` is the binding contract between the parts — names, shapes, ops,
routes, events. Read it before changing an interface, and change it in the same commit when you
do. `docs/prototype/mainline.html` is the interaction prototype the user approved.

## What this is, and what it must never turn back into

The user is an engineer who kept work in org-mode. The point is **not** a todo list. In the
user's words: a todo system's job is to make the real engineering process concrete — questions
and branches included — and lists and text can only ever linearize it.

The model is a **game walkthrough**. A *video* walkthrough has a main line you follow; a *wiki*
has every detail but no line. You watch the video, and look things up in the wiki when a detail is
unclear. So each project here is:

- **main line** — the steps you follow, top to bottom (`lineOf(node)`);
- **fork** — the line splits into **lanes** drawn side by side (two environments, two competing
  hypotheses, so they can be compared at a glance) and **merges back** into whatever follows,
  below the longest lane. With nothing following, the lanes run to their own ends;
- **reference** — commands, code locations, register values, links, design docs hung on a step.
  Looked up, not followed: **never drawn as part of the line**;
- **chapter** — a step can carry its own sub-line;
- **question** — a `?` step. While open it is `todo`; the answer goes into its body and it becomes
  `halt`. Competing hypotheses become a fork.

**One rule at every level, no limits, no patches.** The project's line, a chapter and a lane are
the same thing and behave the same way; none is the only one. A project can hold several unrelated
things side by side: its line split at the head. The user, on finding they could not add a second
thing next to a project's first step: "没说只能有一个主线啊" — then "不要限制, 也不要打补丁". When
the model cannot express something, generalize the rule; never add a flag or a concept that only
works in one place.

States are exactly three: record (`''`), `todo`, `halt`. **`halt` means "no longer to do" — done
or paused, deliberately not distinguished.** This is the user's own habit and a hard rule: do not
add `done`, `doing`, `cancelled`, priorities or due dates.

Rejected on purpose, with the reason the user gave:
- a list/outline panel with indentation (still linearizes);
- every node drawn as the same card (that is the wiki: no main line);
- per-project colours and badges ("not how people expect colours");
- a "butler" persona — it is an ordinary DSH conversation;
- letter shortcuts for structural actions (`Y` to fork, `Q` for a question) — those live in the
  right-click menu. `Ctrl+Enter` (next step) and `Tab` (fold) stay.

## The event stream is the architecture (hard)

DSH is built on cordis, an event/service architecture, and this plugin follows it. The user plans
to grow it into multi-person collaboration with mutual notifications, so **every change is an
event**, and the event log is what will be replicated later.

- `lib/events.js` `publish()` is the only way a change is announced. An event is
  `{ id (uuid), seq, type, at, actor: { kind, session? }, project, node, summary, data }`.
- One publish does three things: appends to `.mainline/events.jsonl`, calls
  `ctx.emit('mainline/event', e)` **and** `ctx.emit('mainline/<type>', e)` on the host bus (other
  plugins listen there — never invent a private channel), and notifies in-process subscribers
  (the SSE stream to the panel, the session).
- Types are slash-named like the Host's own (`node/created`, `node/updated`, `node/moved`,
  `node/removed`, `project/*`, `tree/external`, `view/focus`, `run/started`, `run/finished`,
  `session/asked`, `git/committed`). A new kind of change gets a new type, listed in SPEC 3.5.
- `actor` is always filled in (`human` / `agent` / `external` / `system`, plus the session id for
  an agent). `summary` is one Chinese sentence a person or a model can read as is.
- Keep collaboration possible: ids are stable and never reused, moves are recorded by node id
  (not by position), and an event never depends on in-memory state to be understood.
- A listener that throws must not break the write that published the event.

### How the conversation hears the panel

- Panel events reach the session through `agent.inject()` — queued in the inbox, **never waking
  the model**, delivered together with the user's next line. One pending message is rewritten in
  place with `agent.inbox.replace()` until the model claims it. Inject only while the agent is
  idle (injecting into a running turn costs that turn an extra step); hold the batch and flush on
  `agent/status` → idle. Only the latest focus is kept.
- The focused step reaches the model through `systemPrompt.context()` (recomputed per step, only
  for this session's agent, `interpolate: false` because titles are user text).
- "交给 AI" is `agent.followup()`: a real turn, used only when the user explicitly asks.
- The model's own tool calls are not echoed back to it (`actor.session` equals the session id).

## The session is an ordinary DSH conversation

Created through `sessionController.create()` — the same path as the UI's "new conversation" — so
every plugin, tool, approval and the model picker work in it, and it outlives a plugin reload.
The panel embeds the Host's own conversation (`conversation.content`, `variant: 'embedded'`);
never hand-roll a chat. Its cwd is never the tree root (a file tool there would bypass the lock).
The guidance tells the model the tree holds **many projects** and the focus says which one: keep
their contexts apart.

## Data: plain Markdown under git (hard)

- One project = one `.md` file in `$DSH_HOME/mainline/`; heading depth is tree depth; markers
  `TODO`/`HALT`, `REF`/`FORK`, `?`; ids in `{#id}`. Depth beyond 6 is written with more `#`.
  The format is total and round-trips byte for byte (`lib/format.js`, `test/format.test.mjs`).
- The directory is a git repository the plugin commits to: batched (`commitDelayMs`), agent
  commits authored `DSH Agent`, **never rewritten** — a restore is a new commit.
- **Every write goes through `lib/service.js` → `store.update()`**: cross-process lock
  (`lib/lockfile.js`), read, mutate, re-read and retry if an editor saved in between, atomic write
  (`lib/atomic.js`). Never write a project file any other way.
- Hand edits are welcome: the watcher reports them as `tree/external` and commits them; it never
  writes back in response.
- `.mainline/` is local and ignored: lock, event log, session id, per-project view state.

## UI style (hard)

- **Monochrome.** Black/white body, greys. Theme tokens only (`--dsw-alias-*`, mixed with
  `color-mix()` where a token is too faint); a hex or `rgb()` literal in `lib/client.js` fails
  `npm run check`. The error token is used only for errors — not even for "delete".
- `todo`: a 3 px bar on the card's left edge. `halt`: dimmed title, dashed border, no shadow.
  `?`: a small outlined question mark. Selected: strong border and lift; the path from the project
  to the selection is drawn in the ink colour. Non-live segments: dashed and faint.
- Lanes side by side, references never on the line, chapters in a faint dashed frame.
- Folding is org-like: `Tab` cycles the selected card folded → open (Markdown body rendered in
  the card) → all; `Shift+Tab` cycles the project overview → contents → all.
- Dragging a card is free placement (a per-node view offset inherited by its subtree), never a
  structural move; `R` restores the relative position, `Shift+R` all. Structure moves are
  cut/paste and the context menu.
- Shell fences (`bash`, `sh`, `pwsh`, …) in a body get **▶ 运行** (Host `shell`, output under the
  fence) and **交给 AI**. The run route takes the command from the stored body, never from the
  request.
- Right column: detail on top, the embedded DSH conversation below — the user approved this
  layout; keep it.
- Chinese for host-side user-facing strings; the client has `zh` and `en` dictionaries.

## Hard constraints

- No dependencies, no build step, no TypeScript, no generated files. Never `import` an
  `@deepseek-ai/*` package: reach Host services with a guarded `ctx.root.get(name)` or
  `ctx.inject([...])`.
- Typed failures: `TreeError` with a code from `ERROR_CODES`; routes map codes to statuses, tools
  return `{ ok: false, reason, error }`.
- Tool schemas stay in the Host subset (`type` is a single string, nullability via `oneOf`);
  `test/schema.test.mjs` guards it — a schema outside it is rejected silently.
- Windows is the primary platform: CJK and spaces in paths, CRLF input, antivirus holding files,
  `fs.watch` quirks, git taking 1–3 s per call.
- Comments explain why, not what. Small functions, plain data.

## Workflow

```sh
npm run verify   # static checks + all tests (~2–3 min, git-heavy)
npm run dev      # the panel at http://localhost:4710/ — real host half, temp tree, fake shell
```

- `package.json` `version` and `VERSION` in `lib/index.js` must match (`npm run check`).
- The client calls routes document-relative (`api/mainline/...`); the host registers them with a
  leading slash.

## Restarting dsh-web (hard)

`dsh-web` is one process: a restart drops every in-flight turn and subagent. **Never restart or
kill it yourself.** Install with `dsh plugin --profile web install`, report, and let the user pick
the moment — "installed; restart dsh-web when you like" is a complete hand-off.
