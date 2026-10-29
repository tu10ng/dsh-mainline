/**
 * Everything the model is told about the tree: the standing guidance, the focus
 * context and the batch of panel actions it hears about.
 *
 * Pure text functions, no I/O: the session decides *when* to say something, this
 * file decides *what*. Titles and bodies are user text, so every consumer passes
 * `interpolate: false` — a title containing `{{x}}` must reach the model verbatim.
 *
 * @module dsh-mainline/prompt
 */

/** The full guide, for the session this plugin owns. */
export const GUIDANCE_FULL = [
  '【工作树】用户把工程工作记在一棵「工作树」里，里面有**很多个项目**，每个项目是一份攻略（walkthrough）：',
  '- **主线**：项目（或某一步）下按顺序排的步骤，就是要沿着走的那条线。',
  '- **分叉（fork）**：主线在这里分成几条**并行的支线（lane）**——两套环境、两个互相竞争的假设——各走各的，走完再合回主线。',
  '- **参考（ref）**：挂在某一步上的命令、代码位置、寄存器值、链接、设计文档。是「查」的，不是「走」的，不算主线。',
  '- **疑问（?）**：一个还没弄清的问题。通常是「要做」状态；在正文里写下答案后改成「不用做」。',
  '状态：记录（none，只是一条记录）/ 要做（todo）/ 不用做（halt）。**halt 的意思是「不用再做了」**——做完了或暂停了，用户有意不区分，别替他区分。',
  '',
  '**每一轮先看「聚焦」上下文**：它说明用户此刻在哪个项目、哪一步。项目之间互不相干：不要把一个项目的上下文带到另一个项目；一句话不知道属于哪个项目时，先问。',
  '',
  '**记在哪儿**：',
  '- 一个结果、结论、命令输出 → 对应步骤的正文，或挂一条参考；',
  '- 一个新冒出来的疑问 → 加一个 `?` 步骤（`question: true`，状态 todo）；',
  '- 两个互相竞争的假设、两套环境 → 用 `mainline_fork` 分叉，不要塞进同一段正文；',
  '- 做完一步 → 把它改成 halt，并在正文里留一句结论。',
  '',
  '**工具**：只用 `mainline_*` 工具读写树，**不要**用文件工具编辑 Markdown 文件（绕过锁会覆盖用户刚做的修改）。',
  '先 `mainline_projects` 看有哪些项目，再 `mainline_read` 看细节（返回里带节点 id）；`project` 参数可以是项目 id、文件名或完整标题。',
  '历史就是 git：`mainline_history` 看改动记录，`mainline_restore` 恢复某个旧版本（恢复本身也是一次新的提交）。',
  '用户在面板上的操作会以「【工作树】用户在面板上的操作」的消息告诉你，那只是知会，不需要回应；只有用户对你说话时才行动。',
  '改完用一两句话汇报改了哪些步骤，不要复述整段正文。',
].join('\n')

/** The short note every other session gets: what exists and which tools reach it. */
export const GUIDANCE_SHORT = [
  '【工作树】用户有一棵跨项目的工程「工作树」（攻略式记录：主线步骤、并行分叉、参考资料、疑问），由 `mainline_*` 工具读写。',
  '只有在用户要你查看或记录工程进展时才用；用 `mainline_projects` 开始，不要用文件工具改它的 Markdown 文件。',
].join('\n')

const BODY_LIMIT = 1500
const LINE_CAP = 40
const STATE_LABELS = { '': '记录', todo: '要做', halt: '不用做' }
const KIND_LABELS = { project: '项目', step: '步骤', fork: '分叉', lane: '支线', ref: '参考' }

/** @param {string} text @param {number} max */
function clip(text, max) {
  const chars = [...String(text ?? '')]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

/** @param {object} node */
const lineOf = (node) => (node?.children ?? []).filter((child) => child.kind !== 'ref')

/** @param {object} node */
const refsOf = (node) => (node?.children ?? []).filter((child) => child.kind === 'ref')

/** @param {object} node */
function describeNode(node) {
  const flags = [STATE_LABELS[node.state ?? ''] ?? '记录']
  if (node.question === true) flags.push('疑问')
  return `${KIND_LABELS[node.kind] ?? node.kind}「${clip(node.title, 80)}」（${flags.join('，')}，id ${node.id}）`
}

/** The project list with counts: what the model sees when nothing is focused. */
function renderProjectList(service) {
  const projects = service.listProjects()
  if (projects.length === 0) return '【工作树】目前没有任何项目。用户没有聚焦到任何位置。'
  const rows = projects.map(
    (p) => `- ${clip(p.title, 60)}（${p.file}，id ${p.id}）：${p.todo} 项要做，${p.halt} 项不用做`,
  )
  return ['【工作树】用户没有聚焦到具体位置。项目：', ...rows].join('\n')
}

/**
 * The "where is the user" context for the session's system prompt.
 *
 * Reads the service at call time, so it always describes the tree as it is now; a
 * focus that no longer resolves (node deleted) falls back to the project list
 * instead of describing something that is gone.
 *
 * @param {{ service: object, focus: { project: string | null, node: string | null } | null }} input
 * @returns {string}
 */
export function renderFocus({ service, focus }) {
  try {
    if (!focus || !focus.project) return renderProjectList(service)
    const project = service.getProject(focus.project)
    const head = [
      '【工作树·聚焦】用户此刻在这里（只处理这个项目的事，别和其他项目混在一起）：',
      `项目：${clip(project.root.title, 80)}（文件 ${project.file}，id ${project.id}）`,
    ]
    if (project.root.attrs?.cwd) head.push(`工作目录：${project.root.attrs.cwd}`)
    const hit = focus.node ? service.locate(focus.project, focus.node) : null
    if (!hit) return [...head, '没有选中具体的步骤。'].join('\n')

    const { node, parent } = hit
    const lines = [...head, `位置：${service.where(focus.project, node.id)}`, `当前：${describeNode(node)}`]
    if (node.body) {
      lines.push(`正文${[...node.body].length > BODY_LIMIT ? `（前 ${BODY_LIMIT} 字）` : ''}：`, clip(node.body, BODY_LIMIT))
    }
    const refs = refsOf(node)
    if (refs.length > 0) lines.push(`参考：${refs.map((r) => clip(r.title, 40)).join('、')}`)
    if (node.kind !== 'ref' && parent) {
      const line = lineOf(parent)
      const at = line.findIndex((item) => item.id === node.id)
      if (at > 0) lines.push(`上一项：${clip(line[at - 1].title, 60)}`)
      if (at >= 0 && at < line.length - 1) lines.push(`下一项：${clip(line[at + 1].title, 60)}`)
    }
    return lines.join('\n')
  } catch {
    // A missing project or a half-loaded service must not break prompt assembly.
    return ''
  }
}

/** @param {number} at epoch ms */
function clock(at) {
  const date = new Date(at)
  const two = (n) => String(n).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/**
 * The notice that tells the model what the user did in the panel.
 *
 * @param {Array<{ at: number, summary: string }>} events - oldest first
 * @param {{ dropped?: number }} [options] - lines already dropped by the cap
 * @returns {string}
 */
export function renderEventBatch(events, options = {}) {
  const dropped = options.dropped ?? 0
  const rows = events.slice(-LINE_CAP).map((e) => `- ${clock(e.at)} ${clip(e.summary, 200)}`)
  const omitted = dropped + Math.max(0, events.length - LINE_CAP)
  if (omitted > 0) rows.unshift(`- （更早的 ${omitted} 条已省略）`)
  return ['【工作树】用户在面板上的操作（较早的在前）：', ...rows].join('\n')
}

/** Batch size cap, shared with the session. */
export const BATCH_CAP = LINE_CAP

/**
 * The hand-off text for "交给 AI".
 *
 * The command comes from the stored card, never from the request: this text is
 * what the model is asked to run, so it carries the same trust as the runner.
 *
 * @param {{ where: string, cwd?: string, command?: string, note?: string }} input
 * @returns {string}
 */
export function renderAsk({ where, cwd, command, note }) {
  const out = []
  if (command) {
    const longest = Math.max(0, ...(command.match(/`+/g) ?? []).map((run) => run.length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    out.push(
      `请在「${where}」这张卡上运行下面这段命令（用你的 shell 工具），把结论记回这张卡（正文或一条参考）。`,
      cwd ? `工作目录：${cwd}` : '',
      fence,
      command,
      fence,
    )
  } else {
    out.push(`请继续推进「${where}」这一步：先用 mainline_read 看清它的正文和参考，做完后把结论记回这一步。`)
  }
  if (note) out.push(`用户补充：${clip(note, 2000)}`)
  return out.filter((line) => line !== '').join('\n')
}
