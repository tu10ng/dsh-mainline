/**
 * Agent tools: twelve `mainline_*` definitions over the same service the panel uses.
 *
 * Failures come back as `{ ok: false, reason, error }` values rather than throws, so
 * a bad id costs the model one line of explanation instead of a turn. Schemas stay in
 * the Host's small subset (see `test/schema.test.mjs`); nullability is `oneOf`.
 *
 * @module dsh-mainline/tools
 */

import { TreeError, asTreeError } from './errors.js'

const text = (value) => [{ type: 'text', text: value }]
const STATES = ['none', 'todo', 'halt']
const KINDS = ['step', 'fork', 'lane', 'ref']

/** Wire state (`none`) to stored state (`''`). */
function toStored(state) {
  if (state === undefined) return undefined
  if (state === 'none' || state === '') return ''
  if (state === 'todo' || state === 'halt') return state
  throw new TreeError('invalid-state', `state 只能是 ${STATES.join(' / ')}`)
}

const toWire = (state) => (state === '' || state === undefined || state === null ? 'none' : state)

/** @param {object} node @returns {number} subtree size, node included */
function countNodes(node) {
  return 1 + (node?.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
}

/**
 * Cut a Markdown dump to `depth` heading levels below its first heading.
 * Fenced code is left alone, so a `# comment` inside a fence never counts as a heading.
 *
 * @param {string} markdown
 * @param {number} depth
 */
export function limitDepth(markdown, depth) {
  const out = []
  let fence = null
  let base = null
  let skipping = false
  for (const line of String(markdown).split('\n')) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (!skipping) out.push(line)
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
      continue
    }
    if (open) {
      fence = open[1]
      if (!skipping) out.push(line)
      continue
    }
    const heading = /^(#+)\s/.exec(line)
    if (heading) {
      const level = heading[1].length
      base ??= level
      skipping = level - base > depth
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/**
 * @param {object} deps
 * @param {object} deps.service
 * @param {object} [deps.runner] - unused today; accepted so index.js can pass one bag
 * @param {object} [deps.session] - unused today (the actor comes from `exec.agent`)
 * @returns {object[]} tool definitions
 */
export function createTools({ service }) {
  const actorOf = (exec) => ({ kind: 'agent', session: exec?.agent?.id })

  /** Resolve a project id, file name or exact title to an id. */
  function projectId(ref) {
    if (typeof ref !== 'string' || ref.trim() === '') throw new TreeError('invalid-request', 'project 不能为空')
    const wanted = ref.trim()
    const all = service.listProjects()
    const byId = all.find((p) => p.id === wanted)
    if (byId) return byId.id
    const lower = wanted.toLowerCase()
    const byFile = all.find((p) => p.file.toLowerCase() === lower || p.file.toLowerCase() === `${lower}.md`)
    if (byFile) return byFile.id
    const byTitle = all.filter((p) => p.title === wanted)
    if (byTitle.length === 1) return byTitle[0].id
    if (byTitle.length > 1) {
      throw new TreeError('invalid-request', `有 ${byTitle.length} 个项目叫「${wanted}」，请改用项目 id：${byTitle.map((p) => p.id).join('、')}`)
    }
    const known = all.map((p) => `${p.title}（${p.id}）`).join('、') || '（还没有项目）'
    throw new TreeError('not-found', `找不到项目「${wanted}」。现有项目：${known}`)
  }

  /** @param {() => Promise<object> | object} fn */
  async function attempt(fn) {
    try {
      return await fn()
    } catch (error) {
      const wrapped = asTreeError(error)
      return { ok: false, reason: wrapped.code, error: wrapped.message }
    }
  }

  const failure = (value) => text(`没有成功：${value.error ?? value.reason ?? '未知原因'}`)
  const resultShape = (properties) => ({
    type: 'object',
    properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, error: { type: 'string' }, ...properties },
    required: ['ok'],
  })

  const PROJECT = { type: 'string', description: '项目 id、文件名或完整标题' }
  const AFTER = { type: 'string', description: '放在哪个同级节点后面；空串 = 放到最前；省略 = 放到最后' }
  const STATE = { type: 'string', enum: STATES, description: 'none 记录 / todo 要做 / halt 不用做（做完或暂停，不区分）' }
  const COMMIT = {
    type: 'object',
    properties: {
      rev: { type: 'string' },
      short: { type: 'string' },
      author: { type: 'string' },
      at: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      message: { type: 'string' },
    },
  }

  /** A mutating tool: same envelope everywhere. */
  const base = (name, description, parameters, extra) => ({
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, ...parameters },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    ...extra,
  })

  return [
    base('mainline_projects', '列出工作树里所有项目（id、文件、标题、要做/不用做/步骤数）。动手前先看这个。', { properties: {} }, {
      isConcurrencySafe: () => true,
      output: {
        schema: resultShape({
          projects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                file: { type: 'string' },
                title: { type: 'string' },
                state: { type: 'string', enum: STATES },
                todo: { type: 'integer' },
                halt: { type: 'integer' },
                steps: { type: 'integer' },
              },
            },
          },
        }),
        render: (_args, value) =>
          value.ok !== true
            ? failure(value)
            : text(
                value.projects.length === 0
                  ? '工作树里还没有项目。'
                  : value.projects.map((p) => `- ${p.title}（id ${p.id}，${p.file}）：${p.todo} 要做 / ${p.halt} 不用做`).join('\n'),
              ),
      },
      async execute() {
        return attempt(() => ({
          ok: true,
          projects: service.listProjects().map((p) => ({ ...p, state: toWire(p.state) })),
        }))
      },
    }),

    base(
      'mainline_read',
      '读一个项目（或其中一个节点的子树），返回文件格式的 Markdown，含节点 id（{#id}）。depth 限制往下读几层。',
      {
        properties: {
          project: PROJECT,
          node: { type: 'string', description: '节点 id；省略 = 整个项目' },
          depth: { type: 'integer', description: '只读到第一个标题往下 depth 层（0 = 只读该节点自己）' },
        },
        required: ['project'],
      },
      {
        isConcurrencySafe: () => true,
        output: {
          schema: resultShape({ where: { type: 'string' }, rev: { type: 'string' }, markdown: { type: 'string' } }),
          render: (_args, value) =>
            value.ok !== true ? failure(value) : text(`${value.where}（版本 ${value.rev}）\n\n${value.markdown}`),
        },
        async execute(args) {
          return attempt(() => {
            const pid = projectId(args?.project)
            const read = service.readMarkdown(pid, args?.node || undefined)
            const markdown = Number.isInteger(args?.depth) && args.depth >= 0 ? limitDepth(read.markdown, args.depth) : read.markdown
            return { ok: true, where: read.where, rev: read.rev, markdown }
          })
        },
      },
    ),

    base(
      'mainline_add',
      '在某个节点下加一个新节点。kind：step 步骤 / fork 分叉 / lane 支线 / ref 参考。parent 省略 = 项目根。疑问用 question: true。',
      {
        properties: {
          project: PROJECT,
          parent: { type: 'string', description: '父节点 id；省略 = 项目根' },
          after: AFTER,
          kind: { type: 'string', enum: KINDS },
          title: { type: 'string', description: '一行标题' },
          state: STATE,
          question: { type: 'boolean', description: '是不是一个疑问' },
          body: { type: 'string', description: 'Markdown 正文' },
        },
        required: ['project', 'kind', 'title'],
      },
      {
        output: {
          schema: resultShape({ id: { type: 'string' }, where: { type: 'string' } }),
          render: (_args, value) => (value.ok !== true ? failure(value) : text(`已添加：${value.where}（id ${value.id}）`)),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            const parent = args.parent || service.getProject(pid).root.id
            const op = { type: 'create', project: pid, parent, kind: args.kind, title: args.title }
            for (const key of ['after', 'question', 'body']) if (args[key] !== undefined) op[key] = args[key]
            if (args.state !== undefined) op.state = toStored(args.state)
            const result = await service.apply(op, actorOf(exec))
            return { ok: true, id: result.nodeId, where: service.where(pid, result.nodeId) }
          })
        },
      },
    ),

    base(
      'mainline_update',
      '改一个节点：标题、状态、疑问、正文。append 在正文末尾追加一段（不覆盖）；cwd 设工作目录（空串清除）。body 和 append 二选一。',
      {
        properties: {
          project: PROJECT,
          id: { type: 'string', description: '节点 id' },
          title: { type: 'string' },
          state: STATE,
          question: { type: 'boolean' },
          body: { type: 'string', description: '整个替换正文' },
          append: { type: 'string', description: '在正文末尾追加一段' },
          cwd: { type: 'string', description: '工作目录（命令从这里运行）；空串 = 清除' },
        },
        required: ['project', 'id'],
      },
      {
        output: {
          schema: resultShape({ where: { type: 'string' } }),
          render: (_args, value) => (value.ok !== true ? failure(value) : text(`已更新：${value.where}`)),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            if (args.body !== undefined && args.append !== undefined) {
              throw new TreeError('invalid-request', 'body 和 append 不能同时给')
            }
            const patch = {}
            for (const key of ['title', 'question', 'body', 'append']) if (args[key] !== undefined) patch[key] = args[key]
            if (args.state !== undefined) patch.state = toStored(args.state)
            // Appending and setting one attribute happen inside the service's locked
            // read-modify-write: reading the node here first would lose an edit the
            // person makes between that read and this write.
            if (args.cwd !== undefined) patch.setAttrs = { cwd: args.cwd === '' ? null : args.cwd }
            if (Object.keys(patch).length === 0) throw new TreeError('invalid-request', '没有给出要改的内容')
            await service.apply({ type: 'update', project: pid, id: args.id, patch }, actorOf(exec))
            return { ok: true, where: service.where(pid, args.id) }
          })
        },
      },
    ),

    base(
      'mainline_move',
      '把一个节点移到另一个父节点下（同一项目内）。after 的含义同 mainline_add。',
      {
        properties: { project: PROJECT, id: { type: 'string' }, parent: { type: 'string', description: '新父节点 id' }, after: AFTER },
        required: ['project', 'id', 'parent'],
      },
      {
        output: {
          schema: resultShape({ where: { type: 'string' } }),
          render: (_args, value) => (value.ok !== true ? failure(value) : text(`已移动：${value.where}`)),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            const op = { type: 'move', project: pid, id: args.id, parent: args.parent }
            if (args.after !== undefined) op.after = args.after
            await service.apply(op, actorOf(exec))
            return { ok: true, where: service.where(pid, args.id) }
          })
        },
      },
    ),

    base(
      'mainline_remove',
      '删除一个节点及其整棵子树。用户没有明确要求时不要删；不想要了就把状态改成 halt。历史在 git 里，可以用 mainline_restore 找回。',
      { properties: { project: PROJECT, id: { type: 'string' } }, required: ['project', 'id'] },
      {
        output: {
          schema: resultShape({
            removed: { type: 'object', properties: { title: { type: 'string' }, count: { type: 'integer' } } },
          }),
          render: (_args, value) =>
            value.ok !== true ? failure(value) : text(`已删除「${value.removed.title}」（共 ${value.removed.count} 个节点）`),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            const result = await service.apply({ type: 'remove', project: pid, id: args.id }, actorOf(exec))
            return { ok: true, removed: { title: result.removed?.title ?? '', count: result.removed ? countNodes(result.removed) : 0 } }
          })
        },
      },
    ),

    base(
      'mainline_fork',
      '在某一步后面分叉：几条并行的支线（至少两条），之后合回主线。用于两套环境、两个互相竞争的假设。',
      {
        properties: {
          project: PROJECT,
          after: { type: 'string', description: '在哪一步（节点 id）之后分叉' },
          lanes: { type: 'array', items: { type: 'string' }, description: '支线名称，至少两个' },
          title: { type: 'string', description: '分叉的标题（可选）' },
        },
        required: ['project', 'after', 'lanes'],
      },
      {
        output: {
          schema: resultShape({
            id: { type: 'string' },
            lanes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
          }),
          render: (_args, value) =>
            value.ok !== true
              ? failure(value)
              : text(`已分叉（id ${value.id}）：${value.lanes.map((l) => `${l.title}（${l.id}）`).join('、')}`),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            const op = { type: 'fork', project: pid, after: args.after, lanes: args.lanes }
            if (args.title !== undefined) op.title = args.title
            const result = await service.apply(op, actorOf(exec))
            const fork = service.locate(pid, result.nodeId)?.node
            const lanes = (fork?.children ?? []).filter((c) => c.kind === 'lane').map((c) => ({ id: c.id, title: c.title }))
            return { ok: true, id: result.nodeId, lanes }
          })
        },
      },
    ),

    base(
      'mainline_branch',
      '另起一条线：在 parent（项目或某一步）下加一个和它现有的线并排的新步骤，而不是接在后面。用于同一个项目里另一件不相干的事。原有的步骤原样放进旁边那条线，不用起名；已经分开的再加一条。',
      {
        properties: {
          project: PROJECT,
          parent: { type: 'string', description: '项目或步骤的 id；省略 = 项目根' },
          title: { type: 'string', description: '新步骤的标题' },
          state: STATE,
          question: { type: 'boolean', description: '是不是一个疑问' },
          body: { type: 'string', description: 'Markdown 正文' },
        },
        required: ['project', 'title'],
      },
      {
        output: {
          schema: resultShape({ id: { type: 'string' }, where: { type: 'string' } }),
          render: (_args, value) => (value.ok !== true ? failure(value) : text(`已另起一条线：${value.where}（id ${value.id}）`)),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            const op = { type: 'branch', project: pid, parent: args.parent || service.getProject(pid).root.id, title: args.title }
            for (const key of ['question', 'body']) if (args[key] !== undefined) op[key] = args[key]
            if (args.state !== undefined) op.state = toStored(args.state)
            const result = await service.apply(op, actorOf(exec))
            return { ok: true, id: result.nodeId, where: service.where(pid, result.nodeId) }
          })
        },
      },
    ),

    base(
      'mainline_write',
      '用文件格式的 Markdown 整段替换一个子树（node）或整个项目（省略 node）。已有的 {#id} 会保留。大改结构时用；小改用 mainline_update。',
      {
        properties: {
          project: PROJECT,
          node: { type: 'string', description: '要替换的节点 id；省略 = 整个项目' },
          markdown: { type: 'string', description: '文件格式的 Markdown' },
        },
        required: ['project', 'markdown'],
      },
      {
        output: {
          schema: resultShape({ rev: { type: 'string' } }),
          render: (_args, value) => (value.ok !== true ? failure(value) : text(`已写入（版本 ${value.rev}）`)),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            const result = await service.writeMarkdown(pid, args.node || null, args.markdown, actorOf(exec))
            return { ok: true, rev: result.project?.rev ?? '' }
          })
        },
      },
    ),

    base(
      'mainline_create_project',
      '新建一个项目。可以只给标题，或用 markdown 给出整份文件（导入）。',
      {
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: '项目说明（Markdown）' },
          markdown: { type: 'string', description: '整份文件的 Markdown（导入用）' },
        },
        required: ['title'],
      },
      {
        output: {
          schema: resultShape({ id: { type: 'string' }, file: { type: 'string' } }),
          render: (_args, value) => (value.ok !== true ? failure(value) : text(`已新建项目（id ${value.id}，${value.file}）`)),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const op = { type: 'createProject', title: args?.title }
            for (const key of ['body', 'markdown']) if (args?.[key] !== undefined) op[key] = args[key]
            const result = await service.apply(op, actorOf(exec))
            return { ok: true, id: result.nodeId, file: service.getProject(result.nodeId).file }
          })
        },
      },
    ),

    base(
      'mainline_history',
      '看改动历史（git 提交）。给 project 看某个项目，省略则看全部。',
      {
        properties: {
          project: { type: 'string', description: '项目 id、文件名或完整标题；省略 = 全部' },
          limit: { type: 'integer', description: '最多几条（默认 20）' },
        },
      },
      {
        isConcurrencySafe: () => true,
        output: {
          schema: resultShape({ commits: { type: 'array', items: COMMIT } }),
          render: (_args, value) =>
            value.ok !== true
              ? failure(value)
              : text(value.commits.length === 0 ? '没有历史记录。' : value.commits.map((c) => `- ${c.short ?? c.rev} ${c.message}`).join('\n')),
        },
        async execute(args) {
          return attempt(async () => {
            const pid = args?.project ? projectId(args.project) : null
            const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20
            const commits = await service.history(pid, limit)
            return { ok: true, commits: commits.map((c) => ({ rev: c.rev, short: c.short, author: c.author, at: c.at, message: c.message })) }
          })
        },
      },
    ),

    base(
      'mainline_restore',
      '把一个项目恢复到某个历史版本（rev 来自 mainline_history）。恢复本身是一次新的提交，不会改写历史。',
      { properties: { project: PROJECT, rev: { type: 'string', description: '提交 id' } }, required: ['project', 'rev'] },
      {
        output: {
          schema: resultShape({ rev: { type: 'string' } }),
          render: (_args, value) => (value.ok !== true ? failure(value) : text(`已恢复（版本 ${value.rev}）`)),
        },
        async execute(args, exec) {
          return attempt(async () => {
            const pid = projectId(args?.project)
            const result = await service.apply({ type: 'restore', project: pid, rev: args.rev }, actorOf(exec))
            return { ok: true, rev: result.project?.rev ?? '' }
          })
        },
      },
    ),
  ]
}
