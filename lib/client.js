/**
 * dsh-mainline — the panel (browser half).
 *
 * A classic script, not a module: `exports["./client"]` points here and the Host's
 * `window.__ModuleLoader__` picks the factory up. Constraints this file keeps on purpose:
 *
 *  - only `react` is required; nothing is imported from another Host client package;
 *  - colours come from `--dsw-alias-*` tokens (and mixes of them) only — the look is
 *    monochrome, and a hex or rgb colour literal anywhere in this file fails the tests;
 *  - the factory body has no side effects: everything is registered in `apply` with a
 *    disposer, and the panel renders inside its own error boundary;
 *  - every route is called with a **document-relative** path (`api/mainline/...`): the
 *    GUI serves the app under `<base href="./">`, and a root-absolute fetch would escape
 *    a sub-path deployment.
 *
 * The pure parts (Markdown parser, layout, folding) take plain data and are exposed on
 * the returned plugin object as `__test`, so they are tested without a DOM.
 *
 * @module dsh-mainline/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-mainline',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React
    // A layout effect is what lets a measured size correct the layout before the first
    // paint; a stand-in React without one still gets a (one-frame-late) correct picture.
    const useLayoutEffectSafe = React.useLayoutEffect || React.useEffect

    /** The sidebar entry id and the main panel key must match: that is the shell's link. */
    const SLOT_ID = 'mainline'
    /**
     * The embedded conversation's child slot. Declaring it session-scoped on the main
     * registration is what mints the SessionProvider / renderSlot standard props, and
     * what creates the spec this name's own registration waits for.
     */
    const CHAT_SLOT = 'mainline.chat.conversation'
    const LOCALE_NS = 'mainline'
    const API = 'api/mainline'
    const UI_REV = 'm1'
    const DRAFT_ID = '__draft__'
    const UNDO_MS = 8000
    const FOCUS_DEBOUNCE_MS = 300
    const VIEW_DEBOUNCE_MS = 600
    const REFETCH_DEBOUNCE_MS = 150
    const POLL_MS = 15000
    const RUN_POLL_MS = 1500
    const SIDE_KEY = 'dsh-mainline:side-width'
    const DETAIL_KEY = 'dsh-mainline:detail-height'
    const OPEN_KEY = 'dsh-mainline:open-project'
    const SIDE_DEFAULT = 400
    const SIDE_MIN = 300
    const DETAIL_MIN = 120
    const CHAT_MIN = 160
    const ZOOM_MIN = 0.3
    const ZOOM_MAX = 1.6
    /** An open card's body scrolls past this; its editor grows to the same height. */
    const CARD_BODY_MAX = 560
    /** Last language resolved; module-level so a fetch failure can be worded too. */
    let activeLang = 'zh'

    // ------------------------------------------------------------------ 文案

    const zh = {
      'entry.label': '工作树',
      'tabs.new': '新项目',
      'tabs.newPlaceholder': '项目标题，回车创建',
      'tabs.label': '项目',
      'bar.history': '历史',
      'bar.home': '回到焦点',
      'bar.fit': '适应窗口',
      'bar.view.overview': '总览',
      'bar.view.contents': '目录',
      'bar.view.all': '全部',
      'bar.view.mixed': '自定',
      'bar.view.title': '切换 总览 → 目录 → 全部（Shift+Tab）',
      'bar.zoomReset': '缩放到 100%',
      keys:
        '点卡片 选中（AI 会知道） · 双击标题 改名 · 双击正文 编辑 · 右键 菜单 · Tab 折叠/展开 · Shift+Tab 总览/目录/全部 · 拖卡片 自由摆放 · R 复位（Shift+R 全部） · ↑↓ 上一步/下一步 · ←→ 换支线 · Alt+↑↓ 调序 · Alt+→ 变成子步骤 · Alt+← 提到上一级 · Ctrl+Enter 加下一步 · Del 删除 · F 适应窗口',
      loading: '加载中…',
      'empty.projects': '还没有项目。新建一个，把主线写下来。',
      'error.load': '加载失败：{message}',
      'error.notJson': '宿主返回了非 JSON（HTTP {status}）',
      'error.network': '连不上宿主：{message}',
      'action.retry': '重试',
      'card.untitled': '（无标题）',
      'card.todo': '要做 {n}',
      'card.steps': '{n} 步',
      'card.refsTitle': '{n} 条参考：{titles}',
      'card.chapterShow': '展开这一章',
      'card.chapterHide': '收起这一章',
      'card.new': '新的一步',
      'lane.untitled': '（支线）',
      'lane.unnamed': '支线（未命名，双击起名）',
      'lane.hidden': '{n} 步已折叠',
      'fork.untitled': '分叉',
      'state.none': '记录',
      'state.todo': '要做',
      'state.halt': '不用做',
      'state.label': '状态',
      'question.on': '标为疑问',
      'question.off': '取消疑问',
      'question.toggle': '疑问',
      'menu.label': '操作',
      'menu.addNext': '加下一步',
      'menu.addChild': '加子步骤',
      'menu.fork': '从这里分叉…',
      'menu.addRef': '加参考',
      'menu.ask': '交给 AI 继续',
      'menu.cut': '剪切',
      'menu.pasteNext': '粘贴为下一步',
      'menu.pasteChild': '粘贴为子步骤',
      'menu.resetPos': '恢复位置',
      'menu.remove': '删除',
      'menu.rename': '改名',
      'menu.addLane': '加一条支线',
      'menu.removeLane': '删除这条支线',
      'menu.laneStep': '在支线末尾加一步',
      'menu.removeFork': '删除整个分叉',
      'menu.appendMain': '在项目末尾加一步',
      'menu.foldAll': '全部折叠',
      'menu.unfoldAll': '全部展开',
      'menu.fit': '适应窗口',
      'menu.resetAll': '全部恢复位置',
      'fork.title': '从这里分叉',
      'fork.lanes': '支线，用逗号隔开',
      'fork.lanesPlaceholder': '方案 A，方案 B',
      'fork.hypotheses': '猜想 A，猜想 B',
      'fork.name': '分叉名（可选）',
      'fork.submit': '分叉',
      'fork.needTwo': '至少写两条支线',
      'menu.branch': '另起一条线',
      'menu.branchLane': '在这条支线里再分',
      'common.cancel': '取消',
      'common.save': '保存',
      'common.confirm': '确定',
      'detail.none': '没有选中：AI 只知道你在看「{project}」。点一张卡片，或',
      'detail.selectProject': '看项目本身',
      'detail.edit': '编辑',
      'detail.editHint': 'Ctrl+Enter 保存 · Esc 取消 · 失焦即保存',
      'detail.emptyBody': '还没有正文。点「编辑」写下结论、现象、命令……',
      'detail.refs': '参考',
      'detail.refsNone': '还没有',
      'detail.addRef': '加参考',
      'detail.refPlaceholder': '参考的标题（命令、链接、代码位置……），回车添加',
      'detail.cwd': '工作目录',
      'detail.cwdPlaceholder': '卡片上的命令在哪里跑（空 = 会话目录）',
      'detail.removeProject': '删除项目',
      'detail.removeProjectConfirm': '确认删除（git 里还留着）',
      'detail.ask': '交给 AI',
      'detail.rename': '双击改名',
      'detail.path': '位置',
      'detail.stepNo': '（第 {n} 步）',
      'detail.isRef': '（参考）',
      'ref.toggle': '展开或收起',
      'ref.rename': '改名',
      'ref.edit': '编辑',
      'ref.add': '加子参考',
      'ref.remove': '删除',
      'ref.empty': '（空）',
      'run.run': '运行',
      'run.stop': '停止',
      'run.ask': '交给 AI',
      'run.running': '运行中…',
      'run.exit': '退出码 {code}',
      'run.timeout': '超时',
      'run.aborted': '已取消',
      'run.failed': '失败',
      'run.collapse': '收起输出',
      'run.expand': '展开输出',
      'run.stderr': 'stderr',
      'run.noOutput': '（没有输出）',
      'run.truncated': '（只保留了末尾）',
      'chat.title': 'DSH 会话',
      'chat.openInApp': '在主界面打开',
      'chat.reset': '新开会话',
      'chat.resetConfirm': '确定新开？旧会话留在侧边栏',
      'chat.fallback': '这里嵌入的是宿主自己的 DSH 会话（同一个会话也在侧边栏里）。当前宿主没有提供可嵌入的会话视图。',
      'chat.unavailable': '会话不可用：{message}',
      'chat.loading': '正在连接会话…',
      'chat.opened': '已在主界面打开会话',
      'toast.removed': '已删除「{title}」',
      'toast.undo': '撤销',
      'toast.cut': '已剪切「{title}」：选中目标后 Ctrl+V 放到它后面，Ctrl+Shift+V 放进去',
      'toast.pasteNothing': '先用 Ctrl+X 剪切一项',
      'toast.indent.first': '前面没有步骤，没法变成子步骤',
      'toast.indent.top': '已经在主线上，没有更上一级了',
      'toast.indent.kind': '只有步骤和分叉能升降级',
      'toast.asked': '已交给 AI，在会话里继续',
      'toast.mode.overview': '总览：只看主线',
      'toast.mode.contents': '目录：每条线都展开，正文收起',
      'toast.mode.all': '全部展开',
      'toast.dismiss': '关闭',
      'history.title': '历史',
      'history.empty': '还没有提交',
      'history.restore': '恢复到这里',
      'history.restoreConfirm': '确认恢复',
      'history.unavailable': '历史不可用：{message}',
      'history.restored': '已恢复到 {rev}',
      'canvas.label': '主线画布',
      'canvas.selected': '已选中：{where}',
      'canvas.empty': '这个项目还没有步骤。右键空白处，或选中项目卡片按 Ctrl+Enter。',
      'boundary.error': '面板出错了：{message}',
      'split.side': '拖动调整右栏宽度',
      'split.detail': '拖动调整详情与会话的高度',
      'reason.store-busy': '另一个写入正在进行，稍后再试',
      'reason.not-found': '找不到这一项（可能刚被改过）',
      'reason.invalid-move': '不能这样移动',
      'reason.invalid-kind': '这里不能放这种条目',
      'reason.invalid-title': '标题不能为空，也不能超过 300 字',
    }

    const en = {
      'entry.label': 'Walkthroughs',
      'tabs.new': 'New project',
      'tabs.newPlaceholder': 'Project title, Enter to create',
      'tabs.label': 'Projects',
      'bar.history': 'History',
      'bar.home': 'Back to focus',
      'bar.fit': 'Fit',
      'bar.view.overview': 'Overview',
      'bar.view.contents': 'Contents',
      'bar.view.all': 'All',
      'bar.view.mixed': 'Custom',
      'bar.view.title': 'Switch overview → contents → all (Shift+Tab)',
      'bar.zoomReset': 'Zoom to 100%',
      keys:
        'Click a card to select (the AI sees it) · Double-click a title to rename, an open body to edit · Right-click for actions · Tab fold · Shift+Tab overview/contents/all · Drag cards freely · R reset (Shift+R all) · ↑↓ prev/next · ←→ switch lane · Alt+↑↓ reorder · Alt+→ into the step above · Alt+← up a level · Ctrl+Enter next step · Del delete · F fit',
      loading: 'Loading…',
      'empty.projects': 'No projects yet. Create one and write its main line down.',
      'error.load': 'Could not load: {message}',
      'error.notJson': 'The host answered with non-JSON (HTTP {status})',
      'error.network': 'Cannot reach the host: {message}',
      'action.retry': 'Retry',
      'card.untitled': '(untitled)',
      'card.todo': '{n} to do',
      'card.steps': '{n} steps',
      'card.refsTitle': '{n} references: {titles}',
      'card.chapterShow': 'Show this chapter',
      'card.chapterHide': 'Hide this chapter',
      'card.new': 'New step',
      'lane.untitled': '(lane)',
      'lane.unnamed': 'Lane (unnamed, double-click to name)',
      'lane.hidden': '{n} steps folded',
      'fork.untitled': 'Fork',
      'state.none': 'Record',
      'state.todo': 'To do',
      'state.halt': 'Not to do',
      'state.label': 'State',
      'question.on': 'Mark as a doubt',
      'question.off': 'Clear the doubt',
      'question.toggle': 'Doubt',
      'menu.label': 'Actions',
      'menu.addNext': 'Add next step',
      'menu.addChild': 'Add sub-step',
      'menu.fork': 'Fork from here…',
      'menu.addRef': 'Add reference',
      'menu.ask': 'Hand to the AI',
      'menu.cut': 'Cut',
      'menu.pasteNext': 'Paste as next step',
      'menu.pasteChild': 'Paste as sub-step',
      'menu.resetPos': 'Reset position',
      'menu.remove': 'Delete',
      'menu.rename': 'Rename',
      'menu.addLane': 'Add a lane',
      'menu.removeLane': 'Delete this lane',
      'menu.laneStep': 'Add a step at the end of the lane',
      'menu.removeFork': 'Delete the whole fork',
      'menu.appendMain': 'Add a step at the end of the project',
      'menu.foldAll': 'Fold everything',
      'menu.unfoldAll': 'Unfold everything',
      'menu.fit': 'Fit',
      'menu.resetAll': 'Reset all positions',
      'fork.title': 'Fork from here',
      'fork.lanes': 'Lanes, comma separated',
      'fork.lanesPlaceholder': 'Plan A, Plan B',
      'fork.hypotheses': 'Hypothesis A, Hypothesis B',
      'fork.name': 'Fork name (optional)',
      'fork.submit': 'Fork',
      'fork.needTwo': 'Write at least two lanes',
      'menu.branch': 'Start a line beside',
      'menu.branchLane': 'Split inside this lane',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.confirm': 'Confirm',
      'detail.none': 'Nothing selected: the AI only knows you are looking at “{project}”. Click a card, or',
      'detail.selectProject': 'look at the project itself',
      'detail.edit': 'Edit',
      'detail.editHint': 'Ctrl+Enter saves · Esc cancels · leaving saves',
      'detail.emptyBody': 'No body yet. Click Edit to write down findings, symptoms, commands…',
      'detail.refs': 'References',
      'detail.refsNone': 'none yet',
      'detail.addRef': 'Add reference',
      'detail.refPlaceholder': 'Reference title (command, link, code location…), Enter to add',
      'detail.cwd': 'Working directory',
      'detail.cwdPlaceholder': 'Where commands on its cards run (empty = the session directory)',
      'detail.removeProject': 'Delete project',
      'detail.removeProjectConfirm': 'Confirm (git keeps it)',
      'detail.ask': 'Hand to the AI',
      'detail.rename': 'Double-click to rename',
      'detail.path': 'Path',
      'detail.stepNo': ' (step {n})',
      'detail.isRef': ' (reference)',
      'ref.toggle': 'Expand or collapse',
      'ref.rename': 'Rename',
      'ref.edit': 'Edit',
      'ref.add': 'Add a sub-reference',
      'ref.remove': 'Delete',
      'ref.empty': '(empty)',
      'run.run': 'Run',
      'run.stop': 'Stop',
      'run.ask': 'Hand to the AI',
      'run.running': 'Running…',
      'run.exit': 'exit {code}',
      'run.timeout': 'timed out',
      'run.aborted': 'cancelled',
      'run.failed': 'failed',
      'run.collapse': 'Collapse output',
      'run.expand': 'Expand output',
      'run.stderr': 'stderr',
      'run.noOutput': '(no output)',
      'run.truncated': '(only the tail was kept)',
      'chat.title': 'DSH conversation',
      'chat.openInApp': 'Open in the main view',
      'chat.reset': 'New conversation',
      'chat.resetConfirm': 'Start a new one? The old one stays in the sidebar',
      'chat.fallback': 'This is where the Host embeds its own DSH conversation (the same one is in the sidebar). This Host offers no embeddable conversation view.',
      'chat.unavailable': 'Conversation unavailable: {message}',
      'chat.loading': 'Connecting the conversation…',
      'chat.opened': 'Opened the conversation in the main view',
      'toast.removed': 'Deleted “{title}”',
      'toast.undo': 'Undo',
      'toast.cut': 'Cut “{title}”: select a target, Ctrl+V puts it after, Ctrl+Shift+V puts it inside',
      'toast.pasteNothing': 'Cut something first (Ctrl+X)',
      'toast.indent.first': 'No step before this one to go under',
      'toast.indent.top': 'Already on the main line',
      'toast.indent.kind': 'Only steps and forks move in or out a level',
      'toast.asked': 'Handed to the AI — continue in the conversation',
      'toast.mode.overview': 'Overview: the main line only',
      'toast.mode.contents': 'Contents: every line, bodies folded',
      'toast.mode.all': 'Everything unfolded',
      'toast.dismiss': 'Dismiss',
      'history.title': 'History',
      'history.empty': 'No commits yet',
      'history.restore': 'Restore this',
      'history.restoreConfirm': 'Confirm restore',
      'history.unavailable': 'History unavailable: {message}',
      'history.restored': 'Restored {rev}',
      'canvas.label': 'Walkthrough canvas',
      'canvas.selected': 'Selected: {where}',
      'canvas.empty': 'No steps yet. Right-click empty space, or select the project card and press Ctrl+Enter.',
      'boundary.error': 'The panel crashed: {message}',
      'split.side': 'Drag to resize the right column',
      'split.detail': 'Drag to resize detail and conversation',
      'reason.store-busy': 'Another write is in progress, try again in a moment',
      'reason.not-found': 'That item is gone (it may have just changed)',
      'reason.invalid-move': 'It cannot move there',
      'reason.invalid-kind': 'That kind of item cannot go here',
      'reason.invalid-title': 'A title must be 1–300 characters',
    }

    const DICTS = { zh, en }

    function translate(lang, key, params) {
      let out = DICTS[lang]?.[key] ?? DICTS.zh[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) out = out.split(`{${name}}`).join(String(value))
      return out
    }

    /**
     * The locale snapshot shape is the Host's business; an unrecognised value falls back
     * instead of throwing (LocaleSnapshot is `{ active, locales, revision }` today).
     */
    function resolveLang(ctx) {
      try {
        const snapshot = ctx.locale?.getLocale?.() ?? ctx.locale?.getSnapshot?.()
        const raw = snapshot?.active ?? snapshot?.locale ?? snapshot?.id ?? snapshot?.language ?? snapshot?.current ?? ''
        const text = typeof raw === 'string' ? raw.toLowerCase() : ''
        if (text.startsWith('zh')) return 'zh'
        if (text.startsWith('en')) return 'en'
      } catch {
        /* fall through */
      }
      return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '') ? 'zh' : 'en'
    }

    // ------------------------------------------------------------------ tree (pure)

    const childrenOf = (node) => (Array.isArray(node?.children) ? node.children : [])
    const refsOf = (node) => childrenOf(node).filter((child) => child.kind === 'ref')
    const lineOf = (node) => childrenOf(node).filter((child) => child.kind !== 'ref')
    const clip = (text, max) => {
      const value = String(text ?? '')
      return value.length > max ? `${value.slice(0, max - 1)}…` : value
    }
    const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

    /**
     * Live = a todo step, or anything that contains one outside a halt step. The project's
     * own state is about its tab, not about which of its lines are still being walked.
     */
    function isLive(node) {
      if (!node || node.kind === 'ref') return false
      if (node.kind === 'step') {
        if (node.state === 'halt') return false
        if (node.state === 'todo') return true
      }
      return lineOf(node).some(isLive)
    }

    function countTodo(node) {
      let total = 0
      for (const child of lineOf(node)) total += (child.kind === 'step' && child.state === 'todo' ? 1 : 0) + countTodo(child)
      return total
    }

    /** id → { node, parent, path } where path is the ancestors, root first. */
    function indexTree(root) {
      const map = new Map()
      const visit = (node, parent, path) => {
        map.set(node.id, { node, parent, path })
        const next = path.concat([node])
        for (const child of childrenOf(node)) visit(child, node, next)
      }
      if (root) visit(root, null, [])
      return map
    }

    /**
     * A short tab label. Project titles carry ticket prefixes ("NAS 迁移到 ZFS…");
     * the tab shows what follows the prefix, up to the first bracketed qualifier.
     */
    function shortTitle(title) {
      let text = String(title ?? '').trim()
      const stripped = text.replace(/^[(（][^)）]{0,24}[)）]\s*/, '')
      if (stripped.length >= 2) text = stripped
      const cut = text.search(/[【[]/)
      if (cut >= 4) text = text.slice(0, cut)
      return clip(text.trim(), 18)
    }

    /** The ids the `branch` preview invents; never written, gone when the draft is. */
    const DRAFT_FORK = '__draft_fork__'
    const DRAFT_LANE = '__draft_lane__'

    /**
     * Where a `branch` step lands, the same way lib/service.js puts it: one more lane of a line
     * that is nothing but one split, else a split of the line (its items in the first lane);
     * into an empty line it is simply the first step.
     */
    function branchInto(parent, node) {
      const bare = (id, kind, children) => ({ id, kind, title: '', state: '', question: false, body: '', attrs: {}, children })
      const refs = refsOf(parent)
      const line = lineOf(parent)
      const lane = bare(DRAFT_LANE, 'lane', [node])
      if (line.length === 0) return { ...parent, children: [...refs, node] }
      if (line.length === 1 && line[0].kind === 'fork') return { ...parent, children: [...refs, { ...line[0], children: [...childrenOf(line[0]), lane] }] }
      return { ...parent, children: [...refs, bare(DRAFT_FORK, 'fork', [bare(`${DRAFT_LANE}0`, 'lane', line), lane])] }
    }

    /** The draft card a new step is typed into; it exists only here until it has a title. */
    function withDraft(root, draft) {
      if (!root || !draft) return root
      const node = { id: DRAFT_ID, kind: draft.kind, title: draft.title ?? '', state: '', question: false, body: '', attrs: {}, children: [] }
      const visit = (current) => {
        if (current.id === draft.parent && draft.branch) return branchInto(current, node)
        if (current.id === draft.parent) {
          const kids = childrenOf(current).slice()
          let at = kids.length
          if (draft.after === '') at = 0
          else if (typeof draft.after === 'string') {
            const found = kids.findIndex((child) => child.id === draft.after)
            if (found !== -1) at = found + 1
          }
          kids.splice(at, 0, node)
          return { ...current, children: kids }
        }
        let changed = false
        const kids = childrenOf(current).map((child) => {
          const next = visit(child)
          if (next !== child) changed = true
          return next
        })
        return changed ? { ...current, children: kids } : current
      }
      return visit(root)
    }

    // ------------------------------------------------------------------ Markdown (pure)

    /** Fences whose first info word is one of these get ▶ 运行 / 交给 AI (SPEC 4.2). */
    const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'console', 'pwsh', 'powershell', 'ps1', 'cmd', 'bat']
    const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
    const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
    const BLANK = /^\s*$/
    const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
    const QUOTE = /^ {0,3}> ?/
    const LIST = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/
    const SAFE_HREF = /^(https?:\/\/|mailto:)/i
    const ALNUM = /[\p{L}\p{N}]/u

    const splitLines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    const langOf = (info) => (/^\S*/.exec(info)?.[0] ?? '').toLowerCase()

    function openFence(text) {
      const match = FENCE_OPEN.exec(text)
      // A backtick fence's info string may not hold a backtick: that line is inline code (as in runner.js).
      if (match === null || (match[1][0] === '`' && match[2].includes('`'))) return null
      return { char: match[1][0], len: match[1].length, info: match[2].trim() }
    }

    /**
     * The closing line of a fence opened at `from`, or -1. Same rule as the file format:
     * the same character, at least as many, nothing but whitespace after — and a fence that
     * never closes is plain text, so it cannot swallow the rest of the body.
     */
    function findClose(texts, from, open) {
      const closer = new RegExp(`^ {0,3}${open.char === '`' ? '`' : '~'}{${open.len},}\\s*$`)
      for (let index = from + 1; index < texts.length; index += 1) if (closer.test(texts[index])) return index
      return -1
    }

    /**
     * Every closed fence of a body, in order: `{ line, lastLine, start, end, info, lang, code }`.
     * `line` / `lastLine` are line numbers; `start` / `end` are character offsets of the opening
     * line and of the end of the closing line, as runner.js reports them.
     */
    function scanFences(body) {
      const texts = splitLines(body)
      const offsets = []
      let at = 0
      for (const text of texts) {
        offsets.push(at)
        at += text.length + 1
      }
      const out = []
      for (let index = 0; index < texts.length; index += 1) {
        const open = openFence(texts[index])
        if (open === null) continue
        const close = findClose(texts, index, open)
        if (close === -1) continue
        out.push({
          line: index,
          lastLine: close,
          start: offsets[index],
          end: offsets[close] + texts[close].length,
          info: open.info,
          lang: langOf(open.info),
          code: texts.slice(index + 1, close).join('\n'),
        })
        index = close
      }
      return out
    }

    /**
     * The runnable fences, numbered the way `POST run { index }` names them: `index` counts
     * shell fences only, in body order — the same shape as the host's runner.js extractFences.
     */
    function extractFences(body) {
      return scanFences(body)
        .filter((fence) => SHELL_LANGS.includes(fence.lang))
        .map((fence, index) => ({ index, lang: fence.lang, code: fence.code, start: fence.start, end: fence.end, line: fence.line }))
    }

    function indentOf(text) {
      let width = 0
      for (const char of /^[ \t]*/.exec(text)[0]) width += char === '\t' ? 4 - (width % 4) : 1
      return width
    }

    function dedent(text, width) {
      let seen = 0
      let index = 0
      while (index < text.length && seen < width && (text[index] === ' ' || text[index] === '\t')) {
        seen += text[index] === '\t' ? 4 - (seen % 4) : 1
        index += 1
      }
      return text.slice(index)
    }

    function listMarker(text) {
      const match = LIST.exec(text)
      if (match === null) return null
      const ordered = /\d/.test(match[2])
      const rest = text.slice(match[0].length)
      const spaces = Math.min(match[3].length, 4) || 1
      return {
        ordered,
        start: ordered ? parseInt(match[2], 10) : null,
        delim: ordered ? match[2].slice(-1) : match[2],
        width: match[1].length + match[2].length + (rest === '' ? 1 : spaces),
        rest,
      }
    }

    function splitRow(text) {
      let row = text.trim()
      if (row.startsWith('|')) row = row.slice(1)
      if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
      const cells = []
      let current = ''
      for (let index = 0; index < row.length; index += 1) {
        const char = row[index]
        if (char === '\\' && row[index + 1] === '|') {
          current += '\\|'
          index += 1
        } else if (char === '|') {
          cells.push(current.trim())
          current = ''
        } else current += char
      }
      cells.push(current.trim())
      return cells
    }

    function delimiterRow(text) {
      if (!text.includes('|')) return null
      const cells = splitRow(text)
      if (cells.length === 0 || !cells.every((cell) => /^:?-+:?$/.test(cell))) return null
      return cells.map((cell) =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null,
      )
    }

    function tableAt(lines, at) {
      if (at + 1 >= lines.length || !lines[at].t.includes('|')) return null
      const align = delimiterRow(lines[at + 1].t)
      if (align === null) return null
      const header = splitRow(lines[at].t)
      if (header.length !== align.length) return null
      const rows = []
      let index = at + 2
      while (
        index < lines.length &&
        !BLANK.test(lines[index].t) &&
        lines[index].t.includes('|') &&
        !QUOTE.test(lines[index].t) &&
        openFence(lines[index].t) === null
      ) {
        const cells = splitRow(lines[index].t)
        rows.push(header.map((_, column) => parseInline(cells[column] ?? '')))
        index += 1
      }
      return { block: { type: 'table', align, header: header.map((cell) => parseInline(cell)), rows }, next: index }
    }

    function startsBlock(lines, at, texts) {
      const text = lines[at].t
      const open = openFence(text)
      if (open !== null && findClose(texts, at, open) !== -1) return true
      return HR.test(text) || QUOTE.test(text) || listMarker(text) !== null || tableAt(lines, at) !== null
    }

    function parseList(lines, at, runs) {
      const first = listMarker(lines[at].t)
      const texts = lines.map((line) => line.t)
      const items = []
      let index = at
      while (index < lines.length) {
        const marker = listMarker(lines[index].t)
        if (marker === null || marker.ordered !== first.ordered || marker.delim !== first.delim) break
        const line = lines[index].n
        const content = [{ t: marker.rest, n: lines[index].n }]
        index += 1
        let lastBlank = false
        while (index < lines.length) {
          const text = lines[index].t
          if (BLANK.test(text)) {
            content.push({ t: '', n: lines[index].n })
            lastBlank = true
          } else if (indentOf(text) >= marker.width) {
            content.push({ t: dedent(text, marker.width), n: lines[index].n })
            lastBlank = false
          } else if (!lastBlank && openFence(content[content.length - 1].t) === null && !startsBlock(lines, index, texts)) {
            // A lazy continuation line: plain text right under an item belongs to it.
            content.push({ t: text, n: lines[index].n })
          } else break
          index += 1
        }
        while (content.length > 1 && BLANK.test(content[content.length - 1].t)) content.pop()
        const task = /^\[([ xX])\](?=\s|$)[ \t]?/.exec(content[0].t)
        if (task !== null) content[0] = { t: content[0].t.slice(task[0].length), n: content[0].n }
        items.push({ checked: task === null ? null : task[1] !== ' ', line, blocks: parseBlocks(content, runs) })
      }
      return { block: { type: 'list', ordered: first.ordered, start: first.start, items }, next: index }
    }

    /** `lines` carry their original line numbers, so a nested fence still finds its run index. */
    function parseBlocks(lines, runs) {
      const texts = lines.map((line) => line.t)
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const text = lines[index].t
        if (BLANK.test(text)) {
          index += 1
          continue
        }
        const open = openFence(text)
        if (open !== null) {
          const close = findClose(texts, index, open)
          if (close !== -1) {
            const line = lines[index].n
            blocks.push({
              type: 'code',
              lang: langOf(open.info),
              info: open.info,
              code: texts.slice(index + 1, close).join('\n'),
              line,
              run: runs.has(line) ? runs.get(line) : null,
            })
            index = close + 1
            continue
          }
        }
        if (HR.test(text)) {
          blocks.push({ type: 'hr' })
          index += 1
          continue
        }
        if (QUOTE.test(text)) {
          const inner = []
          while (index < lines.length && QUOTE.test(lines[index].t)) {
            inner.push({ t: lines[index].t.replace(QUOTE, ''), n: lines[index].n })
            index += 1
          }
          blocks.push({ type: 'quote', blocks: parseBlocks(inner, runs) })
          continue
        }
        if (listMarker(text) !== null) {
          const list = parseList(lines, index, runs)
          blocks.push(list.block)
          index = list.next
          continue
        }
        const table = tableAt(lines, index)
        if (table !== null) {
          blocks.push(table.block)
          index = table.next
          continue
        }
        // Bodies are ATX-less: headings are tree nodes, so a `#` line is just text here.
        const paragraph = [text.trim()]
        index += 1
        while (index < lines.length && !BLANK.test(lines[index].t) && !startsBlock(lines, index, texts)) {
          paragraph.push(lines[index].t.trim())
          index += 1
        }
        blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) })
      }
      return blocks
    }

    /**
     * Parse a body into blocks: paragraph / code / quote / list / table / hr.
     * Code blocks carry `run`: their shell-fence index, or null when not runnable.
     */
    function parseMarkdown(text) {
      const runs = new Map(extractFences(text).map((fence) => [fence.line, fence.index]))
      return parseBlocks(splitLines(text).map((t, n) => ({ t, n })), runs)
    }

    const runLength = (src, at, char) => {
      let length = 0
      while (src[at + length] === char) length += 1
      return length
    }

    function codeSpan(src, at) {
      const run = runLength(src, at, '`')
      let from = at + run
      while (from < src.length) {
        const next = src.indexOf('`', from)
        if (next === -1) return null
        const length = runLength(src, next, '`')
        if (length === run) {
          let text = src.slice(at + run, next).replace(/\n/g, ' ')
          if (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') text = text.slice(1, -1)
          return { node: { type: 'code', text }, end: next + length }
        }
        from = next + length
      }
      return null
    }

    function linkNode(href, children) {
      const target = String(href ?? '').trim()
      return { type: 'link', href: SAFE_HREF.test(target) ? target : null, raw: target, children }
    }

    function linkAt(src, at) {
      let depth = 0
      let close = at
      for (; close < src.length; close += 1) {
        const char = src[close]
        if (char === '\\') {
          close += 1
          continue
        }
        if (char === '`') {
          const span = codeSpan(src, close)
          if (span !== null) {
            close = span.end - 1
            continue
          }
        }
        if (char === '[') depth += 1
        else if (char === ']') {
          depth -= 1
          if (depth === 0) break
        }
      }
      if (close >= src.length || src[close + 1] !== '(') return null
      let end = close + 2
      let parens = 1
      for (; end < src.length; end += 1) {
        const char = src[end]
        if (char === '\\') {
          end += 1
          continue
        }
        if (char === '\n') return null
        if (char === '(') parens += 1
        else if (char === ')') {
          parens -= 1
          if (parens === 0) break
        }
      }
      if (end >= src.length) return null
      const inside = src.slice(close + 2, end).trim()
      const match = /^<([^>]*)>|^(\S*)/.exec(inside)
      return { node: linkNode(match[1] ?? match[2] ?? '', parseInline(src.slice(at + 1, close))), end: end + 1 }
    }

    function bareUrl(src, at) {
      // Printable ASCII minus `<` `>`: a CJK character or space ends a bare URL.
      const match = /^https?:\/\/[!-;=?-~]+/i.exec(src.slice(at))
      if (match === null) return null
      let url = match[0]
      const count = (char) => url.split(char).length - 1
      // Trailing punctuation belongs to the sentence, not to the link.
      while (url.length > 0) {
        const last = url[url.length - 1]
        if ('.,;:!?\'"*_~'.includes(last) || (last === ')' && count('(') < count(')'))) url = url.slice(0, -1)
        else break
      }
      return /^https?:\/\/[^/]/i.test(url) ? url : null
    }

    function findCloser(src, from, char, size) {
      for (let index = from; index < src.length; index += 1) {
        const current = src[index]
        if (current === '\\') {
          index += 1
          continue
        }
        if (current === '`') {
          const span = codeSpan(src, index)
          if (span !== null) {
            index = span.end - 1
            continue
          }
        }
        if (current !== char) continue
        const run = runLength(src, index, char)
        if (index > from && !/\s/.test(src[index - 1])) {
          // `_` is never intraword: snake_case identifiers are the common case in these notes.
          const after = src[index + run] ?? ''
          if ((char !== '_' || !ALNUM.test(after)) && (run === size || run >= 3)) return index + run - size
        }
        index += run - 1
      }
      return -1
    }

    function emphasisAt(src, at) {
      const char = src[at]
      const run = runLength(src, at, char)
      const sizes = char === '~' ? (run >= 2 ? [2] : []) : run >= 2 ? [2, 1] : [1]
      for (const size of sizes) {
        const after = src[at + size]
        if (after === undefined || /\s/.test(after)) continue
        if (char === '_' && at > 0 && ALNUM.test(src[at - 1])) continue
        const end = findCloser(src, at + size, char, size)
        if (end === -1) continue
        const type = char === '~' ? 'del' : size === 2 ? 'strong' : 'em'
        return { node: { type, children: parseInline(src.slice(at + size, end)) }, end: end + size }
      }
      return null
    }

    /** Inline nodes: text / code / strong / em / del / link / br. A newline is a line break. */
    function parseInline(src) {
      const text = String(src ?? '')
      const out = []
      let buffer = ''
      const push = (node) => {
        if (buffer !== '') out.push({ type: 'text', text: buffer })
        buffer = ''
        out.push(node)
      }
      let index = 0
      while (index < text.length) {
        const char = text[index]
        if (char === '\\' && index + 1 < text.length && PUNCT.includes(text[index + 1])) {
          buffer += text[index + 1]
          index += 2
          continue
        }
        if (char === '\n') {
          push({ type: 'br' })
          index += 1
          continue
        }
        if (char === '`') {
          const span = codeSpan(text, index)
          if (span !== null) {
            push(span.node)
            index = span.end
          } else {
            const run = runLength(text, index, '`')
            buffer += text.slice(index, index + run)
            index += run
          }
          continue
        }
        if (char === '[') {
          const link = linkAt(text, index)
          if (link !== null) {
            push(link.node)
            index = link.end
            continue
          }
        }
        if (char === '<') {
          const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(index))
          if (auto !== null) {
            push(linkNode(auto[1], [{ type: 'text', text: auto[1] }]))
            index += auto[0].length
            continue
          }
        }
        if ((char === 'h' || char === 'H') && (index === 0 || !/[A-Za-z0-9]/.test(text[index - 1]))) {
          const url = bareUrl(text, index)
          if (url !== null) {
            push(linkNode(url, [{ type: 'text', text: url }]))
            index += url.length
            continue
          }
        }
        if (char === '*' || char === '_' || char === '~') {
          const emphasis = emphasisAt(text, index)
          if (emphasis !== null) {
            push(emphasis.node)
            index = emphasis.end
          } else {
            const run = runLength(text, index, char)
            buffer += text.slice(index, index + run)
            index += run
          }
          continue
        }
        buffer += char
        index += 1
      }
      if (buffer !== '') out.push({ type: 'text', text: buffer })
      return out
    }

    function plainInline(nodes) {
      return (nodes ?? [])
        .map((node) => (node.type === 'text' || node.type === 'code' ? node.text : node.type === 'br' ? ' ' : plainInline(node.children)))
        .join('')
    }

    const peekCache = new Map()
    /** The one-line peek a folded card shows: the first thing the body says, as plain text. */
    function peekOf(body) {
      const text = String(body ?? '')
      if (text.trim() === '') return ''
      if (peekCache.has(text)) return peekCache.get(text)
      const first = (blocks) => {
        for (const block of blocks) {
          if (block.type === 'paragraph') return plainInline(block.inline)
          if (block.type === 'code') {
            const line = (block.code.split('\n').find((entry) => entry.trim() !== '') ?? '').trim()
            if (line !== '') return SHELL_LANGS.includes(block.lang) ? `$ ${line}` : line
          }
          if (block.type === 'quote') {
            const inner = first(block.blocks)
            if (inner) return inner
          }
          if (block.type === 'list') {
            for (const item of block.items) {
              const inner = first(item.blocks)
              if (inner) return (item.checked === null ? '' : item.checked ? '☑ ' : '☐ ') + inner
            }
          }
          if (block.type === 'table') return block.header.map(plainInline).join(' | ')
        }
        return ''
      }
      const out = first(parseMarkdown(text.slice(0, 2000))).replace(/\s+/g, ' ').trim()
      if (peekCache.size > 500) peekCache.clear()
      peekCache.set(text, out)
      return out
    }

    /** Toggle the task box on body line `line` (as `item.line` reports it). */
    function toggleTask(body, line) {
      const lines = splitLines(body)
      if (line < 0 || line >= lines.length) return body
      lines[line] = lines[line].replace(/^((?:\s*>)*\s*(?:[-+*]|\d{1,9}[.)])\s+)\[([ xX])\]/, (_, head, mark) => `${head}[${mark === ' ' ? 'x' : ' '}]`)
      return lines.join('\n')
    }

    // ------------------------------------------------------------------ folding (pure)

    /** `children` = line shown, body folded: what Shift+Tab "contents" sets. */
    const FOLD_STATES = ['folded', 'children', 'open', 'all']
    const GLOBAL_CYCLE = ['overview', 'contents', 'all']

    const defaultFold = (node) => (node.kind === 'lane' ? 'open' : 'folded')

    /**
     * Effective fold per node: `{ own, eff, lineShown, bodyShown }`. An `all` decides for
     * every descendant; the project's main line and a fork's lanes are always shown.
     */
    function computeFolds(root, fold) {
      const map = new Map()
      const stored = fold ?? {}
      const visit = (node, allAbove) => {
        if (node.kind === 'ref') return
        const own = FOLD_STATES.includes(stored[node.id]) ? stored[node.id] : defaultFold(node)
        const eff = allAbove || own === 'all' ? 'open' : own
        const line = lineOf(node)
        const always = node.kind === 'project' || node.kind === 'fork'
        map.set(node.id, {
          own,
          eff,
          lineShown: line.length > 0 && (always || eff !== 'folded'),
          bodyShown: (node.kind === 'step' || node.kind === 'project') && eff === 'open' && String(node.body ?? '').trim() !== '',
        })
        for (const child of line) visit(child, allAbove || own === 'all')
      }
      if (root) visit(root, false)
      return map
    }

    /** What a person sees of a subtree: which bodies and lines are out. */
    function foldSignature(node, folds) {
      const parts = []
      const visit = (current) => {
        const entry = folds.get(current.id)
        if (current.kind === 'ref' || entry === undefined) return
        parts.push(`${current.id}:${entry.bodyShown ? 'b' : ''}${entry.lineShown ? 'l' : ''}`)
        if (entry.lineShown) for (const child of lineOf(current)) visit(child)
      }
      visit(node)
      return parts.join(',')
    }

    /**
     * An `all` above the node pushed down along its path: every node on the way `open`, its
     * other children `all`. The screen is unchanged, but the node can now fold on its own.
     */
    function pushDownAll(fold, entry) {
      const at = entry.path.findIndex((ancestor) => fold[ancestor.id] === 'all')
      if (at === -1) return fold
      const next = { ...fold }
      const chain = entry.path.slice(at).concat([entry.node])
      for (let i = 0; i < chain.length - 1; i += 1) {
        next[chain[i].id] = 'open'
        for (const child of lineOf(chain[i])) if (child !== chain[i + 1]) next[child.id] = 'all'
      }
      next[entry.node.id] = 'all'
      return next
    }

    /** org's CHILDREN: the body and the direct children, every one folded; nothing below is remembered. */
    function showChildren(node, fold) {
      const next = { ...fold }
      const forget = (current) => {
        for (const child of lineOf(current)) {
          delete next[child.id]
          forget(child)
        }
      }
      forget(node)
      next[node.id] = 'open'
      // A fork always shows its lanes; folded, each is just its label.
      const forks = node.kind === 'fork' ? [node] : lineOf(node).filter((child) => child.kind === 'fork')
      for (const fork of forks) for (const lane of lineOf(fork)) next[lane.id] = 'folded'
      return next
    }

    /**
     * Tab on one node, the org way: folded → its children; Tab again right away → the whole
     * subtree; any other Tab folds it. `last` is the state the previous command left the node
     * in when that command was Tab on this node, else null. A state that would change nothing
     * on screen is skipped.
     */
    function nextFold(root, fold, id, last) {
      const entry = indexTree(root).get(id)
      const start = fold ?? {}
      if (!entry || entry.node.kind === 'ref') return { fold: start, state: null, changed: false }
      const base = pushDownAll(start, entry)
      const folds = computeFolds(root, base)
      const before = foldSignature(entry.node, folds)
      const order = last === 'open' ? ['all', 'folded'] : folds.get(id).eff === 'folded' ? ['open', 'all'] : ['folded', 'open', 'all']
      for (const state of order) {
        const next = state === 'open' ? showChildren(entry.node, base) : { ...base, [id]: state }
        if (foldSignature(entry.node, computeFolds(root, next)) !== before) return { fold: next, state, changed: true }
      }
      return { fold: base, state: folds.get(id).own, changed: base !== start }
    }

    /** The fold map of one Shift+Tab view of the whole project. */
    function globalFold(root, mode) {
      const fold = {}
      if (!root) return fold
      if (mode === 'all') {
        fold[root.id] = 'all'
        return fold
      }
      const visit = (node) => {
        if (node.kind === 'ref') return
        if (node.kind !== 'fork') {
          if (mode === 'overview') fold[node.id] = 'folded'
          else if (node.kind === 'lane') fold[node.id] = 'open'
          else fold[node.id] = node.kind === 'step' && lineOf(node).length > 0 ? 'children' : 'folded'
        }
        for (const child of lineOf(node)) visit(child)
      }
      visit(root)
      return fold
    }

    /**
     * Shift+Tab: overview → contents → show all → overview, skipping views that change
     * nothing. `last` is the view the previous command chose when it was Shift+Tab, else null.
     */
    function nextGlobalFold(root, fold, last) {
      if (!root) return { fold: fold ?? {}, mode: null }
      const before = foldSignature(root, computeFolds(root, fold))
      const at = GLOBAL_CYCLE.indexOf(last)
      for (let step = 1; step <= GLOBAL_CYCLE.length; step += 1) {
        const mode = GLOBAL_CYCLE[(at + step) % GLOBAL_CYCLE.length]
        const next = globalFold(root, mode)
        if (foldSignature(root, computeFolds(root, next)) !== before) return { fold: next, mode }
      }
      return { fold: fold ?? {}, mode: last ?? null }
    }

    /** The Shift+Tab view the screen shows now, or null when it is a mix of the reader's own. */
    function globalModeOf(root, fold) {
      if (!root) return null
      const now = foldSignature(root, computeFolds(root, fold))
      return GLOBAL_CYCLE.find((mode) => foldSignature(root, computeFolds(root, globalFold(root, mode))) === now) ?? null
    }

    /** The fold map with every line on the way to `id` shown, so a selection is never hidden. */
    function revealPath(root, fold, id, includeSelf) {
      const entry = indexTree(root).get(id)
      if (!entry) return fold
      const folds = computeFolds(root, fold)
      let next = fold
      const chain = includeSelf ? entry.path.concat([entry.node]) : entry.path
      for (const node of chain) {
        if (node.kind !== 'step' && node.kind !== 'lane') continue
        // The node itself is about to get a first child: open it even while its line is empty.
        const hidden =
          includeSelf && node === entry.node ? folds.get(node.id)?.eff === 'folded' : lineOf(node).length > 0 && folds.get(node.id)?.lineShown !== true
        if (hidden) {
          if (next === fold) next = { ...fold }
          next[node.id] = node.kind === 'lane' ? 'open' : 'children'
        }
      }
      return next
    }

    // ------------------------------------------------------------------ layout (pure)

    // The prototype's spacing: vertical gap, lane gap, chapter frame padding, fork top/bottom.
    const VG = 30
    const HG = 28
    const FP = 16
    const FT = 52
    const FB = 28
    const LANE_MIN = 140
    const DEFAULT_SIZE = { w: 224, h: 40 }

    const round = (value) => Math.round(value * 10) / 10

    function elbow(x0, y0, x1, y1, my) {
      if (Math.abs(x1 - x0) < 0.5) return `M${round(x0)} ${round(y0)} V${round(y1)}`
      const dir = Math.sign(x1 - x0)
      const r = Math.max(0, Math.min(8, Math.abs(x1 - x0) / 2, my - y0, y1 - my))
      return (
        `M${round(x0)} ${round(y0)} V${round(my - r)} Q${round(x0)} ${round(my)} ${round(x0 + dir * r)} ${round(my)} ` +
        `H${round(x1 - dir * r)} Q${round(x1)} ${round(my)} ${round(x1)} ${round(my + r)} V${round(y1)}`
      )
    }

    const connect = (from, to) => elbow(from.x, from.y, to.x, to.y, (from.y + to.y) / 2)
    const rectBox = (box) => ({ x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h })
    const union = (a, b) =>
      a === null || a === undefined
        ? b ?? null
        : b === null || b === undefined
          ? a
          : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }

    /**
     * For each line on the way to the selection, how far the walk got in it:
     * owner id (project / step / lane) → index; a selected lane is -1 in its own line.
     */
    function chainOf(index, selected) {
      const chain = new Map()
      let entry = selected ? index.get(selected) : undefined
      if (!entry) return chain
      let child = entry.node
      while (entry && entry.parent) {
        const parent = entry.parent
        if (child.kind === 'lane') {
          if (!chain.has(child.id)) chain.set(child.id, -1)
        } else if (parent.kind !== 'fork' && child.kind !== 'ref') chain.set(parent.id, lineOf(parent).indexOf(child))
        child = parent
        entry = index.get(parent.id)
      }
      return chain
    }

    /**
     * Place the walkthrough. `measure(id) → { w, h }` gives every drawn element's size
     * (cards, lane pills, fork labels), so this runs without a DOM. Offsets `{ dx, dy }`
     * are applied on top of the automatic layout and inherited by descendants.
     *
     * @returns {{ boxes: Record<string, {x,y,w,h,kind}>, edges: {d,live,hot}[], frames: {id,x,y,w,h,hot}[],
     *   order: string[], bounds: {x0,y0,x1,y1}, folds: Map }}
     */
    function layout(root, options = {}) {
      const measureFn = typeof options.measure === 'function' ? options.measure : () => DEFAULT_SIZE
      const size = (id) => {
        const value = measureFn(id)
        return { w: num(value?.w, DEFAULT_SIZE.w), h: num(value?.h, DEFAULT_SIZE.h) }
      }
      const offsets = options.offsets ?? {}
      const folds = options.folds ?? computeFolds(root, options.fold)
      const index = options.index ?? indexTree(root)
      const chain = chainOf(index, options.selected)
      const blocks = new Map()
      const boxes = {}
      const edges = []
      const frames = []
      const order = []
      if (!root) return { boxes, edges, frames, order, bounds: { x0: 0, y0: 0, x1: 0, y1: 0 }, folds }

      const offsetOf = (id) => ({ x: num(offsets[id]?.dx, 0), y: num(offsets[id]?.dy, 0) })
      const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y })
      const shown = (node) => folds.get(node.id)?.lineShown === true
      const liveFrom = (items, at) => items.slice(at).some(isLive)
      const reached = (owner) => (chain.has(owner) ? chain.get(owner) : -Infinity)
      const edge = (from, to, live, hot) => edges.push({ d: connect(from, to), live, hot })

      /**
       * `open`: nothing follows this item anywhere in the walk — it ends its line, and that line's
       * own end leads nowhere (the project's line; a chapter of such an item; a lane that does not
       * merge). Lanes merge into whatever follows; with nothing to follow they run to their ends.
       */
      const mItem = (node, open) => (node.kind === 'fork' ? mFork(node, open) : mStep(node, open))
      function mLine(items, open) {
        let w = 0
        let total = 0
        items.forEach((item, at) => {
          const block = mItem(item, open && at === items.length - 1)
          w = Math.max(w, block.w)
          total += block.h + (at ? VG : 0)
        })
        return { w, h: total }
      }
      function mStep(step, open) {
        const card = size(step.id)
        let block = { w: card.w, h: card.h, cw: card.w, ch: card.h, sub: null, L: null }
        if (shown(step)) {
          const sub = lineOf(step)
          const L = mLine(sub, open)
          block = { w: Math.max(card.w, L.w + 2 * FP), h: card.h + VG + L.h + FP + 8, cw: card.w, ch: card.h, sub, L }
        }
        blocks.set(step.id, block)
        return block
      }
      function mFork(fork, open) {
        // An empty fork still draws its one stroke through, so it keeps its merge point.
        const merges = !open || lineOf(fork).length === 0
        let lanesWidth = 0
        let tallest = 0
        const lanes = lineOf(fork).map((lane, at) => {
          const pill = size(lane.id)
          const line = shown(lane) ? lineOf(lane) : []
          const L = mLine(line, !merges)
          const w = Math.max(L.w, pill.w + 20, LANE_MIN)
          lanesWidth += w + (at ? HG : 0)
          tallest = Math.max(tallest, L.h)
          return { lane, w, L, line, pill }
        })
        const label = fork.title ? size(fork.id) : null
        if (lanes.length === 0) lanesWidth = LANE_MIN
        const block ={ w: Math.max(lanesWidth, label ? label.w : 0), h: FT + tallest + (merges ? FB : 0), lw: lanesWidth, lanes, label, merges }
        blocks.set(fork.id, block)
        return block
      }

      function pLine(owner, items, cx, top, passed, off) {
        let y = top
        let previous = null
        let first = null
        let bbox = null
        items.forEach((item, at) => {
          const placed = item.kind === 'fork' ? pFork(item, cx, y, owner, items, at, passed, off) : pStep(item, cx, y, owner, items, at, passed, off)
          if (at === 0) first = placed.in
          else edge(previous, placed.in, liveFrom(items, at), passed || reached(owner) >= at)
          // null after a fork that does not merge: the line ends in its lanes.
          previous = placed.out
          bbox = union(bbox, placed.bbox)
          y += blocks.get(item.id).h + VG
        })
        return { first, last: previous, bbox }
      }

      function pStep(step, cx, y, owner, items, at, passed, off) {
        const block = blocks.get(step.id)
        const o = add(off, offsetOf(step.id))
        const box = { x: cx - block.cw / 2 + o.x, y: y + o.y, w: block.cw, h: block.ch, kind: step.kind === 'step' ? 'step' : step.kind }
        boxes[step.id] = box
        order.push(step.id)
        const entry = { x: cx + o.x, y: y + o.y }
        const cardBottom = { x: cx + o.x, y: y + block.ch + o.y }
        if (!block.sub) return { in: entry, out: cardBottom, bbox: rectBox(box) }
        const subPassed = passed || reached(owner) > at
        const onChain = subPassed || chain.has(step.id)
        const slot = frames.length
        frames.push(null)
        const inner = pLine(step.id, block.sub, cx, y + block.ch + VG, subPassed, o)
        edge(cardBottom, inner.first, liveFrom(block.sub, 0), onChain)
        const bottom = { x: cx + o.x, y: y + block.h + o.y }
        if (inner.last) edge(inner.last, bottom, liveFrom(items, at + 1), subPassed)
        const auto = { x0: cx - block.w / 2 + o.x, y0: y + block.ch + VG / 2 + o.y, x1: cx + block.w / 2 + o.x, y1: bottom.y }
        // A child dragged out of its chapter stretches the frame: it is still that chapter's.
        const content = inner.bbox && { x0: inner.bbox.x0 - FP, y0: inner.bbox.y0 - VG / 2, x1: inner.bbox.x1 + FP, y1: inner.bbox.y1 + FP + 8 }
        const frame = union(auto, content)
        frames[slot] = { id: step.id, x: frame.x0, y: frame.y0, w: frame.x1 - frame.x0, h: frame.y1 - frame.y0, hot: onChain }
        return { in: entry, out: bottom, bbox: union(rectBox(box), frame) }
      }

      function pFork(fork, cx, y, owner, items, at, passed, off) {
        const block = blocks.get(fork.id)
        const o = add(off, offsetOf(fork.id))
        const lanePassed = passed || reached(owner) > at
        const entry = { x: cx + o.x, y: y + o.y }
        const merge = { x: cx + o.x, y: y + block.h + o.y }
        const split = y + 12 + o.y
        let bbox = { x0: cx - block.w / 2 + o.x, y0: y + o.y, x1: cx + block.w / 2 + o.x, y1: merge.y }
        let x0 = cx - block.lw / 2
        if (block.label) {
          const label = {
            x: Math.min(x0, cx - block.label.w / 2) + o.x,
            y: y + 10 - block.label.h + o.y,
            w: block.label.w,
            h: block.label.h,
            kind: 'fork',
          }
          boxes[fork.id] = label
          bbox = union(bbox, rectBox(label))
        }
        if (block.lanes.length === 0) edge(entry, merge, liveFrom(items, at + 1), lanePassed)
        for (const info of block.lanes) {
          const lo = add(o, offsetOf(info.lane.id))
          const lx = x0 + info.w / 2
          const pill = { x: lx - info.pill.w / 2 + lo.x, y: y + 18 + lo.y, w: info.pill.w, h: info.pill.h, kind: 'lane' }
          boxes[info.lane.id] = pill
          order.push(info.lane.id)
          const laneLive = lineOf(info.lane).some(isLive)
          edges.push({ d: elbow(entry.x, entry.y, lx + lo.x, pill.y, split), live: laneLive, hot: lanePassed || chain.has(info.lane.id) })
          let end = { x: lx + lo.x, y: pill.y + pill.h }
          if (info.line.length > 0) {
            const inner = pLine(info.lane.id, info.line, lx, y + FT, lanePassed, lo)
            edge(end, inner.first, laneLive, lanePassed || reached(info.lane.id) >= 0)
            end = inner.last
            bbox = union(bbox, inner.bbox)
          }
          bbox = union(bbox, rectBox(pill))
          if (block.merges) edges.push({ d: elbow(end.x, end.y, merge.x, merge.y, merge.y - 12), live: liveFrom(items, at + 1), hot: lanePassed })
          x0 += info.w + HG
        }
        return { in: entry, out: block.merges ? merge : null, bbox }
      }

      const card = size(root.id)
      const main = lineOf(root)
      const L = mLine(main, true)
      const cx = Math.max(card.w, L.w) / 2
      boxes[root.id] = { x: cx - card.w / 2, y: 0, w: card.w, h: card.h, kind: 'project' }
      order.push(root.id)
      if (main.length > 0) {
        const placed = pLine(root.id, main, cx, card.h + VG, false, { x: 0, y: 0 })
        edges.unshift({ d: connect({ x: cx, y: card.h }, placed.first), live: liveFrom(main, 0), hot: reached(root.id) >= 0 })
      }
      let bounds = null
      for (const box of Object.values(boxes)) bounds = union(bounds, rectBox(box))
      for (const frame of frames) if (frame) bounds = union(bounds, rectBox(frame))
      return { boxes, edges, frames: frames.filter(Boolean), order, bounds, folds }
    }

    /** ← / →: the same position in the neighbouring lane (a lane pill hops to the next pill). */
    function laneNeighbour(root, id, dir, folds) {
      const index = indexTree(root)
      let entry = index.get(id)
      while (entry && entry.parent && entry.node.kind !== 'lane' && entry.parent.kind !== 'lane') entry = index.get(entry.parent.id)
      if (!entry || !entry.parent) return null
      const lane = entry.node.kind === 'lane' ? entry.node : entry.parent
      const fork = index.get(lane.id)?.parent
      if (!fork) return null
      const lanes = lineOf(fork)
      const target = lanes[lanes.indexOf(lane) + dir]
      if (!target) return null
      if (entry.node.kind === 'lane') return target.id
      const items = lineOf(target)
      if (items.length === 0 || folds?.get(target.id)?.lineShown !== true) return target.id
      return items[Math.min(lineOf(lane).indexOf(entry.node), items.length - 1)].id
    }

    /**
     * Alt+→ / Alt+←, org-style, the subtree moving along. In: the last step of the previous item's
     * chapter — after a fork, the end of its last lane. Out: right after the parent step — from a
     * lane, right after the fork, where the lanes have merged back. `{ parent, after? }` for a
     * `move` op, or `{ reason }` when there is nowhere to go.
     */
    function indentTarget(root, id, dir) {
      const index = indexTree(root)
      const entry = index.get(id)
      if (!entry?.parent || (entry.node.kind !== 'step' && entry.node.kind !== 'fork')) return { reason: 'kind' }
      if (dir > 0) {
        const line = lineOf(entry.parent)
        const before = line[line.indexOf(entry.node) - 1]
        if (!before) return { reason: 'first' }
        if (before.kind !== 'fork') return { parent: before.id }
        const lanes = lineOf(before)
        return lanes.length > 0 ? { parent: lanes[lanes.length - 1].id } : { reason: 'first' }
      }
      const up = entry.parent.kind === 'lane' ? index.get(entry.parent.id).parent : entry.parent
      const outer = up && index.get(up.id).parent
      return outer ? { parent: outer.id, after: up.id } : { reason: 'top' }
    }

    // ------------------------------------------------------------------ host calls

    function apiError(reason, message, status) {
      const error = new Error(message ?? reason ?? 'request failed')
      error.reason = reason ?? 'internal'
      error.status = status ?? 0
      return error
    }

    /** One request shape for the whole panel: `{ ok: true, data }` or a typed failure. */
    async function call(path, options = {}) {
      const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : ''
      let response
      try {
        response = await fetch(`${API}/${path}${query}`, {
          method: options.method ?? 'GET',
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
      } catch (failure) {
        throw apiError('network', translate(activeLang, 'error.network', { message: failure?.message ?? failure }))
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw apiError('internal', translate(activeLang, 'error.notJson', { status: response.status }), response.status)
      }
      if (payload?.ok === true) return payload.data
      const reason = payload?.reason ?? 'internal'
      const known = DICTS[activeLang]?.[`reason.${reason}`]
      throw apiError(reason, payload?.error ? payload.error : known ?? `HTTP ${response.status}`, response.status)
    }

    /** The op route answers a whole Project or (defensively) a bare root. */
    function asProject(value) {
      if (!value || typeof value !== 'object') return null
      if (value.root && typeof value.root === 'object') return value
      if (value.kind === 'project') return { id: value.id, file: '', rev: '', root: value }
      return null
    }

    function readLocal(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    }

    function writeLocal(key, value) {
      try {
        if (value === null || value === undefined) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
      } catch {
        /* storage is a nicety */
      }
    }

    const readNumber = (key, fallback) => {
      const value = Number(readLocal(key))
      return readLocal(key) !== null && Number.isFinite(value) && value > 0 ? value : fallback
    }

    /** Inputs own their keys: a canvas shortcut must never fire while someone is typing. */
    function isTypingTarget(target) {
      if (!target || typeof target.closest !== 'function') return false
      return target.closest('input, textarea, select, [contenteditable="true"], .ml-menu, .ml-form') !== null
    }

    const composing = (event) => event.nativeEvent?.isComposing === true || event.isComposing === true || event.keyCode === 229

    // ------------------------------------------------------------------ icons

    function Icon(props) {
      const size = props.size ?? 14
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }
      switch (props.name) {
        case 'clip':
          return h('svg', common, h('path', { d: 'M10.5 4.5 5.4 9.6a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.2 7.6a4.5 4.5 0 0 0 6.4 6.4l4.4-4.4' }))
        case 'right':
          return h('svg', common, h('path', { d: 'M6 3.8 10.2 8 6 12.2' }))
        case 'down':
          return h('svg', common, h('path', { d: 'M3.8 6 8 10.2 12.2 6' }))
        case 'play':
          return h('svg', { ...common, strokeWidth: 0 }, h('path', { d: 'M4.8 3.2v9.6L12.4 8z', fill: 'currentColor' }))
        case 'stop':
          return h('svg', { ...common, strokeWidth: 0 }, h('rect', { x: 4.2, y: 4.2, width: 7.6, height: 7.6, rx: 1.2, fill: 'currentColor' }))
        case 'spark':
          return h('svg', common, h('path', { d: 'M8 2.2v3M8 10.8v3M2.2 8h3M10.8 8h3M4 4l1.9 1.9M10.1 10.1 12 12M12 4l-1.9 1.9M5.9 10.1 4 12' }))
        case 'open':
          return h('svg', common, h('path', { d: 'M9.4 2.8h3.8v3.8M13.2 2.8 7.6 8.4' }), h('path', { d: 'M11.6 9.2v3a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1h3' }))
        case 'reset':
          return h('svg', common, h('path', { d: 'M3 8a5 5 0 1 0 1.6-3.7' }), h('path', { d: 'M2.8 2.2v3.2H6' }))
        case 'plus':
          return h('svg', common, h('path', { d: 'M8 3.4v9.2M3.4 8h9.2' }))
        case 'history':
          return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.6 }), h('path', { d: 'M8 4.8V8l2.2 1.4' }))
        case 'target':
          return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.4 }), h('circle', { cx: 8, cy: 8, r: 1.6 }))
        case 'fit':
          return h('svg', common, h('path', { d: 'M2.8 6V2.8H6M10 2.8h3.2V6M13.2 10v3.2H10M6 13.2H2.8V10' }))
        case 'levels':
          return h('svg', common, h('path', { d: 'M2.8 4h10.4M5.4 8h7.8M8 12h5.2' }))
        case 'close':
          return h('svg', common, h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }))
        case 'edit':
          return h('svg', common, h('path', { d: 'M10.6 2.8 13.2 5.4 6 12.6l-3.2.6.6-3.2z' }))
        case 'trash':
          return h('svg', common, h('path', { d: 'M2.8 4.4h10.4M6 4.4V3h4v1.4M4.2 4.4l.7 8.4h6.2l.7-8.4' }))
        default:
          return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.4 }))
      }
    }

    /** The sidebar mark: a line that forks into two lanes and merges back. */
    function Glyph(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 1.6v2.6M8 4.2c0 1.6-3.4 1.2-3.4 3V9c0 1.7 3.4 1.3 3.4 2.9M8 4.2c0 1.6 3.4 1.2 3.4 3V9c0 1.7-3.4 1.3-3.4 2.9M8 11.9v2.5',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 4.6, cy: 8, r: 1.3, fill: 'currentColor' }),
      )
    }

    // ------------------------------------------------------------------ Markdown → React

    function renderInline(nodes, keyPrefix) {
      return (nodes ?? []).map((node, at) => {
        const key = `${keyPrefix}.${at}`
        switch (node.type) {
          case 'text':
            return node.text
          case 'br':
            return h('br', { key })
          case 'code':
            return h('code', { key, className: 'ml-md-code' }, node.text)
          case 'strong':
            return h('strong', { key }, renderInline(node.children, key))
          case 'em':
            return h('em', { key }, renderInline(node.children, key))
          case 'del':
            return h('del', { key }, renderInline(node.children, key))
          case 'link':
            // An unsafe or relative target is shown, never followed: these are notes, not a site.
            return node.href
              ? h('a', { key, href: node.href, target: '_blank', rel: 'noopener noreferrer', onClick: (event) => event.stopPropagation() }, renderInline(node.children, key))
              : h('span', { key, className: 'ml-md-link-x', title: node.raw }, renderInline(node.children, key))
          default:
            return null
        }
      })
    }

    function renderBlocks(blocks, props, keyPrefix) {
      return blocks.map((block, at) => renderBlock(block, props, `${keyPrefix}.${at}`))
    }

    function renderBlock(block, props, key) {
      switch (block.type) {
        case 'paragraph':
          return h('p', { key }, renderInline(block.inline, key))
        case 'hr':
          return h('hr', { key })
        case 'quote':
          return h('blockquote', { key }, renderBlocks(block.blocks, props, key))
        case 'code':
          return block.run !== null && props.fences ? h(FenceBlock, { key, block, ...props }) : h('pre', { key, className: 'ml-md-pre' }, h('code', null, block.code))
        case 'table':
          return h(
            'div',
            { key, className: 'ml-md-table' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, block.header.map((cell, column) => h('th', { key: column, style: block.align[column] ? { textAlign: block.align[column] } : undefined }, renderInline(cell, `${key}.h${column}`))))),
              h(
                'tbody',
                null,
                block.rows.map((row, line) =>
                  h('tr', { key: line }, row.map((cell, column) => h('td', { key: column, style: block.align[column] ? { textAlign: block.align[column] } : undefined }, renderInline(cell, `${key}.${line}.${column}`)))),
                ),
              ),
            ),
          )
        case 'list':
          return h(
            block.ordered ? 'ol' : 'ul',
            { key, start: block.ordered && block.start !== 1 ? block.start : undefined },
            block.items.map((item, at) =>
              h(
                'li',
                { key: at, className: item.checked === null ? undefined : 'ml-md-task' },
                item.checked === null
                  ? null
                  : h('input', {
                      type: 'checkbox',
                      checked: item.checked,
                      disabled: typeof props.onToggleTask !== 'function',
                      'aria-label': plainInline(item.blocks[0]?.inline ?? []),
                      onChange: () => props.onToggleTask?.(item.line),
                      onClick: (event) => event.stopPropagation(),
                    }),
                renderBlocks(item.blocks, props, `${key}.${at}`),
              ),
            ),
          )
        default:
          return null
      }
    }

    /**
     * A body rendered as React elements — never innerHTML. `fences` makes shell fences
     * runnable; `onToggleTask(line)` makes task boxes clickable.
     */
    function Markdown(props) {
      const blocks = useMemo(() => parseMarkdown(props.text), [props.text])
      return h('div', { className: `ml-md${props.className ? ` ${props.className}` : ''}` }, renderBlocks(blocks, props, 'b'))
    }

    function runText(value) {
      if (typeof value === 'string') return value
      return typeof value?.text === 'string' ? value.text : ''
    }

    function RunOutput(props) {
      const { run, t } = props
      const [open, setOpen] = useState(true)
      const running = run.status === 'running'
      const stdout = runText(run.stdout)
      const stderr = runText(run.stderr)
      const status = running
        ? t('run.running')
        : run.aborted
          ? t('run.aborted')
          : run.timedOut
            ? t('run.timeout')
            : run.exitCode === null || run.exitCode === undefined
              ? t('run.failed')
              : t('run.exit', { code: run.exitCode })
      const seconds = run.startedAt && run.endedAt ? `${Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1)} s` : ''
      return h(
        'div',
        { className: 'ml-run', 'data-status': run.status, 'data-failed': !running && run.status !== 'done' ? '1' : '0' },
        h(
          'div',
          { className: 'ml-run-head' },
          running ? h('span', { className: 'ml-spin', 'aria-hidden': 'true' }) : null,
          h('span', { className: 'ml-run-status', role: 'status' }, status),
          seconds ? h('span', { className: 'ml-run-meta' }, seconds) : null,
          run.cwd ? h('span', { className: 'ml-run-meta ml-run-cwd', title: run.cwd }, run.cwd) : null,
          h(
            'button',
            { type: 'button', className: 'ml-link', 'aria-expanded': open, onClick: (event) => (event.stopPropagation(), setOpen(!open)) },
            open ? t('run.collapse') : t('run.expand'),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'ml-run-body' },
              stdout ? h('pre', { className: 'ml-run-out' }, stdout) : null,
              stderr ? h('pre', { className: 'ml-run-out ml-run-err', 'aria-label': t('run.stderr') }, stderr) : null,
              !stdout && !stderr && !running ? h('div', { className: 'ml-run-meta' }, t('run.noOutput')) : null,
              stdout.length >= 20000 || stderr.length >= 20000 ? h('div', { className: 'ml-run-meta' }, t('run.truncated')) : null,
            )
          : null,
      )
    }

    function FenceBlock(props) {
      const { block, fences, nodeId, t } = props
      const run = fences.runOf(nodeId, block.run)
      const running = run?.status === 'running'
      useEffect(() => {
        fences.ensure(nodeId)
      }, [nodeId])
      const stop = (event) => event.stopPropagation()
      return h(
        'div',
        { className: 'ml-fence', onPointerDown: stop, onDoubleClick: stop },
        h(
          'div',
          { className: 'ml-fence-head' },
          h('span', { className: 'ml-fence-lang' }, block.lang),
          h('span', { className: 'ml-grow' }),
          running
            ? h('button', { type: 'button', className: 'ml-mini', onClick: (event) => (stop(event), fences.cancel(run.runId)) }, h(Icon, { name: 'stop', size: 11 }), t('run.stop'))
            : h('button', { type: 'button', className: 'ml-mini ml-mini-strong', onClick: (event) => (stop(event), fences.start(nodeId, block.run)) }, h(Icon, { name: 'play', size: 11 }), t('run.run')),
          h('button', { type: 'button', className: 'ml-mini', onClick: (event) => (stop(event), fences.ask(nodeId, block.run)) }, h(Icon, { name: 'spark', size: 11 }), t('run.ask')),
        ),
        h('pre', { className: 'ml-md-pre' }, h('code', null, block.code)),
        run ? h(RunOutput, { run, t }) : null,
      )
    }

    // ------------------------------------------------------------------ small pieces

    /** One-line title editor: Enter saves, Esc cancels, leaving saves. IME-safe. */
    function TitleInput(props) {
      const [value, setValue] = useState(props.initial ?? '')
      const ref = useRef(null)
      const finished = useRef(false)
      useEffect(() => {
        const input = ref.current
        if (input) {
          input.focus({ preventScroll: true })
          input.select()
        }
      }, [])
      const finish = (save, viaKey) => {
        if (finished.current) return
        finished.current = true
        props.onDone(save ? value : null, viaKey)
      }
      const stop = (event) => event.stopPropagation()
      return h('input', {
        ref,
        className: `ml-title-input${props.className ? ` ${props.className}` : ''}`,
        value,
        placeholder: props.placeholder,
        'aria-label': props.label ?? props.placeholder,
        maxLength: 300,
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => {
          stop(event)
          if (composing(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true, true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(false, true)
          }
        },
        onBlur: () => finish(true, false),
        onPointerDown: stop,
        onClick: stop,
        onDoubleClick: stop,
        onContextMenu: stop,
      })
    }

    function Card(props) {
      const { node, t, actions } = props
      const isProject = node.kind === 'project'
      const refs = refsOf(node)
      const line = lineOf(node)
      const [editingBody, setEditingBody] = useState(false)
      // An editor stays open even if the body shrinks to nothing under it, so the typing is not lost.
      const open = props.bodyShown || editingBody
      const peek = open ? '' : peekOf(node.body)
      const todo = isProject ? countTodo(node) : 0
      const refTitles = refs.slice(0, 2).map((ref) => clip(ref.title, 12)).join(' · ')
      return h(
        'div',
        {
          className: 'ml-card',
          'data-node': node.id,
          'data-measure': node.id,
          'data-kind': node.kind,
          'data-state': node.state || 'none',
          'data-sel': props.selected ? '1' : '0',
          'data-open': open ? '1' : '0',
          'data-cut': props.cut ? '1' : '0',
          'data-fresh': props.fresh ? '1' : '0',
          'aria-current': props.selected ? 'true' : undefined,
          style: { transform: `translate(${props.x}px, ${props.y}px)` },
          onClick: (event) => {
            if (event.target.closest('button, a, input, textarea')) return
            actions.select(node.id)
          },
          onDoubleClick: (event) => {
            // Links, buttons, checkboxes and code keep their own double-click (code: select a word).
            if (!props.bodyShown || !event.target.closest('.ml-card-body') || event.target.closest('a, button, input, textarea, pre')) return
            setEditingBody(true)
            // The editor is taller than the text it replaces: keep all of it on screen.
            actions.reveal(node.id)
          },
        },
        h(
          'div',
          { className: 'ml-card-title' },
          node.question ? h('span', { className: 'ml-q', 'aria-label': t('question.toggle') }, '?') : null,
          props.editing
            ? h(TitleInput, { initial: node.title, placeholder: t('card.new'), onDone: actions.finishEdit })
            : h(
                'span',
                {
                  className: 'ml-card-text',
                  title: node.title,
                  onDoubleClick: (event) => {
                    event.stopPropagation()
                    actions.startRename(node.id)
                  },
                },
                node.title || t('card.untitled'),
              ),
        ),
        peek ? h('div', { className: 'ml-peek' }, peek) : null,
        editingBody
          ? h(
              'div',
              { className: 'ml-card-edit' },
              h(BodyEditor, {
                t,
                initial: node.body,
                label: node.title,
                grow: CARD_BODY_MAX,
                onDone: (value, viaKey) => {
                  setEditingBody(false)
                  if (value !== null) actions.saveBody(node.id, value)
                  if (viaKey) actions.focusCanvas()
                },
              }),
            )
          : props.bodyShown
            ? h(Markdown, {
                className: 'ml-card-body',
                text: node.body,
                nodeId: node.id,
                fences: props.fences,
                runsKey: props.runsKey,
                t,
                onToggleTask: (at) => actions.saveBody(node.id, toggleTask(node.body, at)),
              })
            : null,
        refs.length > 0 || (line.length > 0 && !isProject) || todo > 0
          ? h(
              'div',
              { className: 'ml-card-foot' },
              refs.length > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ml-chip',
                      title: t('card.refsTitle', { n: refs.length, titles: refs.map((ref) => ref.title).join(' · ') }),
                      onClick: (event) => {
                        event.stopPropagation()
                        actions.openRefs(node.id)
                      },
                    },
                    h(Icon, { name: 'clip', size: 11 }),
                    h('span', { className: 'ml-chip-n' }, refs.length),
                    refTitles ? h('span', { className: 'ml-chip-text' }, refTitles) : null,
                  )
                : null,
              line.length > 0 && !isProject
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ml-chip ml-chip-fold',
                      'aria-expanded': props.lineShown ? 'true' : 'false',
                      title: props.lineShown ? t('card.chapterHide') : t('card.chapterShow'),
                      onClick: (event) => {
                        event.stopPropagation()
                        actions.toggleChapter(node.id)
                      },
                    },
                    h(Icon, { name: props.lineShown ? 'down' : 'right', size: 11 }),
                    t('card.steps', { n: line.length }),
                  )
                : null,
              todo > 0 ? h('span', { className: 'ml-card-count' }, t('card.todo', { n: todo })) : null,
            )
          : null,
      )
    }
    const CardMemo = React.memo ? React.memo(Card) : Card

    function LanePill(props) {
      const { node, t, actions } = props
      const hidden = props.lineShown ? 0 : lineOf(node).length
      return h(
        'div',
        {
          className: 'ml-lane',
          'data-node': node.id,
          'data-measure': node.id,
          'data-kind': 'lane',
          'data-sel': props.selected ? '1' : '0',
          'data-live': props.live ? '1' : '0',
          'data-cut': props.cut ? '1' : '0',
          // An unnamed lane is only where the line splits: a dot, nameable by double-click.
          'data-bare': node.title || props.editing ? '0' : '1',
          title: node.title ? undefined : t('lane.unnamed'),
          'aria-label': node.title || t('lane.unnamed'),
          'aria-current': props.selected ? 'true' : undefined,
          style: { transform: `translate(${props.x}px, ${props.y}px)` },
          onClick: (event) => {
            if (event.target.closest('button, input')) return
            actions.select(node.id)
          },
          onDoubleClick: (event) => {
            if (event.target.closest('input')) return
            actions.startRename(node.id)
          },
        },
        props.editing
          ? h(TitleInput, { initial: node.title, placeholder: t('lane.untitled'), onDone: actions.finishEdit, className: 'ml-lane-input' })
          : node.title
            ? h('span', null, node.title)
            : null,
        hidden > 0
          ? h(
              'button',
              {
                type: 'button',
                className: 'ml-lane-more',
                title: t('lane.hidden', { n: hidden }),
                onClick: (event) => {
                  event.stopPropagation()
                  actions.setFold(node.id, 'open')
                },
              },
              h(Icon, { name: 'right', size: 10 }),
              hidden,
            )
          : null,
      )
    }
    const LaneMemo = React.memo ? React.memo(LanePill) : LanePill

    function ForkLabel(props) {
      const { node, t, actions } = props
      return h(
        'div',
        {
          className: 'ml-forkt',
          'data-node': node.id,
          'data-measure': node.id,
          'data-kind': 'fork',
          'data-sel': props.selected ? '1' : '0',
          style: { transform: `translate(${props.x}px, ${props.y}px)` },
          onClick: (event) => {
            if (event.target.closest('input')) return
            actions.select(node.id)
          },
          onDoubleClick: () => actions.startRename(node.id),
        },
        props.editing ? h(TitleInput, { initial: node.title, placeholder: t('fork.untitled'), onDone: actions.finishEdit, className: 'ml-lane-input' }) : node.title,
      )
    }

    /**
     * The right-click menu: custom, at the pointer, keyboard-driven (↑ ↓ Home End Enter Esc).
     * Items: `{ key, label, hint?, disabled?, danger?, checked?, onSelect }` or `'sep'`.
     */
    function ContextMenu(props) {
      const ref = useRef(null)
      const [pos, setPos] = useState({ x: props.x, y: props.y })
      const closeRef = useRef(props.onClose)
      closeRef.current = props.onClose
      useLayoutEffectSafe(() => {
        const menu = ref.current
        if (!menu) return
        const w = menu.offsetWidth
        const hh = menu.offsetHeight
        setPos({ x: clamp(props.x, 4, Math.max(4, props.bounds.w - w - 4)), y: clamp(props.y, 4, Math.max(4, props.bounds.h - hh - 4)) })
        const first = menu.querySelector('button:not([disabled])')
        if (first) first.focus({ preventScroll: true })
      }, [props.x, props.y])
      useEffect(() => {
        const onDown = (event) => {
          if (ref.current && !ref.current.contains(event.target)) closeRef.current(false, 'outside')
        }
        window.addEventListener('pointerdown', onDown, true)
        return () => window.removeEventListener('pointerdown', onDown, true)
      }, [])
      const move = (dir) => {
        const buttons = [...(ref.current?.querySelectorAll('button:not([disabled])') ?? [])]
        if (buttons.length === 0) return
        const at = buttons.indexOf(document.activeElement)
        const next = dir === 'first' ? 0 : dir === 'last' ? buttons.length - 1 : (at + dir + buttons.length) % buttons.length
        buttons[next].focus()
      }
      return h(
        'div',
        {
          ref,
          className: 'ml-menu',
          role: 'menu',
          'aria-label': props.label,
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
          onContextMenu: (event) => event.preventDefault(),
          onPointerDown: (event) => event.stopPropagation(),
          onKeyDown: (event) => {
            event.stopPropagation()
            if (event.key === 'ArrowDown') move(1)
            else if (event.key === 'ArrowUp') move(-1)
            else if (event.key === 'Home') move('first')
            else if (event.key === 'End') move('last')
            else if (event.key === 'Escape' || event.key === 'Tab') props.onClose(false)
            else return
            event.preventDefault()
          },
        },
        props.items.map((item, at) =>
          item === 'sep'
            ? h('div', { key: `sep${at}`, role: 'separator', className: 'ml-menu-sep' })
            : h(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
                  'aria-checked': item.checked === undefined ? undefined : item.checked ? 'true' : 'false',
                  className: `ml-menu-item${item.danger ? ' ml-menu-danger' : ''}`,
                  disabled: item.disabled === true,
                  onClick: () => {
                    props.onClose(true)
                    item.onSelect()
                  },
                },
                h('span', { className: 'ml-menu-check', 'aria-hidden': 'true' }, item.checked ? '✓' : ''),
                h('span', { className: 'ml-menu-label' }, item.label),
                item.hint ? h('span', { className: 'ml-menu-hint' }, item.hint) : null,
              ),
        ),
      )
    }

    /** "从这里分叉…": lane names, comma separated — an inline form, never window.prompt. */
    function ForkForm(props) {
      const { t } = props
      const [names, setNames] = useState('')
      const [title, setTitle] = useState('')
      const [error, setError] = useState(null)
      const ref = useRef(null)
      const [pos, setPos] = useState({ x: props.x, y: props.y })
      useLayoutEffectSafe(() => {
        const form = ref.current
        if (!form) return
        setPos({ x: clamp(props.x, 4, Math.max(4, props.bounds.w - form.offsetWidth - 4)), y: clamp(props.y, 4, Math.max(4, props.bounds.h - form.offsetHeight - 4)) })
        form.querySelector('input')?.focus({ preventScroll: true })
      }, [])
      const cancelRef = useRef(props.onCancel)
      cancelRef.current = props.onCancel
      useEffect(() => {
        const onDown = (event) => {
          if (ref.current && !ref.current.contains(event.target)) cancelRef.current()
        }
        window.addEventListener('pointerdown', onDown, true)
        return () => window.removeEventListener('pointerdown', onDown, true)
      }, [])
      const submit = () => {
        const list = names
          .split(/[,，、;；\n]/)
          .map((name) => name.trim())
          .filter(Boolean)
        if (list.length < 2) {
          setError(t('fork.needTwo'))
          return
        }
        props.onSubmit(list, title.trim())
      }
      const keys = (event) => {
        event.stopPropagation()
        if (composing(event)) return
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          props.onCancel()
        }
      }
      return h(
        'div',
        {
          ref,
          className: 'ml-form',
          role: 'dialog',
          'aria-label': t('fork.title'),
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
          onPointerDown: (event) => event.stopPropagation(),
          onContextMenu: (event) => event.stopPropagation(),
        },
        h('div', { className: 'ml-form-title' }, t('fork.title')),
        h(
          'label',
          { className: 'ml-form-row' },
          h('span', null, t('fork.lanes')),
          h('input', {
            className: 'ml-input',
            value: names,
            placeholder: props.question ? t('fork.hypotheses') : t('fork.lanesPlaceholder'),
            onChange: (event) => (setNames(event.target.value), setError(null)),
            onKeyDown: keys,
          }),
        ),
        h(
          'label',
          { className: 'ml-form-row' },
          h('span', null, t('fork.name')),
          h('input', { className: 'ml-input', value: title, onChange: (event) => setTitle(event.target.value), onKeyDown: keys }),
        ),
        error ? h('div', { className: 'ml-error', role: 'alert' }, error) : null,
        h(
          'div',
          { className: 'ml-form-actions' },
          h('button', { type: 'button', className: 'ml-btn', onClick: props.onCancel }, t('common.cancel')),
          h('button', { type: 'button', className: 'ml-btn ml-btn-strong', onClick: submit }, t('fork.submit')),
        ),
      )
    }

    function Toasts(props) {
      return h(
        'div',
        { className: 'ml-toasts', role: 'status', 'aria-live': 'polite' },
        props.items.map((toast) =>
          h(
            'div',
            { key: toast.id, className: 'ml-toast', 'data-kind': toast.kind },
            h('span', { className: 'ml-toast-text' }, toast.text),
            toast.action
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ml-btn ml-btn-strong',
                    onClick: () => {
                      props.onDismiss(toast.id)
                      toast.action.run()
                    },
                  },
                  toast.action.label,
                )
              : null,
            h('button', { type: 'button', className: 'ml-icon', 'aria-label': props.t('toast.dismiss'), onClick: () => props.onDismiss(toast.id) }, h(Icon, { name: 'close', size: 12 })),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ canvas

    /** A first guess for an element not measured yet; the layout effect corrects it before paint. */
    function estimate(index, id) {
      const kind = index.get(id)?.node.kind
      if (kind === 'project') return { w: 400, h: 90 }
      if (kind === 'lane') return { w: 72, h: 22 }
      if (kind === 'fork') return { w: 64, h: 17 }
      return { w: 224, h: 44 }
    }

    /** 'native' when `box` scrolls along the wheel's main axis, 'hold' when it would but is at its end, else null. */
    function scrollClaim(box, dx, dy) {
      const sideways = Math.abs(dx) > Math.abs(dy)
      const d = sideways ? dx : dy
      const pos = sideways ? box.scrollLeft : box.scrollTop
      const view = sideways ? box.clientWidth : box.clientHeight
      const full = sideways ? box.scrollWidth : box.scrollHeight
      if (d === 0 || full <= view + 1) return null
      return (d < 0 ? pos > 0 : pos + view < full - 1) ? 'native' : 'hold'
    }

    /**
     * What one wheel event does to the canvas. The wheel zooms, like a map; Shift+wheel and a
     * sideways wheel pan, since a zoom has no sideways meaning. Ctrl/⌘ always zooms: a trackpad
     * pinch arrives as that. A box in a card that scrolls along the wheel keeps it — even at its
     * end, where turning into a zoom mid-gesture would make the canvas jump.
     *
     * @param {{ deltaX: number, deltaY: number, deltaMode: number, shiftKey: boolean, ctrlKey: boolean, metaKey: boolean }} event
     * @param {object[]} boxes the scrollable boxes under the pointer, nearest first
     * @param {number} page pixels per page (`deltaMode` 2)
     * @returns {{ kind: 'native' | 'hold' } | { kind: 'zoom', delta: number } | { kind: 'pan', dx: number }}
     */
    function wheelIntent(event, boxes, page) {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1
      if (event.ctrlKey || event.metaKey) return { kind: 'zoom', delta: event.deltaY * unit }
      // Some systems already turn Shift+wheel into deltaX.
      const dx = (event.shiftKey ? event.deltaY || event.deltaX : event.deltaX) * unit
      const dy = (event.shiftKey ? 0 : event.deltaY) * unit
      for (const box of boxes) {
        const claim = scrollClaim(box, dx, dy)
        if (claim) return { kind: claim }
      }
      return Math.abs(dx) > Math.abs(dy) ? { kind: 'pan', dx } : { kind: 'zoom', delta: dy }
    }

    function Canvas(props) {
      const { t, root, index, folds, view, selected, editing, cut, actions } = props
      const viewportRef = useRef(null)
      const worldRef = useRef(null)
      const sizesRef = useRef(new Map())
      const guardRef = useRef(0)
      const [sizeTick, setSizeTick] = useState(0)
      const camRef = useRef({ x: 40, y: 30, s: 0.92 })
      const vpRef = useRef({ w: 0, h: 0 })
      const cameraFor = useRef(null)
      const pendingReveal = useRef(null)
      const gesture = useRef(null)
      const panMoved = useRef(false)
      const frame = useRef(0)
      const [menu, setMenu] = useState(null)
      const [forkForm, setForkForm] = useState(null)
      const live = useRef(props)
      live.current = props

      const measure = useCallback((id) => sizesRef.current.get(id) ?? estimate(index, id), [index])
      const result = useMemo(
        () => layout(root, { measure, folds, offsets: view.offsets, selected, index }),
        [root, folds, view.offsets, selected, index, measure, sizeTick],
      )
      const layoutRef = useRef(result)
      layoutRef.current = result

      function applyCam(glide) {
        const cam = camRef.current
        const world = worldRef.current
        const viewport = viewportRef.current
        if (world) {
          world.setAttribute('data-glide', glide ? '1' : '0')
          world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`
        }
        if (viewport) {
          // The dot grid moves with the world, so panning reads as moving the paper.
          viewport.style.backgroundPosition = `${cam.x}px ${cam.y}px`
          viewport.style.backgroundSize = `${22 * cam.s}px ${22 * cam.s}px`
        }
        live.current.onCamera?.(cam)
      }

      function setCam(next, glide) {
        camRef.current = { x: num(next.x, 0), y: num(next.y, 0), s: clamp(num(next.s, 1), ZOOM_MIN, ZOOM_MAX) }
        applyCam(glide)
      }

      /** `floor` keeps a first view readable: a tall walkthrough then starts at its top. */
      function fit(glide, floor) {
        const bounds = layoutRef.current.bounds
        const vp = vpRef.current
        if (!vp.w || !bounds) return
        const bw = Math.max(1, bounds.x1 - bounds.x0)
        const bh = Math.max(1, bounds.y1 - bounds.y0)
        const s = clamp(Math.min((vp.w - 80) / bw, (vp.h - 60) / bh, 1), floor ?? ZOOM_MIN, 1)
        setCam({ x: (vp.w - bw * s) / 2 - bounds.x0 * s, y: Math.max(30, (vp.h - bh * s) / 2) - bounds.y0 * s, s }, glide)
        if (floor === undefined) live.current.onCameraCommit?.()
      }

      function reveal(id, force) {
        const box = layoutRef.current.boxes[id]
        const vp = vpRef.current
        if (!box || !vp.w) return false
        const cam = camRef.current
        const margin = 48
        const sx = cam.x + box.x * cam.s
        const sy = cam.y + box.y * cam.s
        const sh = Math.min(box.h * cam.s, vp.h * 0.6)
        const inside = sx > margin && sy > margin && sx + box.w * cam.s < vp.w - margin && sy + sh < vp.h - margin
        if (!force && inside) return true
        setCam({ x: vp.w / 2 - (box.x + box.w / 2) * cam.s, y: vp.h * 0.42 - box.y * cam.s - sh / 2, s: cam.s }, true)
        live.current.onCameraCommit?.()
        return true
      }

      function zoomTo(scale) {
        const vp = vpRef.current
        const cam = camRef.current
        const s = clamp(scale, ZOOM_MIN, ZOOM_MAX)
        const mx = vp.w / 2
        const my = vp.h / 2
        setCam({ x: mx - (mx - cam.x) * (s / cam.s), y: my - (my - cam.y) * (s / cam.s), s }, true)
        live.current.onCameraCommit?.()
      }

      function screenOf(id) {
        const box = layoutRef.current.boxes[id]
        if (!box) return { x: vpRef.current.w / 2, y: vpRef.current.h / 2 }
        const cam = camRef.current
        return { x: cam.x + (box.x + Math.min(box.w, 180)) * cam.s, y: cam.y + (box.y + box.h / 2) * cam.s }
      }

      function openMenuFor(id, at) {
        const kind = id ? index.get(id)?.node.kind ?? 'canvas' : 'canvas'
        const point = at ?? (id ? screenOf(id) : { x: vpRef.current.w / 2, y: vpRef.current.h / 3 })
        setForkForm(null)
        setMenu({ x: point.x, y: point.y, id: id ?? null, kind })
      }

      const focusCanvas = () => viewportRef.current?.focus({ preventScroll: true })

      if (props.apiRef) {
        props.apiRef.current = {
          fit: () => fit(true),
          reveal: (id, force) => {
            pendingReveal.current = { id, force: force === true }
            setSizeTick((n) => n + 1)
          },
          zoomTo,
          focus: focusCanvas,
          camera: () => camRef.current,
          openMenu: (id) => openMenuFor(id),
          openFork: (id) => {
            const point = screenOf(id)
            setMenu(null)
            setForkForm({ x: point.x, y: point.y, id, question: index.get(id)?.node.question === true })
          },
        }
      }

      // Measure what was drawn; a change re-runs the layout before the browser paints.
      useLayoutEffectSafe(() => {
        const world = worldRef.current
        if (!world) return
        let changed = false
        for (const element of world.querySelectorAll('[data-measure]')) {
          const w = element.offsetWidth
          const hh = element.offsetHeight
          if (w === 0 && hh === 0) continue
          const id = element.getAttribute('data-measure')
          const known = sizesRef.current.get(id)
          if (!known || known.w !== w || known.h !== hh) {
            sizesRef.current.set(id, { w, h: hh })
            changed = true
          }
        }
        if (changed && guardRef.current < 6) {
          guardRef.current += 1
          setSizeTick((n) => n + 1)
          return
        }
        guardRef.current = 0
        if (cameraFor.current !== props.projectId && vpRef.current.w > 0 && root) {
          cameraFor.current = props.projectId
          const saved = props.initialCamera
          if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.s)) setCam(saved, false)
          else if (selected && layoutRef.current.boxes[selected]) {
            camRef.current = { ...camRef.current, s: 0.92 }
            reveal(selected, true)
          } else fit(false, 0.8)
        }
        if (pendingReveal.current && cameraFor.current === props.projectId) {
          const { id, force } = pendingReveal.current
          if (reveal(id, force) || !index.has(id)) pendingReveal.current = null
        }
      })

      // Content can change size without a render (fonts arriving): re-measure then.
      useEffect(() => {
        const world = worldRef.current
        if (!world || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame.current)
          frame.current = requestAnimationFrame(() => {
            for (const element of world.querySelectorAll('[data-measure]')) {
              const known = sizesRef.current.get(element.getAttribute('data-measure'))
              if (known && (known.w !== element.offsetWidth || known.h !== element.offsetHeight)) {
                setSizeTick((n) => n + 1)
                return
              }
            }
          })
        })
        const seen = new WeakSet()
        const sync = () => {
          for (const element of world.querySelectorAll('[data-measure]')) {
            if (!seen.has(element)) {
              seen.add(element)
              observer.observe(element)
            }
          }
        }
        sync()
        const mutations = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null
        mutations?.observe(world, { childList: true })
        return () => {
          observer.disconnect()
          mutations?.disconnect()
          cancelAnimationFrame(frame.current)
        }
      }, [])

      useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return undefined
        const update = () => {
          const rect = viewport.getBoundingClientRect()
          vpRef.current = { w: rect.width, h: rect.height }
          setSizeTick((n) => n + 1)
        }
        update()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(update)
        observer.observe(viewport)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return undefined
        const SCROLLERS = '.ml-md-pre, .ml-md-table, .ml-run-out, .ml-textarea, .ml-card-body'
        const onWheel = (event) => {
          if (event.target.closest?.('.ml-menu, .ml-form')) return
          // A short code block inside a long card body: the body is what should scroll.
          const boxes = []
          for (let box = event.target.closest?.(SCROLLERS); box && viewport.contains(box); box = box.parentElement?.closest(SCROLLERS)) boxes.push(box)
          const intent = wheelIntent(event, boxes, viewport.clientHeight)
          if (intent.kind === 'native') return
          event.preventDefault()
          if (intent.kind === 'hold') return
          const cam = camRef.current
          if (intent.kind === 'zoom') {
            const rect = viewport.getBoundingClientRect()
            const mx = event.clientX - rect.left
            const my = event.clientY - rect.top
            const s = clamp(cam.s * Math.exp(-intent.delta * 0.0015), ZOOM_MIN, ZOOM_MAX)
            setCam({ x: mx - (mx - cam.x) * (s / cam.s), y: my - (my - cam.y) * (s / cam.s), s }, false)
          } else setCam({ x: cam.x - intent.dx, y: cam.y, s: cam.s }, false)
          live.current.onCameraCommit?.()
        }
        viewport.addEventListener('wheel', onWheel, { passive: false })
        return () => viewport.removeEventListener('wheel', onWheel)
      }, [])

      useEffect(() => () => cancelAnimationFrame(frame.current), [])

      const onMove = useCallback((event) => {
        const current = gesture.current
        if (!current) return
        const dx = event.clientX - current.x
        const dy = event.clientY - current.y
        if (!current.moved && Math.hypot(dx, dy) < 4) return
        current.moved = true
        const viewport = viewportRef.current
        if (current.kind === 'pan') {
          viewport?.setAttribute('data-panning', '1')
          setCam({ x: current.cam.x + dx, y: current.cam.y + dy, s: current.cam.s }, false)
          return
        }
        viewport?.setAttribute('data-dragging', '1')
        const s = camRef.current.s
        current.next = { dx: round(current.base.dx + dx / s), dy: round(current.base.dy + dy / s) }
        if (!current.queued) {
          current.queued = true
          requestAnimationFrame(() => {
            current.queued = false
            if (current.next) live.current.actions.setOffset(current.id, current.next)
          })
        }
      }, [])

      const onUp = useCallback(() => {
        const current = gesture.current
        gesture.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        const viewport = viewportRef.current
        viewport?.setAttribute('data-panning', '0')
        viewport?.setAttribute('data-dragging', '0')
        if (!current || !current.moved) return
        if (current.kind === 'pan') {
          panMoved.current = true
          live.current.onCameraCommit?.()
        } else if (current.next) live.current.actions.setOffset(current.id, current.next)
      }, [])

      function onPointerDown(event) {
        if (event.button !== 0) return
        const target = event.target
        if (target.closest('.ml-menu, .ml-form')) return
        const element = target.closest('[data-node]')
        // Text in an open card stays selectable, and its buttons stay buttons.
        if (target.closest('button, a, input, textarea, select, label, .ml-md')) return
        focusCanvas()
        panMoved.current = false
        if (element && element.getAttribute('data-kind') !== 'project' && element.getAttribute('data-node') !== DRAFT_ID) {
          const id = element.getAttribute('data-node')
          const base = view.offsets?.[id] ?? { dx: 0, dy: 0 }
          gesture.current = { kind: 'drag', id, x: event.clientX, y: event.clientY, base: { dx: num(base.dx, 0), dy: num(base.dy, 0) }, moved: false }
        } else {
          gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, cam: { ...camRef.current }, moved: false }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      function onClick(event) {
        if (event.target.closest('[data-node], .ml-menu, .ml-form, .ml-canvas-empty')) return
        if (panMoved.current) {
          panMoved.current = false
          return
        }
        if (selected !== null) actions.select(null)
      }

      function onContextMenu(event) {
        if (event.target.closest('.ml-menu, .ml-form, input, textarea')) return
        event.preventDefault()
        const rect = viewportRef.current.getBoundingClientRect()
        const element = event.target.closest('[data-node]')
        const id = element ? element.getAttribute('data-node') : null
        if (id === DRAFT_ID) return
        if (id && id !== selected) actions.select(id)
        openMenuFor(id, { x: event.clientX - rect.left, y: event.clientY - rect.top })
      }

      function closeMenu(reason) {
        setMenu(null)
        // A click that only dismissed the menu must not also clear the selection.
        if (reason === 'outside') panMoved.current = true
        else focusCanvas()
      }

      function hop(id, dir) {
        const target = laneNeighbour(root, id, dir, folds)
        if (target) actions.select(target, { reveal: true })
      }

      function onKeyDown(event) {
        if (isTypingTarget(event.target) || composing(event)) return
        const key = event.key
        const mod = event.ctrlKey || event.metaKey
        const plain = !mod && !event.altKey
        const handled = () => {
          event.preventDefault()
          event.stopPropagation()
        }
        if (key === 'Escape') {
          if (menu || forkForm) {
            setMenu(null)
            setForkForm(null)
          } else if (cut) actions.cut(null)
          else if (selected) actions.select(null)
          else return
          handled()
          return
        }
        if (key === 'Tab' && !mod && !event.altKey) {
          if (event.shiftKey) actions.cycleGlobal()
          else if (selected && selected !== DRAFT_ID) actions.cycleFold(selected)
          else return
          handled()
          return
        }
        if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
          openMenuFor(selected && selected !== DRAFT_ID ? selected : null)
          handled()
          return
        }
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          const dir = key === 'ArrowUp' ? -1 : 1
          if (event.altKey) {
            if (selected) actions.reorder(selected, dir)
          } else {
            const order = layoutRef.current.order
            const at = order.indexOf(selected)
            const next = at === -1 ? order[0] : order[at + dir]
            if (next) actions.select(next, { reveal: true })
          }
          handled()
          return
        }
        if ((key === 'ArrowLeft' || key === 'ArrowRight') && plain) {
          if (selected) hop(selected, key === 'ArrowLeft' ? -1 : 1)
          handled()
          return
        }
        // Always claimed: Alt+← is also the browser's Back, which would leave the panel.
        if ((key === 'ArrowLeft' || key === 'ArrowRight') && event.altKey && !mod) {
          if (selected && selected !== DRAFT_ID) actions.indent(selected, key === 'ArrowLeft' ? -1 : 1)
          handled()
          return
        }
        if (key === 'Enter' && !event.altKey) {
          if (!selected || selected === DRAFT_ID) return
          if (mod) actions.addNext(selected)
          else actions.startRename(selected)
          handled()
          return
        }
        if (key === 'Delete' && plain) {
          if (selected) actions.remove(selected)
          handled()
          return
        }
        if (mod && !event.altKey && (key === 'x' || key === 'X')) {
          if (!selected) return
          actions.cut(selected)
          handled()
          return
        }
        if (mod && !event.altKey && (key === 'v' || key === 'V')) {
          if (!selected) return
          actions.paste(selected, event.shiftKey)
          handled()
          return
        }
        if (plain && (key === 'r' || key === 'R')) {
          if (event.shiftKey) actions.resetAll()
          else if (selected) actions.resetOffset(selected)
          handled()
          return
        }
        if (plain && (key === 'f' || key === 'F')) {
          fit(true)
          handled()
        }
      }

      function menuItems(current) {
        const entry = current.id ? index.get(current.id) : null
        const node = entry?.node
        const moved = (id) => Boolean(view.offsets?.[id])
        if (!node) {
          return [
            { key: 'branch', label: t('menu.branch'), onSelect: () => actions.addBranch(root.id) },
            { key: 'append', label: t('menu.appendMain'), onSelect: () => actions.addChild(root.id) },
            'sep',
            { key: 'fold', label: t('menu.foldAll'), onSelect: actions.foldAll },
            { key: 'unfold', label: t('menu.unfoldAll'), onSelect: actions.unfoldAll },
            { key: 'fit', label: t('menu.fit'), hint: 'F', onSelect: () => fit(true) },
            { key: 'resetAll', label: t('menu.resetAll'), hint: 'Shift+R', disabled: Object.keys(view.offsets ?? {}).length === 0, onSelect: actions.resetAll },
          ]
        }
        if (node.kind === 'lane') {
          return [
            { key: 'rename', label: t('menu.rename'), hint: 'Enter', onSelect: () => actions.startRename(node.id) },
            { key: 'laneStep', label: t('menu.laneStep'), onSelect: () => actions.addChild(node.id) },
            { key: 'addLane', label: t('menu.addLane'), onSelect: () => actions.addLane(entry.parent.id) },
            { key: 'branch', label: t('menu.branchLane'), onSelect: () => actions.addBranch(node.id) },
            'sep',
            { key: 'reset', label: t('menu.resetPos'), hint: 'R', disabled: !moved(node.id), onSelect: () => actions.resetOffset(node.id) },
            { key: 'removeLane', label: t('menu.removeLane'), hint: 'Del', danger: true, onSelect: () => actions.remove(node.id) },
          ]
        }
        if (node.kind === 'fork') {
          return [
            { key: 'rename', label: t('menu.rename'), hint: 'Enter', onSelect: () => actions.startRename(node.id) },
            { key: 'addLane', label: t('menu.addLane'), onSelect: () => actions.addLane(node.id) },
            'sep',
            { key: 'reset', label: t('menu.resetPos'), hint: 'R', disabled: !moved(node.id), onSelect: () => actions.resetOffset(node.id) },
            { key: 'removeFork', label: t('menu.removeFork'), hint: 'Del', danger: true, onSelect: () => actions.remove(node.id) },
          ]
        }
        const project = node.kind === 'project'
        const pasteOff = !cut || cut === node.id
        // Under a card, a new step is either parallel to its line (a split, at once) or the line's
        // end — the same two on the project card as on any step.
        return [
          project ? null : { key: 'next', label: t('menu.addNext'), hint: 'Ctrl+Enter', onSelect: () => actions.addNext(node.id) },
          project ? null : { key: 'fork', label: t('menu.fork'), onSelect: () => setForkForm({ x: current.x, y: current.y, id: node.id, question: node.question === true }) },
          { key: 'branch', label: t('menu.branch'), hint: project ? 'Ctrl+Enter' : undefined, onSelect: () => actions.addBranch(node.id) },
          { key: 'child', label: project ? t('menu.appendMain') : t('menu.addChild'), onSelect: () => actions.addChild(node.id) },
          { key: 'ref', label: t('menu.addRef'), onSelect: () => actions.addRef(node.id) },
          'sep',
          { key: 'todo', label: t('state.todo'), checked: node.state === 'todo', onSelect: () => actions.setState(node.id, 'todo') },
          { key: 'halt', label: t('state.halt'), checked: node.state === 'halt', onSelect: () => actions.setState(node.id, 'halt') },
          { key: 'none', label: t('state.none'), checked: !node.state, onSelect: () => actions.setState(node.id, '') },
          project ? null : { key: 'q', label: node.question ? t('question.off') : t('question.on'), onSelect: () => actions.toggleQuestion(node.id) },
          'sep',
          { key: 'ask', label: t('menu.ask'), onSelect: () => actions.ask(node.id) },
          'sep',
          project ? null : { key: 'cut', label: t('menu.cut'), hint: 'Ctrl+X', onSelect: () => actions.cut(node.id) },
          { key: 'pasteNext', label: t('menu.pasteNext'), hint: 'Ctrl+V', disabled: pasteOff, onSelect: () => actions.paste(node.id, false) },
          { key: 'pasteChild', label: t('menu.pasteChild'), hint: 'Ctrl+Shift+V', disabled: pasteOff, onSelect: () => actions.paste(node.id, true) },
          project ? null : 'sep',
          project ? null : { key: 'reset', label: t('menu.resetPos'), hint: 'R', disabled: !moved(node.id), onSelect: () => actions.resetOffset(node.id) },
          project ? null : { key: 'remove', label: t('menu.remove'), hint: 'Del', danger: true, onSelect: () => actions.remove(node.id) },
        ].filter((item) => item !== null)
      }

      function renderItem(id, box) {
        const entry = index.get(id)
        if (!entry) return null
        const node = entry.node
        const fold = folds.get(id) ?? { lineShown: false, bodyShown: false }
        const common = { key: id, node, x: box.x, y: box.y, t, actions, selected: id === selected, editing: editing?.id === id, cut: cut === id }
        if (box.kind === 'lane') return h(LaneMemo, { ...common, live: isLive(node), lineShown: fold.lineShown })
        if (box.kind === 'fork') return h(ForkLabel, common)
        return h(CardMemo, {
          ...common,
          bodyShown: fold.bodyShown,
          lineShown: fold.lineShown,
          fresh: props.fresh?.has(id) === true,
          fences: props.fences,
          runsKey: props.runs?.[id],
        })
      }

      const boxes = Object.entries(result.boxes)
      const hot = result.edges.filter((edge) => edge.hot)
      const cold = result.edges.filter((edge) => !edge.hot)
      return h(
        'div',
        {
          ref: viewportRef,
          className: 'ml-canvas',
          tabIndex: 0,
          role: 'application',
          'aria-roledescription': props.t('canvas.label'),
          'aria-label': t('canvas.label'),
          'data-panning': '0',
          'data-dragging': '0',
          onPointerDown,
          onClick,
          onContextMenu,
          onKeyDown,
        },
        h(
          'div',
          { ref: worldRef, className: 'ml-world', 'data-glide': '0' },
          h(
            'svg',
            { className: 'ml-edges', width: 1, height: 1, 'aria-hidden': 'true' },
            result.frames.map((box) => h('rect', { key: `f${box.id}`, className: 'ml-frame', 'data-hot': box.hot ? '1' : '0', x: box.x, y: box.y, width: box.w, height: box.h, rx: 14 })),
            cold.map((edge, at) => h('path', { key: `e${at}`, className: 'ml-edge', 'data-live': edge.live ? '1' : '0', d: edge.d })),
            hot.map((edge, at) => h('path', { key: `h${at}`, className: 'ml-edge', 'data-hot': '1', d: edge.d })),
          ),
          boxes.map(([id, box]) => renderItem(id, box)),
        ),
        root && lineOf(root).length === 0 ? h('div', { className: 'ml-canvas-empty' }, t('canvas.empty')) : null,
        menu
          ? h(ContextMenu, {
              x: menu.x,
              y: menu.y,
              bounds: vpRef.current,
              label: t('menu.label'),
              items: menuItems(menu),
              onClose: (activated, reason) => closeMenu(reason),
            })
          : null,
        forkForm
          ? h(ForkForm, {
              t,
              x: forkForm.x,
              y: forkForm.y,
              question: forkForm.question,
              bounds: vpRef.current,
              onCancel: () => {
                setForkForm(null)
                focusCanvas()
              },
              onSubmit: (names, title) => {
                const id = forkForm.id
                setForkForm(null)
                focusCanvas()
                actions.forkFrom(id, names, title)
              },
            })
          : null,
        h('div', { className: 'ml-sr', 'aria-live': 'polite' }, selected && selected !== DRAFT_ID ? t('canvas.selected', { where: props.whereOf(selected) }) : ''),
      )
    }

    // ------------------------------------------------------------------ detail column

    /**
     * Raw Markdown editor: Ctrl+Enter or leaving saves, Esc cancels. IME-safe. With `grow` (a px
     * cap) it is as tall as its wrapped text, so it never shows less than the body it replaces.
     */
    function BodyEditor(props) {
      const [value, setValue] = useState(props.initial ?? '')
      const ref = useRef(null)
      const finished = useRef(false)
      useEffect(() => {
        const area = ref.current
        if (area) {
          area.focus({ preventScroll: true })
          area.setSelectionRange(area.value.length, area.value.length)
        }
      }, [])
      useLayoutEffectSafe(() => {
        const area = ref.current
        if (!area || !props.grow) return
        area.style.height = 'auto'
        // border-box: scrollHeight leaves out the 1 px border on each side.
        area.style.height = `${Math.min(area.scrollHeight + 2, props.grow)}px`
      }, [value])
      const finish = (save, viaKey) => {
        if (finished.current) return
        finished.current = true
        props.onDone(save ? value : null, viaKey)
      }
      return h(
        'div',
        { className: 'ml-editor' },
        h('textarea', {
          ref,
          className: 'ml-textarea',
          value,
          rows: props.grow ? 1 : clamp(value.split('\n').length + 1, 4, 22),
          spellCheck: false,
          'aria-label': props.label,
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            event.stopPropagation()
            if (composing(event)) return
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              finish(true, true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              finish(false, true)
            }
          },
          onBlur: () => finish(true, false),
        }),
        h('div', { className: 'ml-hint' }, props.t('detail.editHint')),
      )
    }

    function RefItem(props) {
      const { node, t, actions, openRefs } = props
      const open = openRefs.has(node.id)
      const [mode, setMode] = useState(null)
      const kids = childrenOf(node)
      const iconButton = (name, label, onClick, extra) =>
        h('button', { type: 'button', className: 'ml-icon', title: label, 'aria-label': label, onClick, ...(extra ?? {}) }, h(Icon, { name, size: 12 }))
      return h(
        'div',
        { className: 'ml-ref', 'data-open': open ? '1' : '0' },
        h(
          'div',
          { className: 'ml-ref-head' },
          h(
            'button',
            { type: 'button', className: 'ml-ref-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-label': t('ref.toggle'), onClick: () => actions.toggleRef(node.id) },
            h(Icon, { name: open ? 'down' : 'right', size: 11 }),
          ),
          mode === 'rename'
            ? h(TitleInput, {
                initial: node.title,
                label: t('ref.rename'),
                onDone: (value) => {
                  setMode(null)
                  if (value !== null) actions.renameNode(node.id, value)
                },
              })
            : h('span', { className: 'ml-ref-title', onClick: () => actions.toggleRef(node.id), onDoubleClick: () => setMode('rename') }, node.title),
          h(
            'span',
            { className: 'ml-ref-actions' },
            iconButton('edit', t('ref.rename'), () => setMode('rename')),
            iconButton('plus', t('ref.add'), () => {
              if (!open) actions.toggleRef(node.id)
              setMode('add')
            }),
            iconButton('trash', t('ref.remove'), () => actions.remove(node.id), { className: 'ml-icon ml-icon-danger' }),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'ml-ref-body' },
              mode === 'body'
                ? h(BodyEditor, {
                    t,
                    initial: node.body,
                    label: node.title,
                    onDone: (value) => {
                      setMode(null)
                      if (value !== null) actions.saveBody(node.id, value)
                    },
                  })
                : node.body
                  ? h('div', { onDoubleClick: (event) => !event.target.closest('a, button, input') && setMode('body') }, h(Markdown, { text: node.body, nodeId: node.id, fences: props.fences, t, onToggleTask: (at) => actions.saveBody(node.id, toggleTask(node.body, at)) }))
                  : kids.length === 0
                    ? h('div', { className: 'ml-muted' }, t('ref.empty'))
                    : null,
              mode !== 'body' ? h('button', { type: 'button', className: 'ml-link ml-ref-edit', onClick: () => setMode('body') }, t('ref.edit')) : null,
              mode === 'add'
                ? h(TitleInput, {
                    initial: '',
                    placeholder: t('detail.refPlaceholder'),
                    onDone: (value) => {
                      setMode(null)
                      if (value && value.trim()) actions.createRef(node.id, value)
                    },
                  })
                : null,
              kids.length > 0 ? h('div', { className: 'ml-ref-kids' }, kids.map((child) => h(RefItem, { ...props, key: child.id, node: child }))) : null,
            )
          : null,
      )
    }

    function crumbLabel(node, t) {
      if (node.kind === 'project') return shortTitle(node.title)
      if (node.kind === 'fork') return node.title ? clip(node.title, 16) : t('fork.untitled')
      return clip(node.title || t('card.untitled'), 18)
    }

    function Detail(props) {
      const { t, root, index, nodeId, actions } = props
      const entry = nodeId && nodeId !== DRAFT_ID ? index.get(nodeId) : null
      const [editingBody, setEditingBody] = useState(false)
      const [renaming, setRenaming] = useState(false)
      const [adding, setAdding] = useState(false)
      const [confirmRemove, setConfirmRemove] = useState(false)
      useEffect(() => {
        setEditingBody(false)
        setRenaming(false)
        setAdding(false)
        setConfirmRemove(false)
      }, [nodeId])
      useEffect(() => {
        if (props.refAdd && props.refAdd.id === nodeId) setAdding(true)
      }, [props.refAdd])
      if (!root) return null
      if (!entry) {
        return h(
          'div',
          { className: 'ml-detail-empty' },
          t('detail.none', { project: shortTitle(root.title) }),
          ' ',
          h('button', { type: 'button', className: 'ml-link', onClick: () => actions.select(root.id, { reveal: true }) }, t('detail.selectProject')),
        )
      }
      const node = entry.node
      const stateful = node.kind === 'project' || node.kind === 'step'
      const refs = refsOf(node)
      const parentLine = entry.parent ? lineOf(entry.parent) : []
      const stepNo = node.kind === 'step' ? parentLine.indexOf(node) + 1 : 0
      const stateButton = (value, key) =>
        h(
          'button',
          { type: 'button', role: 'radio', 'aria-checked': (node.state || '') === value ? 'true' : 'false', onClick: () => actions.setState(node.id, value) },
          t(key),
        )
      return h(
        'div',
        { className: 'ml-detail-inner' },
        h(
          'nav',
          { className: 'ml-crumbs', 'aria-label': t('detail.path') },
          // An unnamed fork or lane is only a split: no crumb, the same as lib/tree.js describePath.
          entry.path.filter((ancestor) => !((ancestor.kind === 'fork' || ancestor.kind === 'lane') && !ancestor.title)).map((ancestor) =>
            h(
              React.Fragment,
              { key: ancestor.id },
              h('button', { type: 'button', className: 'ml-crumb', title: ancestor.title, onClick: () => actions.select(ancestor.id, { reveal: true }) }, crumbLabel(ancestor, t)),
              h('span', { className: 'ml-crumb-sep', 'aria-hidden': 'true' }, '›'),
            ),
          ),
          h('span', { className: 'ml-crumb ml-crumb-here', 'aria-current': 'location' }, crumbLabel(node, t), stepNo > 0 ? t('detail.stepNo', { n: stepNo }) : node.kind === 'ref' ? t('detail.isRef') : ''),
        ),
        renaming
          ? h(TitleInput, {
              initial: node.title,
              className: 'ml-detail-title-input',
              onDone: (value) => {
                setRenaming(false)
                if (value !== null) actions.renameNode(node.id, value)
              },
            })
          : h(
              'h2',
              { className: 'ml-detail-title', title: t('detail.rename'), onDoubleClick: () => setRenaming(true) },
              node.question ? h('span', { className: 'ml-q' }, '?') : null,
              node.title || t('card.untitled'),
            ),
        h(
          'div',
          { className: 'ml-controls' },
          stateful
            ? h('span', { className: 'ml-seg', role: 'radiogroup', 'aria-label': t('state.label') }, stateButton('', 'state.none'), stateButton('todo', 'state.todo'), stateButton('halt', 'state.halt'))
            : null,
          node.kind === 'step'
            ? h('button', { type: 'button', className: 'ml-mini', 'aria-pressed': node.question ? 'true' : 'false', onClick: () => actions.toggleQuestion(node.id) }, '? ', t('question.toggle'))
            : null,
          node.kind !== 'ref' ? h('button', { type: 'button', className: 'ml-mini', onClick: () => actions.ask(node.id) }, h(Icon, { name: 'spark', size: 11 }), t('detail.ask')) : null,
          h('span', { className: 'ml-grow' }),
          editingBody ? null : h('button', { type: 'button', className: 'ml-mini', onClick: () => setEditingBody(true) }, h(Icon, { name: 'edit', size: 11 }), t('detail.edit')),
        ),
        editingBody
          ? h(BodyEditor, {
              t,
              initial: node.body,
              label: node.title,
              onDone: (value) => {
                setEditingBody(false)
                if (value !== null) actions.saveBody(node.id, value)
              },
            })
          : node.body
            ? h(
                'div',
                { className: 'ml-detail-body', onDoubleClick: (event) => !event.target.closest('a, button, input, pre') && setEditingBody(true) },
                h(Markdown, { text: node.body, nodeId: node.id, fences: props.fences, t, onToggleTask: (at) => actions.saveBody(node.id, toggleTask(node.body, at)) }),
              )
            : h('button', { type: 'button', className: 'ml-detail-placeholder', onClick: () => setEditingBody(true) }, t('detail.emptyBody')),
        node.kind === 'project'
          ? h(
              'label',
              { className: 'ml-field' },
              h('span', null, t('detail.cwd')),
              h('input', {
                key: `${node.id}:${node.attrs?.cwd ?? ''}`,
                className: 'ml-input ml-mono',
                defaultValue: node.attrs?.cwd ?? '',
                placeholder: t('detail.cwdPlaceholder'),
                spellCheck: false,
                onKeyDown: (event) => {
                  event.stopPropagation()
                  if (composing(event)) return
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    event.currentTarget.value = node.attrs?.cwd ?? ''
                    event.currentTarget.blur()
                  }
                },
                onBlur: (event) => actions.setCwd(event.currentTarget.value),
              }),
            )
          : null,
        h(
          'div',
          { className: 'ml-refs-head' },
          h('b', null, t('detail.refs')),
          h('span', null, refs.length > 0 ? refs.length : t('detail.refsNone')),
          h('button', { type: 'button', className: 'ml-mini', onClick: () => setAdding(true) }, h(Icon, { name: 'plus', size: 11 }), t('detail.addRef')),
        ),
        adding
          ? h(TitleInput, {
              key: `add:${props.refAdd?.seq ?? 0}`,
              initial: '',
              placeholder: t('detail.refPlaceholder'),
              onDone: (value) => {
                setAdding(false)
                if (value && value.trim()) actions.createRef(node.id, value)
              },
            })
          : null,
        refs.map((ref) => h(RefItem, { key: ref.id, node: ref, t, actions, openRefs: props.openRefs, fences: props.fences })),
        node.kind === 'project'
          ? h(
              'div',
              { className: 'ml-danger-zone' },
              confirmRemove
                ? h(
                    React.Fragment,
                    null,
                    h('button', { type: 'button', className: 'ml-btn ml-btn-danger', onClick: () => actions.removeProject(node.id) }, t('detail.removeProjectConfirm')),
                    h('button', { type: 'button', className: 'ml-btn', onClick: () => setConfirmRemove(false) }, t('common.cancel')),
                  )
                : h('button', { type: 'button', className: 'ml-link ml-link-danger', onClick: () => setConfirmRemove(true) }, t('detail.removeProject')),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ conversation

    /** The chat view pinned inside the embedded conversation, so it cannot wander into another view. */
    function PinnedChatView(props) {
      return h(React.Fragment, null, typeof props.renderSlot === 'function' ? props.renderSlot('conversation.session', { view: 'chat' }) : null)
    }

    /**
     * The conversation as the Host's own `conversation.content` factory renders it:
     * transcript, streaming, the real composer, native tool cards. The phase mapping is
     * the subagent sidebar chat's (`engaging` folds into `active`). A Host without the
     * factory renders `fallback` instead — never a hand-rolled chat.
     */
    function ChatConversation(props) {
      let phase = 'active'
      let hero = false
      try {
        const session = typeof props.useSession === 'function' ? props.useSession((value) => value) : null
        const hasTurns = session?.blank !== true && session?.awaitingFirstTurn !== true
        const blank = session?.running !== true && !hasTurns && session?.promptAttempted !== true
        if (blank === true) {
          const settling = session?.openState === 'loading'
          phase = settling ? 'settling' : 'hero'
          hero = !settling
        }
      } catch {
        /* a snapshot that cannot be read still deserves a room */
      }
      if (typeof props.renderFactorySlot !== 'function') return props.fallback ?? null
      return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: { views: PinnedChatView }, fallback: props.fallback })
    }

    /**
     * Retain the session while the embed is mounted and hand it to the session-scoped
     * child slot inside a SessionProvider. Without the standard props (a lean Host, the
     * dev harness) the effect is a no-op and the fallback renders.
     */
    function ChatEmbed(props) {
      const [reference, setReference] = useState(null)
      const liveRef = useRef(null)
      useEffect(() => {
        if (
          typeof props.SessionProvider !== 'function' ||
          typeof props.renderSlot !== 'function' ||
          typeof props.ctx?.sessions?.retain !== 'function' ||
          typeof props.sessionId !== 'string' ||
          props.sessionId === ''
        ) {
          return undefined
        }
        let hold = null
        try {
          hold = props.ctx.sessions.retain(props.sessionId, { source: 'mainlineChat' })
        } catch {
          return undefined
        }
        liveRef.current = hold
        setReference(hold)
        return () => {
          liveRef.current = null
          setReference(null)
          try {
            hold.release()
          } catch {
            /* a dead reference must not take the room with it */
          }
        }
      }, [props.sessionId])
      if (reference === null || liveRef.current !== reference) return props.fallback
      return h('div', { className: 'ml-chat-embed' }, h(props.SessionProvider, { session: reference }, props.renderSlot(CHAT_SLOT, { fallback: props.fallback })))
    }

    function Conversation(props) {
      const { t, ctx, session, error } = props
      const [confirm, setConfirm] = useState(false)
      const id = typeof session?.sessionId === 'string' ? session.sessionId : ''
      const canOpen = id !== '' && typeof ctx?.uiWorkspace?.openSession === 'function'
      const open = () => {
        try {
          ctx.uiWorkspace.openSession(id)
        } catch {
          /* the sidebar still has it */
        }
      }
      const fallback = h(
        'div',
        { className: 'ml-chat-fallback' },
        h('p', null, error ? t('chat.unavailable', { message: error.message }) : id ? t('chat.fallback') : t('chat.loading')),
        canOpen ? h('button', { type: 'button', className: 'ml-btn', onClick: open }, h(Icon, { name: 'open', size: 12 }), t('chat.openInApp')) : null,
      )
      return h(
        'section',
        { className: 'ml-chat', 'aria-label': t('chat.title') },
        h(
          'div',
          { className: 'ml-chat-head' },
          h('b', null, t('chat.title')),
          session?.cwd ? h('span', { className: 'ml-chat-cwd', title: session.cwd }, session.cwd) : null,
          h('span', { className: 'ml-grow' }),
          canOpen ? h('button', { type: 'button', className: 'ml-icon', title: t('chat.openInApp'), 'aria-label': t('chat.openInApp'), onClick: open }, h(Icon, { name: 'open', size: 13 })) : null,
          confirm
            ? h(
                'span',
                { className: 'ml-confirm' },
                h('span', null, t('chat.resetConfirm')),
                h('button', { type: 'button', className: 'ml-btn ml-btn-strong', onClick: () => (setConfirm(false), props.onReset()) }, t('common.confirm')),
                h('button', { type: 'button', className: 'ml-btn', onClick: () => setConfirm(false) }, t('common.cancel')),
              )
            : h('button', { type: 'button', className: 'ml-icon', title: t('chat.reset'), 'aria-label': t('chat.reset'), disabled: !id, onClick: () => setConfirm(true) }, h(Icon, { name: 'reset', size: 13 })),
        ),
        h('div', { className: 'ml-chat-body' }, id ? h(ChatEmbed, { ctx, sessionId: id, SessionProvider: props.SessionProvider, renderSlot: props.renderSlot, fallback }) : fallback),
      )
    }

    // ------------------------------------------------------------------ top bar

    /** A tiny external store, so the zoom label updates without re-rendering the canvas. */
    function createValue(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (next === value) return
          value = next
          for (const listener of listeners) listener(value)
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function ZoomLabel(props) {
      const [value, setValue] = useState(props.store.get())
      useEffect(() => props.store.subscribe(setValue), [props.store])
      return h('button', { type: 'button', className: 'ml-zoom', title: props.title, onClick: props.onClick }, `${Math.round(value * 100)}%`)
    }

    function absoluteTime(at) {
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function HistoryPopover(props) {
      const { t } = props
      const [state, setState] = useState({ loading: true, commits: [], error: null })
      const [confirm, setConfirm] = useState(null)
      const ref = useRef(null)
      const closeRef = useRef(props.onClose)
      closeRef.current = props.onClose
      useEffect(() => {
        let cancelled = false
        call('history', { query: { project: props.projectId, limit: '30' } })
          .then((data) => !cancelled && setState({ loading: false, commits: Array.isArray(data?.commits) ? data.commits : [], error: null }))
          .catch((error) => !cancelled && setState({ loading: false, commits: [], error }))
        return () => {
          cancelled = true
        }
      }, [props.projectId])
      useEffect(() => {
        const onDown = (event) => {
          if (ref.current && !ref.current.contains(event.target) && !event.target.closest?.('[data-history-toggle]')) closeRef.current()
        }
        window.addEventListener('pointerdown', onDown, true)
        return () => window.removeEventListener('pointerdown', onDown, true)
      }, [])
      return h(
        'div',
        { ref, className: 'ml-pop ml-history', role: 'dialog', 'aria-label': t('history.title'), onKeyDown: (event) => event.key === 'Escape' && props.onClose() },
        state.loading ? h('div', { className: 'ml-muted' }, t('loading')) : null,
        state.error ? h('div', { className: 'ml-error' }, t('history.unavailable', { message: state.error.message })) : null,
        !state.loading && !state.error && state.commits.length === 0 ? h('div', { className: 'ml-muted' }, t('history.empty')) : null,
        state.commits.map((commit) =>
          h(
            'div',
            { key: commit.rev, className: 'ml-commit' },
            h('code', { className: 'ml-commit-rev' }, commit.short ?? String(commit.rev ?? '').slice(0, 7)),
            h('span', { className: 'ml-commit-msg', title: commit.message }, commit.message),
            h('span', { className: 'ml-commit-meta' }, `${absoluteTime(commit.at)}${commit.author ? ` · ${commit.author}` : ''}`),
            confirm === commit.rev
              ? h('button', { type: 'button', className: 'ml-btn ml-btn-strong', onClick: () => (props.onRestore(commit.rev, commit.short), props.onClose()) }, t('history.restoreConfirm'))
              : h('button', { type: 'button', className: 'ml-link', onClick: () => setConfirm(commit.rev) }, t('history.restore')),
          ),
        ),
      )
    }

    function Bar(props) {
      const { t, projects, openId } = props
      const [creating, setCreating] = useState(false)
      return h(
        'div',
        { className: 'ml-bar' },
        h(
          'div',
          { className: 'ml-tabs', role: 'tablist', 'aria-label': t('tabs.label') },
          (projects ?? []).map((project) =>
            h(
              'button',
              {
                key: project.id,
                type: 'button',
                role: 'tab',
                className: 'ml-tab',
                'aria-selected': project.id === openId ? 'true' : 'false',
                'data-dead': project.state === 'halt' || !(project.todo > 0) ? '1' : '0',
                title: project.title,
                onClick: () => props.onOpen(project.id),
              },
              shortTitle(project.title),
              project.todo > 0 ? h('span', { className: 'ml-tab-n' }, project.todo) : null,
            ),
          ),
          creating
            ? h(TitleInput, {
                initial: '',
                className: 'ml-tab-input',
                placeholder: t('tabs.newPlaceholder'),
                onDone: (value) => {
                  setCreating(false)
                  if (value && value.trim()) props.onCreate(value.trim())
                },
              })
            : h('button', { type: 'button', className: 'ml-tab ml-tab-new', onClick: () => setCreating(true) }, h(Icon, { name: 'plus', size: 12 }), t('tabs.new')),
        ),
        h(
          'div',
          { className: 'ml-bar-tools' },
          h(
            'button',
            { type: 'button', className: 'ml-btn', 'data-history-toggle': '1', 'aria-expanded': props.historyOpen ? 'true' : 'false', disabled: !openId, onClick: () => props.setHistoryOpen(!props.historyOpen) },
            h(Icon, { name: 'history', size: 12 }),
            t('bar.history'),
            h(Icon, { name: 'down', size: 10 }),
          ),
          h(
            'button',
            { type: 'button', className: 'ml-btn', 'data-view-cycle': '1', disabled: !openId, title: t('bar.view.title'), onClick: props.onView },
            h(Icon, { name: 'levels', size: 12 }),
            t(`bar.view.${props.viewMode ?? 'mixed'}`),
          ),
          h('button', { type: 'button', className: 'ml-btn', disabled: !props.canHome, onClick: props.onHome }, h(Icon, { name: 'target', size: 12 }), t('bar.home')),
          h('button', { type: 'button', className: 'ml-btn', disabled: !openId, onClick: props.onFit }, h(Icon, { name: 'fit', size: 12 }), t('bar.fit')),
          h(ZoomLabel, { store: props.zoom, title: t('bar.zoomReset'), onClick: props.onZoomReset }),
          props.historyOpen && openId ? h(HistoryPopover, { t, projectId: openId, onClose: () => props.setHistoryOpen(false), onRestore: props.onRestore }) : null,
        ),
      )
    }

    // ------------------------------------------------------------------ panel

    const BLANK_VIEW = Object.freeze({ fold: {}, offsets: {}, camera: null, selected: null })

    function normalizeView(raw) {
      const view = raw && typeof raw === 'object' ? raw : {}
      const fold = {}
      for (const [id, state] of Object.entries(view.fold ?? {})) if (FOLD_STATES.includes(state)) fold[id] = state
      const offsets = {}
      for (const [id, offset] of Object.entries(view.offsets ?? {})) {
        const dx = num(offset?.dx, 0)
        const dy = num(offset?.dy, 0)
        if (dx !== 0 || dy !== 0) offsets[id] = { dx, dy }
      }
      const camera = view.camera && Number.isFinite(view.camera.x) && Number.isFinite(view.camera.y) && Number.isFinite(view.camera.s) ? view.camera : null
      return { fold, offsets, camera, selected: typeof view.selected === 'string' ? view.selected : null }
    }

    /** Hash-driven start states for the dev harness (`tools/dev-server.mjs`); absent in the Host. */
    function devState() {
      try {
        const dev = typeof window !== 'undefined' ? window.__mainlineDev : null
        return dev && typeof dev === 'object' ? dev : null
      } catch {
        return null
      }
    }

    let toastSeq = 0

    function Panel(props) {
      const { ctx, lang } = props
      const t = useCallback((key, params) => translate(lang, key, params), [lang])
      const [projects, setProjects] = useState(null)
      const [listError, setListError] = useState(null)
      const [openId, setOpenId] = useState(() => devState()?.project ?? readLocal(OPEN_KEY))
      const [project, setProject] = useState(null)
      const [projectError, setProjectError] = useState(null)
      const [reloadSeq, setReloadSeq] = useState(0)
      const [view, setView] = useState(BLANK_VIEW)
      const [selected, setSelected] = useState(null)
      const [editing, setEditing] = useState(null)
      const [cut, setCut] = useState(null)
      const [toasts, setToasts] = useState([])
      const [runs, setRuns] = useState({})
      const [session, setSession] = useState(null)
      const [sessionError, setSessionError] = useState(null)
      const [openRefs, setOpenRefs] = useState(() => new Set())
      const [refAdd, setRefAdd] = useState(null)
      const [fresh, setFresh] = useState(() => new Set())
      const [historyOpen, setHistoryOpen] = useState(false)
      const [sideWidth, setSideWidth] = useState(() => readNumber(SIDE_KEY, SIDE_DEFAULT))
      const [detailHeight, setDetailHeight] = useState(() => readNumber(DETAIL_KEY, null))
      const rootRef = useRef(null)
      const sideRef = useRef(null)
      const detailRef = useRef(null)
      const canvasApi = useRef(null)
      const zoom = useMemo(() => createValue(0.92), [])
      const timers = useRef({})
      const pendingSave = useRef(false)
      const viewLoaded = useRef(null)
      const seenEvents = useRef(new Set())
      const fetchedRuns = useRef(new Set())
      const devApplied = useRef(false)
      const latest = useRef({})
      latest.current = { project, view, selected, editing, cut, openId, projects, runs, session, t }
      // org's last-command rule: Tab and Shift+Tab carry a cycle on only when pressed one right
      // after the other. Any other key or a click in between starts over; dragging and zooming do not.
      const foldRun = useRef(null)
      useEffect(() => {
        let down = null
        const onKey = (event) => {
          if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
          if (event.key === 'Tab' && !isTypingTarget(event.target)) return
          foldRun.current = null
        }
        const onDown = (event) => {
          down = { x: event.clientX, y: event.clientY }
        }
        const onUp = (event) => {
          if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4) foldRun.current = null
          down = null
        }
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('pointerup', onUp, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('pointerup', onUp, true)
        }
      }, [])

      const root = project?.root ?? null
      const displayRoot = useMemo(() => (editing?.draft ? withDraft(root, editing.draft) : root), [root, editing])
      const index = useMemo(() => indexTree(displayRoot), [displayRoot])
      const folds = useMemo(() => computeFolds(displayRoot, view.fold), [displayRoot, view.fold])
      const viewMode = useMemo(() => globalModeOf(root, view.fold), [root, view.fold])

      const later = (key, ms, fn) => {
        clearTimeout(timers.current[key])
        timers.current[key] = setTimeout(fn, ms)
      }

      const dismiss = useCallback((id) => setToasts((list) => list.filter((toast) => toast.id !== id)), [])
      const pushToast = (toast) => {
        toastSeq += 1
        const id = toastSeq
        const ttl = toast.ttl ?? (toast.kind === 'error' ? 7000 : toast.kind === 'undo' ? UNDO_MS : 3200)
        // A toast with a group replaces the previous one of that group (Shift+Tab pressed thrice is one message).
        setToasts((list) => [...list.filter((entry) => !toast.group || entry.group !== toast.group).slice(-3), { ...toast, id }])
        setTimeout(() => dismiss(id), ttl)
      }

      const whereOf = (id) => {
        const entry = index.get(id)
        if (!entry) return ''
        return entry.path
          .concat([entry.node])
          .map((node) => crumbLabel(node, t))
          .join(' › ')
      }

      // ---- loading

      const refreshProjects = () =>
        later('projects', 200, async () => {
          try {
            const data = await call('projects')
            setProjects(Array.isArray(data?.projects) ? data.projects : [])
            setListError(null)
          } catch (error) {
            setListError(error)
          }
        })

      const refetchProject = () =>
        later('project', REFETCH_DEBOUNCE_MS, async () => {
          const id = latest.current.openId
          if (!id) return
          try {
            const data = await call('project', { query: { id } })
            const next = asProject(data?.project)
            if (!next || latest.current.openId !== id) return
            setProject((current) => (current && current.rev && current.rev === next.rev ? current : next))
          } catch (error) {
            if (error.reason === 'not-found') {
              refreshProjects()
              dropProject(id)
            }
          }
        })

      useEffect(() => {
        let cancelled = false
        call('projects')
          .then((data) => {
            if (cancelled) return
            const list = Array.isArray(data?.projects) ? data.projects : []
            setProjects(list)
            setOpenId((current) => (current && list.some((entry) => entry.id === current) ? current : list[0]?.id ?? null))
          })
          .catch((error) => !cancelled && setListError(error))
        call('session')
          .then((data) => !cancelled && setSession(data))
          .catch((error) => !cancelled && setSessionError(error))
        const onHide = () => flushView(true)
        window.addEventListener('pagehide', onHide)
        return () => {
          cancelled = true
          window.removeEventListener('pagehide', onHide)
          flushView(true)
          for (const key of Object.keys(timers.current)) clearTimeout(timers.current[key])
        }
      }, [])

      // Nothing open (first start, or the open project went away): open the first one. A list
      // that merely lags behind a just-created project must not bounce the panel off it, so
      // "gone" is decided by the project fetch answering not-found, never by the list.
      useEffect(() => {
        if (projects && !openId && projects.length > 0) setOpenId(projects[0].id)
      }, [projects, openId])

      const dropProject = (id) => {
        setProjects((list) => (list ? list.filter((entry) => entry.id !== id) : list))
        setOpenId((current) => (current === id ? null : current))
      }

      useEffect(() => {
        if (!openId) {
          setProject(null)
          return undefined
        }
        let cancelled = false
        writeLocal(OPEN_KEY, openId)
        setProjectError(null)
        Promise.all([call('project', { query: { id: openId } }), call('view', { query: { project: openId } }).catch(() => ({ view: {} }))])
          .then(([data, stored]) => {
            if (cancelled) return
            const next = asProject(data?.project)
            // The dev harness starts from the defaults unless told to keep, so a screenshot is reproducible.
            const dev = devState()
            const restored = normalizeView(dev && !dev.keep ? {} : stored?.view)
            const ids = indexTree(next?.root)
            viewLoaded.current = openId
            setProject(next)
            setView(restored)
            setSelected(restored.selected && ids.has(restored.selected) ? restored.selected : null)
            setEditing(null)
            setCut(null)
            setRuns({})
            setOpenRefs(new Set())
            fetchedRuns.current = new Set()
          })
          .catch((error) => {
            if (cancelled) return
            if (error.reason === 'not-found') dropProject(openId)
            else setProjectError(error)
          })
        return () => {
          cancelled = true
        }
      }, [openId, reloadSeq])

      // ---- view persistence

      function saveView(keepalive) {
        const { openId: id, view: current, selected: chosen } = latest.current
        if (!id || viewLoaded.current !== id) return
        const cam = canvasApi.current?.camera?.()
        const payload = {
          fold: current.fold,
          offsets: current.offsets,
          camera: cam ? { x: round(cam.x), y: round(cam.y), s: Math.round(cam.s * 1000) / 1000 } : current.camera,
          selected: chosen && chosen !== DRAFT_ID ? chosen : null,
        }
        if (keepalive) {
          try {
            void fetch(`${API}/view`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: id, view: payload }) }).catch(() => {})
          } catch {
            /* the page is going away */
          }
          return
        }
        call('view', { method: 'POST', body: { project: id, view: payload } }).catch(() => {})
      }

      function scheduleSave() {
        pendingSave.current = true
        later('view', VIEW_DEBOUNCE_MS, () => {
          pendingSave.current = false
          saveView(false)
        })
      }

      function flushView(keepalive) {
        if (!pendingSave.current) return
        clearTimeout(timers.current.view)
        pendingSave.current = false
        saveView(keepalive)
      }

      const updateView = (change) => {
        setView((current) => {
          const next = change(current)
          return next === current ? current : next
        })
        scheduleSave()
      }

      // ---- writes

      async function applyOp(op, options = {}) {
        try {
          const data = (await call('op', { method: 'POST', body: { op } })) ?? {}
          if (seenEvents.current.size > 400) seenEvents.current = new Set()
          for (const event of data.events ?? []) if (event?.id) seenEvents.current.add(event.id)
          const next = asProject(data.project)
          // Same tick as the caller's own updates, so a draft and its real card never show together.
          options.onDone?.(data)
          if (next && next.id === latest.current.openId) setProject(next)
          refreshProjects()
          return data
        } catch (error) {
          options.onFail?.(error)
          if (!options.quiet) pushToast({ kind: 'error', text: error.message })
          return null
        }
      }

      const currentRoot = () => latest.current.project?.root ?? null
      const pid = () => latest.current.openId

      function select(id, options = {}) {
        const target = id ?? null
        setSelected(target)
        if (target && target !== DRAFT_ID) {
          const tree = currentRoot()
          if (tree) {
            setView((current) => {
              const fold = revealPath(tree, current.fold, target, false)
              return fold === current.fold ? current : { ...current, fold }
            })
          }
          if (options.reveal) canvasApi.current?.reveal(target)
        }
        if (target !== DRAFT_ID) {
          later('focus', FOCUS_DEBOUNCE_MS, () => {
            const projectId = latest.current.openId
            if (projectId) call('focus', { method: 'POST', body: { project: projectId, node: target } }).catch(() => {})
          })
        }
        scheduleSave()
      }

      function startDraft(draft) {
        const tree = currentRoot()
        if (!tree) return
        setView((current) => {
          const fold = revealPath(tree, current.fold, draft.parent, true)
          return fold === current.fold ? current : { ...current, fold }
        })
        setEditing({ id: DRAFT_ID, draft: { ...draft, previous: latest.current.selected } })
        setSelected(DRAFT_ID)
        canvasApi.current?.reveal(DRAFT_ID)
      }

      async function finishEdit(value, viaKey) {
        const current = latest.current.editing
        if (viaKey) canvasApi.current?.focus()
        if (!current) return
        const title = String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim()
        if (current.draft) {
          if (!title) {
            setEditing(null)
            setSelected(current.draft.previous ?? null)
            return
          }
          setEditing({ ...current, draft: { ...current.draft, title }, pending: true })
          const { parent, after, kind, branch } = current.draft
          const op = branch ? { type: 'branch', project: pid(), parent, title } : { type: 'create', project: pid(), parent, kind, title }
          if (after !== undefined && !branch) op.after = after
          await applyOp(op, {
            onDone: (data) => {
              setEditing(null)
              if (data.nodeId) select(data.nodeId, { reveal: true })
            },
            onFail: () => {
              setEditing(null)
              setSelected(current.draft.previous ?? null)
            },
          })
          return
        }
        setEditing(null)
        renameNode(current.id, title)
      }

      function renameNode(id, value) {
        const title = String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim()
        const node = indexTree(currentRoot()).get(id)?.node
        if (!node || !title || title === node.title) return
        if (node.kind === 'project') void applyOp({ type: 'renameProject', project: pid(), title })
        else void applyOp({ type: 'update', project: pid(), id, patch: { title } })
      }

      function update(id, patch) {
        return applyOp({ type: 'update', project: pid(), id, patch })
      }

      function addNext(id) {
        const entry = indexTree(currentRoot()).get(id)
        if (!entry) return
        const node = entry.node
        // On the project a new step stands beside its line; at the end of it is 在项目末尾加一步.
        if (node.kind === 'project') startDraft({ parent: node.id, kind: 'step', branch: true })
        else if (node.kind === 'lane') startDraft({ parent: node.id, kind: 'step' })
        else if (node.kind === 'step' || node.kind === 'fork') startDraft({ parent: entry.parent.id, after: node.id, kind: 'step' })
      }


      function addChild(id) {
        const node = indexTree(currentRoot()).get(id)?.node
        if (!node) return
        if (node.kind === 'fork') startDraft({ parent: node.id, kind: 'lane' })
        else if (node.kind !== 'ref') startDraft({ parent: node.id, kind: 'step' })
      }

      /** A new step beside the line of `id` (the project's, a chapter, a lane's), not after it. */
      function addBranch(id) {
        const node = indexTree(currentRoot()).get(id)?.node
        if (node && node.kind !== 'ref' && node.kind !== 'fork') startDraft({ parent: node.id, kind: 'step', branch: true })
      }

      async function forkFrom(id, names, title) {
        const op = { type: 'fork', project: pid(), after: id, lanes: names }
        if (title) op.title = title
        await applyOp(op, {
          onDone: (data) => {
            const tree = asProject(data.project)?.root
            const fork = data.nodeId && tree ? indexTree(tree).get(data.nodeId)?.node : null
            const first = fork ? lineOf(fork)[0] : null
            if (first || data.nodeId) select(first?.id ?? data.nodeId, { reveal: true })
          },
        })
      }

      async function remove(id) {
        const entry = indexTree(currentRoot()).get(id)
        if (!entry?.parent) return
        const { node, parent } = entry
        const kids = childrenOf(parent)
        const at = kids.indexOf(node)
        const after = at > 0 ? kids[at - 1].id : ''
        const siblings = node.kind === 'ref' ? refsOf(parent) : lineOf(parent)
        const position = siblings.indexOf(node)
        const nextSelection = node.kind === 'ref' ? latest.current.selected : (siblings[position + 1] ?? siblings[position - 1] ?? parent).id
        const projectId = pid()
        const data = await applyOp(
          { type: 'remove', project: projectId, id },
          {
            onDone: () => {
              if (node.kind !== 'ref') select(nextSelection)
              if (latest.current.cut === id) setCut(null)
            },
          },
        )
        if (!data) return
        const removed = data.removed && typeof data.removed === 'object' ? data.removed : node
        pushToast({
          kind: 'undo',
          text: latest.current.t('toast.removed', { title: clip(node.title || latest.current.t('card.untitled'), 24) }),
          action: {
            label: latest.current.t('toast.undo'),
            run: () =>
              applyOp(
                { type: 'insert', project: projectId, parent: parent.id, after, node: removed },
                { onDone: (back) => back.nodeId && removed.kind !== 'ref' && select(back.nodeId, { reveal: true }) },
              ),
          },
        })
      }

      async function reorder(id, dir) {
        const entry = indexTree(currentRoot()).get(id)
        if (!entry?.parent || entry.node.kind === 'ref') return
        const kids = childrenOf(entry.parent)
        const line = lineOf(entry.parent)
        const target = line[line.indexOf(entry.node) + dir]
        if (!target) return
        let after = target.id
        if (dir < 0) {
          const at = kids.indexOf(target)
          after = at > 0 ? kids[at - 1].id : ''
        }
        await applyOp({ type: 'move', project: pid(), id, parent: entry.parent.id, after })
        canvasApi.current?.reveal(id)
      }

      async function indent(id, dir) {
        const target = indentTarget(currentRoot(), id, dir)
        if (!target.parent) {
          pushToast({ kind: 'info', text: latest.current.t(`toast.indent.${target.reason}`), ttl: 2400, group: 'indent' })
          return
        }
        const op = { type: 'move', project: pid(), id, parent: target.parent }
        if (target.after !== undefined) op.after = target.after
        await applyOp(op, {
          onDone: (data) => {
            // A folded chapter it went into must open; the tree held here is still the old one.
            const tree = asProject(data.project)?.root
            if (tree) {
              updateView((current) => {
                const fold = revealPath(tree, current.fold, id, false)
                return fold === current.fold ? current : { ...current, fold }
              })
            }
            canvasApi.current?.reveal(id)
          },
        })
      }

      async function paste(targetId, inside) {
        const moving = latest.current.cut
        if (!moving) {
          pushToast({ kind: 'info', text: latest.current.t('toast.pasteNothing') })
          return
        }
        if (moving === targetId) return
        const target = indexTree(currentRoot()).get(targetId)
        if (!target) return
        const op =
          inside || target.node.kind === 'project' || target.node.kind === 'lane'
            ? { type: 'move', project: pid(), id: moving, parent: targetId }
            : { type: 'move', project: pid(), id: moving, parent: target.parent.id, after: targetId }
        await applyOp(op, {
          onDone: () => {
            setCut(null)
            select(moving, { reveal: true })
          },
        })
      }

      function cycleFold(id) {
        const tree = currentRoot()
        if (!tree) return
        const run = foldRun.current
        const last = run?.kind === 'tab' && run.id === id ? run.state : null
        updateView((current) => {
          const result = nextFold(tree, current.fold, id, last)
          foldRun.current = { kind: 'tab', id, state: result.state }
          return result.changed ? { ...current, fold: result.fold } : current
        })
      }

      function cycleGlobal(fromScreen) {
        const tree = currentRoot()
        if (!tree) return
        const fold = latest.current.view.fold
        const run = foldRun.current
        // The toolbar button reads its place in the cycle off the screen, so each click goes on.
        const last = fromScreen === true ? globalModeOf(tree, fold) : run?.kind === 'global' ? run.mode : null
        const result = nextGlobalFold(tree, fold, last)
        foldRun.current = { kind: 'global', mode: result.mode }
        updateView((value) => ({ ...value, fold: result.fold }))
        if (result.mode) pushToast({ kind: 'info', text: latest.current.t(`toast.mode.${result.mode}`), ttl: 1600, group: 'mode' })
      }

      async function ensureRuns(nodeId) {
        const projectId = pid()
        const key = `${projectId}/${nodeId}`
        if (!projectId || fetchedRuns.current.has(key)) return
        fetchedRuns.current.add(key)
        await refetchRuns(nodeId)
      }

      async function refetchRuns(nodeId) {
        const projectId = pid()
        if (!projectId || !nodeId) return
        try {
          const data = await call('runs', { query: { project: projectId, node: nodeId } })
          if (latest.current.openId !== projectId) return
          const list = Array.isArray(data?.runs) ? data.runs : []
          setRuns((current) => {
            const forNode = { ...(current[nodeId] ?? {}) }
            for (const run of list) if (Number.isInteger(run?.index)) forNode[run.index] = run
            return { ...current, [nodeId]: forNode }
          })
          if (list.some((run) => run?.status === 'running')) later(`run:${nodeId}`, RUN_POLL_MS, () => refetchRuns(nodeId))
        } catch {
          /* a run panel that cannot refresh keeps its last picture */
        }
      }

      async function startRun(nodeId, at) {
        try {
          const data = await call('run', { method: 'POST', body: { project: pid(), node: nodeId, index: at } })
          const run = data?.run
          if (run) setRuns((current) => ({ ...current, [nodeId]: { ...(current[nodeId] ?? {}), [at]: run } }))
          if (!run || run.status === 'running') later(`run:${nodeId}`, RUN_POLL_MS, () => refetchRuns(nodeId))
        } catch (error) {
          pushToast({ kind: 'error', text: error.message })
        }
      }

      async function cancelRun(runId) {
        let nodeId = null
        for (const [id, byIndex] of Object.entries(latest.current.runs)) for (const run of Object.values(byIndex)) if (run.runId === runId) nodeId = id
        try {
          await call('run/cancel', { method: 'POST', body: { runId } })
        } catch (error) {
          pushToast({ kind: 'error', text: error.message })
        }
        if (nodeId) later(`run:${nodeId}`, 300, () => refetchRuns(nodeId))
      }

      async function ask(nodeId, at) {
        try {
          await call('ask', { method: 'POST', body: { project: pid(), node: nodeId, ...(Number.isInteger(at) ? { index: at } : {}) } })
          pushToast({ kind: 'info', text: latest.current.t('toast.asked') })
        } catch (error) {
          pushToast({ kind: 'error', text: error.message })
        }
      }

      const actionsRef = useRef(null)
      actionsRef.current = {
        select,
        startRename: (id) => {
          if (id && id !== DRAFT_ID) setEditing({ id })
        },
        finishEdit,
        focusCanvas: () => canvasApi.current?.focus(),
        reveal: (id) => canvasApi.current?.reveal(id),
        renameNode,
        addNext,
        addChild,
        addLane: (forkId) => startDraft({ parent: forkId, kind: 'lane' }),
        forkFrom,
        addBranch,
        addRef: (id) => {
          select(id)
          setRefAdd({ id, seq: Date.now() })
        },
        createRef: (parentId, title) =>
          applyOp(
            { type: 'create', project: pid(), parent: parentId, kind: 'ref', title: title.replace(/\s+/g, ' ').trim() },
            { onDone: (data) => setOpenRefs((current) => new Set([...current, parentId, ...(data.nodeId ? [data.nodeId] : [])])) },
          ),
        setState: (id, state) => {
          const node = indexTree(currentRoot()).get(id)?.node
          if (node && (node.state || '') !== state) void update(id, { state })
        },
        toggleQuestion: (id) => {
          const node = indexTree(currentRoot()).get(id)?.node
          if (node) void update(id, { question: !node.question })
        },
        saveBody: (id, body) => {
          const node = indexTree(currentRoot()).get(id)?.node
          const text = String(body ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/\s+$/, '')
          if (node && text !== (node.body ?? '')) void update(id, { body: text })
        },
        setCwd: (value) => {
          const tree = currentRoot()
          if (!tree) return
          const cwd = String(value ?? '').trim()
          if (cwd === (tree.attrs?.cwd ?? '')) return
          const attrs = { ...(tree.attrs ?? {}) }
          if (cwd) attrs.cwd = cwd
          else delete attrs.cwd
          void update(tree.id, { attrs })
        },
        ask,
        cut: (id) => {
          setCut(id ?? null)
          const node = id ? indexTree(currentRoot()).get(id)?.node : null
          if (node) pushToast({ kind: 'info', text: latest.current.t('toast.cut', { title: clip(node.title, 20) }), ttl: 4000, group: 'cut' })
        },
        paste,
        remove,
        reorder,
        indent,
        resetOffset: (id) =>
          updateView((current) => {
            if (!current.offsets[id]) return current
            const offsets = { ...current.offsets }
            delete offsets[id]
            return { ...current, offsets }
          }),
        resetAll: () => updateView((current) => (Object.keys(current.offsets).length ? { ...current, offsets: {} } : current)),
        setOffset: (id, offset) => updateView((current) => ({ ...current, offsets: { ...current.offsets, [id]: offset } })),
        setFold: (id, state) => updateView((current) => ({ ...current, fold: { ...current.fold, [id]: state } })),
        toggleChapter: (id) => {
          const shown = computeFolds(currentRoot(), latest.current.view.fold).get(id)?.lineShown === true
          updateView((current) => ({ ...current, fold: { ...current.fold, [id]: shown ? 'folded' : 'children' } }))
        },
        cycleFold,
        cycleGlobal,
        foldAll: () => updateView((current) => ({ ...current, fold: globalFold(currentRoot(), 'overview') })),
        unfoldAll: () => updateView((current) => ({ ...current, fold: globalFold(currentRoot(), 'all') })),
        openRefs: (id) => {
          select(id)
          const first = refsOf(indexTree(currentRoot()).get(id)?.node)[0]
          if (first) setOpenRefs(new Set([first.id]))
        },
        toggleRef: (id) =>
          setOpenRefs((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          }),
        removeProject: (id) => applyOp({ type: 'removeProject', project: id }, { onDone: () => dropProject(id) }),
        ensureRuns,
        startRun,
        cancelRun,
      }
      const actions = useMemo(() => {
        const out = {}
        for (const name of Object.keys(actionsRef.current)) out[name] = (...args) => actionsRef.current[name](...args)
        return out
      }, [])
      const fences = useMemo(
        () => ({
          runOf: (nodeId, at) => latest.current.runs?.[nodeId]?.[at] ?? null,
          ensure: (nodeId) => actions.ensureRuns(nodeId),
          start: (nodeId, at) => actions.startRun(nodeId, at),
          cancel: (runId) => actions.cancelRun(runId),
          ask: (nodeId, at) => actions.ask(nodeId, at),
        }),
        [],
      )

      function openProject(id) {
        if (id === latest.current.openId) return
        flushView(false)
        setHistoryOpen(false)
        setOpenId(id)
      }

      async function createProject(title) {
        await applyOp({ type: 'createProject', title }, { onDone: (data) => data.nodeId && openProject(data.nodeId) })
      }

      async function resetSession() {
        try {
          const data = await call('session/reset', { method: 'POST', body: {} })
          setSession((current) => ({ ...(current ?? {}), sessionId: data?.sessionId ?? '' }))
          setSessionError(null)
        } catch (error) {
          pushToast({ kind: 'error', text: error.message })
        }
      }

      // ---- live updates

      const onEventRef = useRef(null)
      onEventRef.current = (event) => {
        if (!event || typeof event.type !== 'string') return
        if (event.id && seenEvents.current.has(event.id)) return
        const type = event.type
        if (type.startsWith('project') || type === 'tree/external' || type.startsWith('node/') || type === 'git/committed') refreshProjects()
        if (!event.project || event.project !== latest.current.openId) return
        if (type.startsWith('run/')) {
          if (event.node) void refetchRuns(event.node)
          return
        }
        if (type.startsWith('view/') || type === 'session/asked' || type === 'git/committed') return
        refetchProject()
        if (event.actor?.kind === 'agent' || event.actor?.kind === 'external') {
          const ids = [event.node, ...(event.data?.added ?? []), ...(event.data?.changed ?? [])].filter((id) => typeof id === 'string')
          if (ids.length > 0) {
            setFresh(new Set(ids))
            later('fresh', 1800, () => setFresh(new Set()))
          }
        }
      }

      useEffect(() => {
        let source = null
        let errors = 0
        let poller = null
        const poll = () => {
          if (poller) return
          poller = setInterval(() => {
            refreshProjects()
            refetchProject()
          }, POLL_MS)
        }
        if (typeof EventSource !== 'function') {
          poll()
          return () => clearInterval(poller)
        }
        try {
          source = new EventSource(`${API}/stream`)
          source.addEventListener('mainline', (message) => {
            errors = 0
            let event
            try {
              event = JSON.parse(message.data)
            } catch {
              return
            }
            onEventRef.current(event)
          })
          source.onopen = () => {
            // A reconnect may have missed events: catch up once, and stop polling.
            if (errors > 0) {
              refreshProjects()
              refetchProject()
            }
            errors = 0
            if (poller) {
              clearInterval(poller)
              poller = null
            }
          }
          source.onerror = () => {
            errors += 1
            if (errors >= 3) poll()
          }
        } catch {
          poll()
        }
        return () => {
          source?.close()
          if (poller) clearInterval(poller)
        }
      }, [])

      // ---- dev harness start state

      useEffect(() => {
        const dev = devState()
        if (!dev || devApplied.current || !project || (dev.project && dev.project !== project.id)) return
        devApplied.current = true
        const tree = project.root
        let fold = { ...view.fold }
        if (GLOBAL_CYCLE.includes(dev.fold)) fold = globalFold(tree, dev.fold)
        for (const id of String(dev.open ?? '').split(',').filter(Boolean)) fold[id] = 'open'
        for (const id of String(dev.all ?? '').split(',').filter(Boolean)) fold[id] = 'all'
        for (const id of String(dev.folded ?? '').split(',').filter(Boolean)) fold[id] = 'folded'
        setView((current) => ({ ...current, fold }))
        if (dev.select) select(dev.select, { reveal: true })
        if (dev.refs && dev.select) actions.openRefs(dev.select)
        if (dev.cut) setCut(dev.cut)
        const after = (fn) => setTimeout(fn, 350)
        if (dev.run !== undefined && dev.select) after(() => startRun(dev.select, Number(dev.run) || 0))
        if (dev.edit) after(() => setEditing({ id: dev.edit }))
        if (dev.fork && dev.select) after(() => canvasApi.current?.openFork(dev.select))
        if (dev.menu) after(() => canvasApi.current?.openMenu(dev.menu === 'canvas' ? null : dev.menu === '1' || dev.menu === 'card' ? dev.select : dev.menu))
        if (dev.offset) {
          const [id, dx, dy] = String(dev.offset).split(':')
          if (id) setView((current) => ({ ...current, offsets: { ...current.offsets, [id]: { dx: Number(dx) || 0, dy: Number(dy) || 0 } } }))
        }
      }, [project])

      // ---- splitters

      function beginSideDrag(event) {
        if (event.button !== 0) return
        event.preventDefault()
        const startX = event.clientX
        const start = sideWidth
        const total = rootRef.current?.getBoundingClientRect().width ?? 1400
        let width = start
        const move = (next) => {
          width = clamp(start - (next.clientX - startX), SIDE_MIN, Math.max(SIDE_MIN, total - 380))
          setSideWidth(width)
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          writeLocal(SIDE_KEY, Math.round(width))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      function beginDetailDrag(event) {
        if (event.button !== 0) return
        event.preventDefault()
        const startY = event.clientY
        const start = detailRef.current?.getBoundingClientRect().height ?? 300
        const total = sideRef.current?.getBoundingClientRect().height ?? 800
        let height = start
        const move = (next) => {
          height = clamp(start + (next.clientY - startY), DETAIL_MIN, Math.max(DETAIL_MIN, total - CHAT_MIN))
          setDetailHeight(height)
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          writeLocal(DETAIL_KEY, Math.round(height))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      function nudgeSide(delta) {
        const total = rootRef.current?.getBoundingClientRect().width ?? 1400
        const width = clamp(sideWidth + delta, SIDE_MIN, Math.max(SIDE_MIN, total - 380))
        setSideWidth(width)
        writeLocal(SIDE_KEY, Math.round(width))
      }

      function nudgeDetail(delta) {
        const total = sideRef.current?.getBoundingClientRect().height ?? 800
        const start = detailRef.current?.getBoundingClientRect().height ?? 300
        const height = clamp(start + delta, DETAIL_MIN, Math.max(DETAIL_MIN, total - CHAT_MIN))
        setDetailHeight(height)
        writeLocal(DETAIL_KEY, Math.round(height))
      }

      // ---- render

      let main
      if (listError && !projects) main = h('div', { className: 'ml-state' }, t('error.load', { message: listError.message }), h('button', { type: 'button', className: 'ml-btn', onClick: () => window.location.reload() }, t('action.retry')))
      else if (projects === null) main = h('div', { className: 'ml-state' }, t('loading'))
      else if (projects.length === 0) main = h('div', { className: 'ml-state' }, t('empty.projects'))
      else if (projectError) main = h('div', { className: 'ml-state' }, t('error.load', { message: projectError.message }), h('button', { type: 'button', className: 'ml-btn', onClick: () => setReloadSeq((n) => n + 1) }, t('action.retry')))
      else if (!project) main = h('div', { className: 'ml-state' }, t('loading'))
      else {
        main = h(Canvas, {
          key: project.id,
          t,
          projectId: project.id,
          root: displayRoot,
          index,
          folds,
          view,
          selected,
          editing: editing && !editing.pending ? editing : null,
          cut,
          actions,
          fences,
          runs,
          fresh,
          apiRef: canvasApi,
          initialCamera: view.camera,
          whereOf,
          onCamera: (cam) => zoom.set(Math.round(cam.s * 100) / 100),
          onCameraCommit: scheduleSave,
        })
      }

      return h(
        'div',
        { ref: rootRef, className: 'ml-root', 'data-ui': UI_REV },
        h(
          'div',
          { className: 'ml-main' },
          h(Bar, {
            t,
            projects,
            openId,
            onOpen: openProject,
            onCreate: createProject,
            historyOpen,
            setHistoryOpen,
            onRestore: (rev, short) =>
              applyOp({ type: 'restore', project: pid(), rev }, { onDone: () => pushToast({ kind: 'info', text: latest.current.t('history.restored', { rev: short ?? String(rev).slice(0, 7) }) }) }),
            canHome: Boolean(selected && selected !== DRAFT_ID),
            onHome: () => selected && canvasApi.current?.reveal(selected, true),
            onFit: () => canvasApi.current?.fit(),
            viewMode,
            onView: () => {
              cycleGlobal(true)
              // Keep the keys on the canvas: Shift+Tab right after a click goes on from here.
              canvasApi.current?.focus()
            },
            zoom,
            onZoomReset: () => canvasApi.current?.zoomTo(1),
          }),
          main,
          h('div', { className: 'ml-keys', title: t('keys') }, t('keys')),
          h(Toasts, { t, items: toasts, onDismiss: dismiss }),
        ),
        h('div', {
          className: 'ml-vsplit',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': t('split.side'),
          tabIndex: 0,
          onPointerDown: beginSideDrag,
          onDoubleClick: () => (setSideWidth(SIDE_DEFAULT), writeLocal(SIDE_KEY, null)),
          onKeyDown: (event) => {
            if (event.key === 'ArrowLeft') nudgeSide(24)
            else if (event.key === 'ArrowRight') nudgeSide(-24)
            else if (event.key === 'Enter') (setSideWidth(SIDE_DEFAULT), writeLocal(SIDE_KEY, null))
            else return
            event.preventDefault()
          },
        }),
        h(
          'aside',
          { ref: sideRef, className: 'ml-side', style: { width: `${sideWidth}px` } },
          h(
            'div',
            { ref: detailRef, className: 'ml-detail', style: detailHeight ? { flex: `0 0 ${detailHeight}px`, maxHeight: 'none' } : undefined },
            h(Detail, { t, root, index, nodeId: selected, actions, fences, runs, openRefs, refAdd }),
          ),
          h('div', {
            className: 'ml-hsplit',
            role: 'separator',
            'aria-orientation': 'horizontal',
            'aria-label': t('split.detail'),
            tabIndex: 0,
            onPointerDown: beginDetailDrag,
            onDoubleClick: () => (setDetailHeight(null), writeLocal(DETAIL_KEY, null)),
            onKeyDown: (event) => {
              if (event.key === 'ArrowUp') nudgeDetail(-32)
              else if (event.key === 'ArrowDown') nudgeDetail(32)
              else if (event.key === 'Enter') (setDetailHeight(null), writeLocal(DETAIL_KEY, null))
              else return
              event.preventDefault()
            },
          }),
          h(Conversation, { t, ctx, session, error: sessionError, onReset: resetSession, SessionProvider: props.SessionProvider, renderSlot: props.renderSlot }),
        ),
      )
    }

    // ------------------------------------------------------------------ styles

    // Monochrome: every colour is a theme token or a mix of two. Lines and fills derive from
    // the label colours because the light theme's bg layers are all the same white.
    const CSS = `
.ml-root {
  --ml-ink: var(--dsw-alias-label-primary);
  --ml-ink2: var(--dsw-alias-label-secondary);
  --ml-line: var(--dsw-alias-border-l2);
  --ml-surface: var(--dsw-alias-bg-layer-1);
  --ml-base: var(--dsw-alias-bg-base);
  --ml-tint: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  --ml-tint2: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  --ml-canvas: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, var(--dsw-alias-bg-base));
  --ml-dot: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  /* border-l2 / border-l1 are 10% / 4% black in the light theme: too faint for a line you follow. */
  --ml-edge: color-mix(in srgb, var(--dsw-alias-label-secondary) 58%, transparent);
  --ml-edge-dead: color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent);
  --ml-card-line: color-mix(in srgb, var(--dsw-alias-label-primary) 17%, transparent);
  --ml-frame: color-mix(in srgb, var(--dsw-alias-label-primary) 2.5%, transparent);
  --ml-frame-line: var(--dsw-alias-border-l2);
  --ml-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent), 0 1px 1px color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  --ml-lift: 0 10px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent), 0 2px 6px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
  --ml-mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  position: relative; display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden;
  background: var(--dsw-alias-bg-base); color: var(--ml-ink); font-size: 13px; line-height: 1.5;
}
/* In the dark theme a shadow made of the label colour would glow; the base colour is the dark one. */
body[data-ds-dark-theme] .ml-root {
  --ml-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-bg-base) 80%, transparent);
  --ml-lift: 0 10px 30px color-mix(in srgb, var(--dsw-alias-bg-base) 92%, transparent), 0 2px 6px color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent);
}
.ml-root *, .ml-root *::before, .ml-root *::after { box-sizing: border-box; }
.ml-root button { font: inherit; }
.ml-root :focus-visible { outline: 2px solid var(--ml-ink); outline-offset: 1px; }
.ml-main { position: relative; flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.ml-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 10px; border-bottom: 1px solid var(--ml-line); background: var(--ml-surface); }
.ml-tabs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.ml-tabs::-webkit-scrollbar { display: none; }
.ml-tab { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; color: var(--ml-ink2); padding: 3px 10px; border-radius: 7px; cursor: pointer; white-space: nowrap; font-size: 13px; }
.ml-tab:hover { background: var(--ml-tint); color: var(--ml-ink); }
.ml-tab[aria-selected="true"] { background: var(--ml-tint2); color: var(--ml-ink); font-weight: 600; }
.ml-tab[data-dead="1"]:not([aria-selected="true"]) { opacity: 0.75; }
.ml-tab-n { min-width: 18px; padding: 0 5px; border-radius: 9px; border: 1px solid var(--ml-line); color: var(--ml-ink); font-size: 11px; font-weight: 600; line-height: 16px; text-align: center; }
.ml-tab-new { gap: 4px; }
.ml-tab-input { width: 220px; flex: 0 0 auto; font-weight: 400; }
.ml-bar-tools { position: relative; flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.ml-btn { display: inline-flex; align-items: center; gap: 5px; min-height: 26px; padding: 2px 9px; border: 1px solid var(--ml-line); border-radius: 7px; background: var(--ml-surface); color: var(--ml-ink); font-size: 12.5px; white-space: nowrap; cursor: pointer; }
.ml-btn:hover:not(:disabled) { background: var(--ml-tint); }
.ml-btn:disabled { color: var(--ml-ink2); opacity: 0.6; cursor: default; }
.ml-btn-strong { background: var(--ml-ink); border-color: var(--ml-ink); color: var(--dsw-alias-bg-base); font-weight: 600; }
.ml-btn-strong:hover:not(:disabled) { background: color-mix(in srgb, var(--ml-ink) 82%, var(--dsw-alias-bg-base)); }
/* Destructive is not an error: no hue here (the error token is for failures); the weight and the undo toast carry it. */
.ml-btn-danger { border-color: var(--ml-ink); font-weight: 600; }
.ml-zoom { width: 46px; padding: 2px 4px; border: 0; border-radius: 6px; background: none; color: var(--ml-ink2); font-size: 12px; text-align: right; cursor: pointer; }
.ml-zoom:hover { color: var(--ml-ink); background: var(--ml-tint); }
.ml-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--ml-ink2); cursor: pointer; }
.ml-icon:hover:not(:disabled) { color: var(--ml-ink); background: var(--ml-tint); }
.ml-icon:disabled { opacity: 0.4; cursor: default; }
.ml-icon-danger:hover:not(:disabled) { color: var(--ml-ink); background: var(--ml-tint2); }
.ml-mini { display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 0 7px; border: 1px solid var(--ml-line); border-radius: 6px; background: var(--ml-surface); color: var(--ml-ink); font-size: 12px; white-space: nowrap; cursor: pointer; }
.ml-mini:hover { background: var(--ml-tint); }
.ml-mini[aria-pressed="true"] { background: var(--ml-ink); border-color: var(--ml-ink); color: var(--dsw-alias-bg-base); }
.ml-mini-strong { font-weight: 600; }
.ml-link { padding: 0; border: 0; background: none; color: var(--ml-ink2); font-size: 12px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.ml-link:hover { color: var(--ml-ink); }
.ml-link-danger { color: var(--ml-ink2); }
.ml-grow { flex: 1 1 auto; }
.ml-muted { color: var(--ml-ink2); font-size: 12px; padding: 4px 6px; }
.ml-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.ml-input { width: 100%; min-width: 0; padding: 4px 8px; border: 1px solid var(--ml-line); border-radius: 6px; outline: none; background: var(--ml-surface); color: var(--ml-ink); font: inherit; font-size: 12.5px; }
.ml-input:focus { border-color: var(--ml-ink); }
.ml-mono { font-family: var(--ml-mono); font-size: 12px; }
.ml-state { margin: auto; padding: 40px; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--ml-ink2); text-align: center; }

.ml-canvas { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; outline: none; cursor: grab; touch-action: none; user-select: none;
  background-color: var(--ml-canvas); background-image: radial-gradient(var(--ml-dot) 1.1px, transparent 1.4px); background-size: 22px 22px; }
.ml-canvas:focus-visible { outline: 2px solid var(--ml-ink); outline-offset: -2px; }
.ml-canvas[data-panning="1"], .ml-canvas[data-dragging="1"] { cursor: grabbing; }
.ml-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.ml-world[data-glide="1"] { transition: transform 0.32s cubic-bezier(0.2, 0.7, 0.2, 1); }
.ml-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.ml-edge { fill: none; stroke: var(--ml-edge); stroke-width: 1.5; }
.ml-edge[data-live="0"] { stroke: var(--ml-edge-dead); stroke-dasharray: 4 4; }
.ml-edge[data-hot="1"] { stroke: var(--ml-ink); stroke-width: 2.5; stroke-linecap: round; }
.ml-frame { fill: var(--ml-frame); stroke: var(--ml-frame-line); stroke-dasharray: 4 4; }
.ml-frame[data-hot="1"] { stroke: var(--ml-ink2); }
.ml-canvas-empty { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); max-width: 360px; color: var(--ml-ink2); font-size: 12.5px; text-align: center; pointer-events: none; }

.ml-card { position: absolute; left: 0; top: 0; width: 224px; padding: 8px 11px 8px 14px; border: 1px solid var(--ml-card-line); border-radius: 10px; background: var(--ml-surface); box-shadow: var(--ml-shadow); color: var(--ml-ink); font-size: 13px; line-height: 1.45; cursor: pointer; }
.ml-card:hover { border-color: color-mix(in srgb, var(--ml-ink) 40%, transparent); }
.ml-card[data-open="1"] { width: 360px; cursor: default; }
.ml-card[data-kind="project"] { width: 400px; padding: 12px 16px 12px 18px; border-radius: 12px; }
.ml-card[data-kind="project"][data-open="1"] { width: 440px; }
.ml-card[data-state="todo"]::before { content: ""; position: absolute; left: 4px; top: 9px; bottom: 9px; width: 3px; border-radius: 2px; background: var(--ml-ink); }
.ml-card[data-state="halt"] { border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent); box-shadow: none; background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-base)); }
.ml-card[data-state="halt"] .ml-card-text { color: var(--ml-ink2); }
.ml-card[data-sel="1"] { border: 1px solid var(--ml-ink); box-shadow: 0 0 0 0.5px var(--ml-ink), var(--ml-lift); z-index: 2; }
.ml-card[data-cut="1"], .ml-lane[data-cut="1"] { opacity: 0.55; outline: 1.5px dashed var(--ml-ink2); outline-offset: 3px; }
.ml-card[data-fresh="1"] { animation: ml-fresh 1.8s ease-out; }
@keyframes ml-fresh { from { box-shadow: 0 0 0 5px color-mix(in srgb, var(--ml-ink) 30%, transparent); } }
.ml-card-title { display: flex; align-items: flex-start; min-width: 0; }
.ml-card-text { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-word; }
.ml-card[data-kind="project"] .ml-card-text { font-size: 14.5px; font-weight: 650; -webkit-line-clamp: 2; }
.ml-card[data-open="1"] .ml-card-text { -webkit-line-clamp: unset; font-weight: 600; }
.ml-q { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin: 2px 5px 0 0; border: 1px solid currentColor; border-radius: 50%; color: var(--ml-ink); font-size: 10px; font-weight: 700; line-height: 1; }
.ml-peek { margin-top: 2px; overflow: hidden; color: var(--ml-ink2); font-size: 11.5px; white-space: nowrap; text-overflow: ellipsis; }
.ml-card[data-kind="project"] .ml-peek { margin-top: 4px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ml-card-foot { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 6px; color: var(--ml-ink2); font-size: 11px; }
.ml-chip { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; overflow: hidden; padding: 0 7px 0 5px; border: 1px solid var(--ml-line); border-radius: 9px; background: var(--ml-surface); color: var(--ml-ink2); font-size: 11px; line-height: 17px; white-space: nowrap; cursor: pointer; }
.ml-chip:hover { background: var(--ml-tint); color: var(--ml-ink); }
.ml-chip svg { flex: none; }
.ml-chip-n { flex: none; color: var(--ml-ink); font-weight: 600; }
.ml-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ml-chip-fold { flex: none; padding: 0 7px 0 4px; }
.ml-card-count { flex: none; margin-left: auto; color: var(--ml-ink); font-weight: 600; white-space: nowrap; }
.ml-title-input { width: 100%; min-width: 0; padding: 1px 6px; border: 1px solid var(--ml-ink); border-radius: 6px; outline: none; background: var(--ml-surface); color: var(--ml-ink); font: inherit; font-weight: 600; }
.ml-card-body { margin-top: 6px; max-height: ${CARD_BODY_MAX}px; overflow: auto; }
.ml-card-edit { margin-top: 6px; }
.ml-card-edit .ml-textarea { resize: none; }

.ml-lane { position: absolute; left: 0; top: 0; display: inline-flex; align-items: center; gap: 5px; padding: 1px 10px; border: 1px solid var(--ml-ink2); border-radius: 999px; background: var(--ml-surface); color: var(--ml-ink); font-size: 11.5px; font-weight: 600; line-height: 18px; white-space: nowrap; cursor: pointer; }
.ml-lane[data-live="0"] { border-color: var(--ml-edge-dead); border-style: dashed; color: var(--ml-ink2); }
.ml-lane[data-bare="1"] { width: 12px; height: 12px; padding: 0; gap: 0; }
.ml-lane[data-sel="1"] { border: 1px solid var(--ml-ink); box-shadow: 0 0 0 0.5px var(--ml-ink), var(--ml-lift); z-index: 2; color: var(--ml-ink); }
.ml-lane-more { display: inline-flex; align-items: center; gap: 1px; padding: 0 5px 0 2px; border: 0; border-radius: 8px; background: var(--ml-tint2); color: var(--ml-ink2); font-size: 10.5px; font-weight: 600; line-height: 15px; cursor: pointer; }
.ml-lane-more:hover { color: var(--ml-ink); }
.ml-lane-input { width: 150px; padding: 0 6px; font-size: 11.5px; }
.ml-forkt { position: absolute; left: 0; top: 0; padding: 0 4px; border-radius: 4px; color: var(--ml-ink2); font-size: 11.5px; line-height: 17px; white-space: nowrap; cursor: pointer; }
.ml-forkt:hover { color: var(--ml-ink); }
.ml-forkt[data-sel="1"] { color: var(--ml-ink); outline: 1.5px solid var(--ml-ink); }

.ml-menu { position: absolute; z-index: 20; min-width: 210px; max-width: 300px; padding: 4px; border: 1px solid var(--ml-line); border-radius: 9px; background: var(--ml-surface); box-shadow: var(--ml-lift); cursor: default; }
.ml-menu-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px 4px 4px; border: 0; border-radius: 6px; background: none; color: var(--ml-ink); font-size: 12.5px; text-align: left; cursor: pointer; }
.ml-menu-item:hover:not(:disabled), .ml-menu-item:focus-visible { outline: none; background: var(--ml-tint2); }
.ml-menu-item:disabled { color: var(--ml-ink2); opacity: 0.55; cursor: default; }
.ml-menu-danger { font-weight: 600; }
.ml-menu-check { flex: none; width: 14px; text-align: center; }
.ml-menu-label { flex: 1 1 auto; }
.ml-menu-hint { flex: none; color: var(--ml-ink2); font-size: 11px; }
.ml-menu-sep { height: 1px; margin: 4px 6px; background: var(--ml-line); }
.ml-form { position: absolute; z-index: 20; width: 290px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--ml-line); border-radius: 10px; background: var(--ml-surface); box-shadow: var(--ml-lift); cursor: default; user-select: text; }
.ml-form-title { font-weight: 600; }
.ml-form-row { display: flex; flex-direction: column; gap: 3px; color: var(--ml-ink2); font-size: 12px; }
.ml-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.ml-pop { position: absolute; z-index: 30; top: calc(100% + 6px); right: 0; width: 440px; max-height: 440px; overflow: auto; padding: 6px; border: 1px solid var(--ml-line); border-radius: 10px; background: var(--ml-surface); box-shadow: var(--ml-lift); }
.ml-commit { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 10px; align-items: center; padding: 6px; border-radius: 6px; }
.ml-commit:hover { background: var(--ml-tint); }
.ml-commit-rev { grid-row: 1 / 3; color: var(--ml-ink2); font-family: var(--ml-mono); font-size: 11px; }
.ml-commit-msg { overflow: hidden; font-size: 12.5px; white-space: nowrap; text-overflow: ellipsis; }
.ml-commit-meta { grid-column: 2; color: var(--ml-ink2); font-size: 11px; }
.ml-commit > button { grid-column: 3; grid-row: 1 / 3; }

.ml-toasts { position: absolute; left: 50%; bottom: 44px; z-index: 40; display: flex; flex-direction: column; align-items: center; gap: 6px; transform: translateX(-50%); pointer-events: none; }
.ml-toast { display: flex; align-items: center; gap: 10px; max-width: 580px; padding: 6px 8px 6px 14px; border-radius: 9px; background: var(--ml-ink); color: var(--dsw-alias-bg-base); box-shadow: var(--ml-lift); font-size: 12.5px; pointer-events: auto; }
.ml-toast[data-kind="error"] { border: 1px solid var(--dsw-alias-state-error-primary); background: var(--ml-surface); color: var(--dsw-alias-state-error-primary); }
.ml-toast .ml-btn-strong { border-color: var(--dsw-alias-bg-base); background: var(--dsw-alias-bg-base); color: var(--ml-ink); }
.ml-toast .ml-icon { color: inherit; opacity: 0.75; }
.ml-keys { flex: 0 0 auto; overflow: hidden; padding: 5px 12px; border-top: 1px solid var(--ml-line); background: var(--ml-surface); color: var(--ml-ink2); font-size: 11.5px; white-space: nowrap; text-overflow: ellipsis; }

.ml-vsplit { position: relative; z-index: 5; flex: 0 0 auto; width: 7px; margin: 0 -3px; cursor: col-resize; touch-action: none; }
.ml-vsplit::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: var(--ml-line); }
.ml-vsplit:hover::after, .ml-vsplit:focus-visible::after { left: 2.5px; width: 2px; background: var(--ml-ink2); }
.ml-vsplit:focus-visible { outline: none; }
.ml-side { flex: 0 0 auto; min-width: 0; display: flex; flex-direction: column; background: var(--ml-surface); }
.ml-detail { flex: 0 1 auto; min-height: ${DETAIL_MIN}px; max-height: 58%; overflow: auto; padding: 12px 16px 14px; }
.ml-hsplit { position: relative; z-index: 2; flex: 0 0 auto; height: 7px; margin: -3px 0; cursor: row-resize; touch-action: none; }
.ml-hsplit::after { content: ""; position: absolute; left: 0; right: 0; top: 3px; height: 1px; background: var(--ml-line); }
.ml-hsplit:hover::after, .ml-hsplit:focus-visible::after { top: 2.5px; height: 2px; background: var(--ml-ink2); }
.ml-hsplit:focus-visible { outline: none; }
.ml-detail-empty { color: var(--ml-ink2); font-size: 12.5px; }
.ml-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 3px; color: var(--ml-ink2); font-size: 12px; }
.ml-crumb { padding: 0 2px; border: 0; border-radius: 4px; background: none; color: var(--ml-ink2); font-size: 12px; cursor: pointer; }
button.ml-crumb:hover { color: var(--ml-ink); text-decoration: underline; }
.ml-crumb-here { color: var(--ml-ink); cursor: default; }
.ml-crumb-sep { opacity: 0.7; }
.ml-detail-title { display: flex; align-items: flex-start; margin: 4px 0 8px; font-size: 15px; font-weight: 600; line-height: 1.4; word-break: break-word; cursor: text; }
.ml-detail-title .ml-q { margin-top: 3px; }
.ml-detail-title-input { margin: 4px 0 8px; padding: 3px 7px; font-size: 14px; }
.ml-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
.ml-seg { display: inline-flex; overflow: hidden; border: 1px solid var(--ml-line); border-radius: 7px; }
.ml-seg button { min-height: 22px; padding: 1px 9px; border: 0; border-left: 1px solid var(--ml-line); background: none; color: var(--ml-ink2); font-size: 12px; cursor: pointer; }
.ml-seg button:first-child { border-left: 0; }
.ml-seg button[aria-checked="true"] { background: var(--ml-ink); color: var(--dsw-alias-bg-base); font-weight: 600; }
.ml-detail-body { padding: 2px 0; }
.ml-detail-placeholder { display: block; width: 100%; padding: 8px 10px; border: 1px dashed var(--ml-line); border-radius: 7px; background: none; color: var(--ml-ink2); font-size: 12.5px; text-align: left; cursor: text; }
.ml-field { display: flex; flex-direction: column; gap: 3px; margin-top: 10px; color: var(--ml-ink2); font-size: 12px; }
.ml-refs-head { display: flex; align-items: center; gap: 8px; margin: 14px 0 4px; color: var(--ml-ink2); font-size: 12px; }
.ml-refs-head b { color: var(--ml-ink); font-weight: 600; }
.ml-ref { margin: 3px 0; padding: 1px 0 1px 4px; border-left: 2px solid var(--ml-line); }
.ml-ref[data-open="1"] { border-left-color: var(--ml-ink2); }
.ml-ref-head { display: flex; align-items: center; gap: 2px; min-height: 24px; }
.ml-ref-toggle { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--ml-ink2); cursor: pointer; }
.ml-ref-title { flex: 1 1 auto; min-width: 0; overflow: hidden; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
.ml-ref-actions { flex: none; display: inline-flex; opacity: 0; }
.ml-ref-head:hover .ml-ref-actions, .ml-ref-head:focus-within .ml-ref-actions { opacity: 1; }
.ml-ref-body { padding: 0 0 2px 22px; font-size: 12.5px; }
.ml-ref-edit { margin: 2px 0 4px; font-size: 11px; }
.ml-danger-zone { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
.ml-editor { display: flex; flex-direction: column; gap: 4px; }
.ml-textarea { width: 100%; min-height: 90px; padding: 7px 9px; border: 1px solid var(--ml-ink); border-radius: 7px; outline: none; resize: vertical; background: var(--ml-surface); color: var(--ml-ink); font-family: var(--ml-mono); font-size: 12px; line-height: 1.55; }
.ml-hint { color: var(--ml-ink2); font-size: 11px; }
.ml-chat { flex: 1 1 auto; min-width: 0; min-height: ${CHAT_MIN}px; display: flex; flex-direction: column; }
.ml-chat-head { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 10px 6px 16px; border-bottom: 1px solid var(--ml-line); color: var(--ml-ink2); font-size: 12px; }
.ml-chat-head b { flex: none; color: var(--ml-ink); font-size: 13px; font-weight: 600; }
.ml-chat-cwd { min-width: 0; overflow: hidden; font-family: var(--ml-mono); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.ml-confirm { display: inline-flex; align-items: center; gap: 6px; color: var(--ml-ink); font-size: 12px; }
.ml-chat-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
/* The Host's embedded conversation sizes itself in percentages: this box only refuses to overflow. */
.ml-chat-embed { flex: 1 1 auto; display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.ml-chat-fallback { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 16px; color: var(--ml-ink2); font-size: 12.5px; }
.ml-chat-fallback p { margin: 0; }

.ml-md { color: var(--ml-ink); font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; user-select: text; cursor: text; }
.ml-md > :first-child { margin-top: 0; }
.ml-md > :last-child { margin-bottom: 0; }
.ml-md p { margin: 0 0 6px; }
.ml-md ul, .ml-md ol { margin: 0 0 6px; padding-left: 20px; }
.ml-md li { margin: 1px 0; }
.ml-md li > p { margin: 0; }
.ml-md li > ul, .ml-md li > ol { margin: 2px 0; }
.ml-md-task { position: relative; list-style: none; }
.ml-md-task > input { position: absolute; left: -19px; top: 3px; margin: 0; accent-color: var(--ml-ink); }
.ml-md blockquote { margin: 0 0 6px; padding: 0 0 0 10px; border-left: 3px solid var(--ml-line); color: var(--ml-ink2); }
.ml-md hr { margin: 8px 0; border: 0; border-top: 1px solid var(--ml-line); }
.ml-md a { color: var(--ml-ink); text-decoration: underline; text-underline-offset: 2px; }
.ml-md-link-x { text-decoration: underline dotted; text-underline-offset: 2px; }
.ml-md-code { padding: 0 4px; border-radius: 4px; background: var(--ml-tint2); font-family: var(--ml-mono); font-size: 11.5px; }
.ml-md-pre { margin: 0 0 6px; max-height: 320px; overflow: auto; padding: 6px 8px; border: 1px solid var(--ml-line); border-radius: 6px; background: var(--ml-tint); font-family: var(--ml-mono); font-size: 11.5px; line-height: 1.5; white-space: pre; }
.ml-md-pre code { font: inherit; }
.ml-md-table { margin: 0 0 6px; overflow-x: auto; }
.ml-md table { border-collapse: collapse; font-size: 12px; }
.ml-md th, .ml-md td { padding: 2px 8px; border: 1px solid var(--ml-line); vertical-align: top; }
.ml-md th { background: var(--ml-tint); font-weight: 600; }
.ml-fence { margin: 0 0 6px; overflow: hidden; border: 1px solid var(--ml-line); border-radius: 7px; background: var(--ml-surface); }
.ml-fence > .ml-md-pre { margin: 0; border: 0; border-radius: 0; }
.ml-fence-head { display: flex; align-items: center; gap: 4px; padding: 3px 4px 3px 8px; border-bottom: 1px solid var(--ml-line); cursor: default; user-select: none; }
.ml-fence-lang { color: var(--ml-ink2); font-family: var(--ml-mono); font-size: 10.5px; }
.ml-fence .ml-mini { min-height: 20px; padding: 0 6px; font-size: 11.5px; }
.ml-run { border-top: 1px solid var(--ml-line); font-size: 11.5px; }
.ml-run-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 3px 8px; color: var(--ml-ink2); }
.ml-run-status { flex: none; color: var(--ml-ink); font-weight: 600; }
.ml-run[data-failed="1"] .ml-run-status { color: var(--dsw-alias-state-error-primary); }
.ml-run-meta { flex: none; color: var(--ml-ink2); font-size: 11px; }
.ml-run-cwd { flex: 1 1 auto; min-width: 0; overflow: hidden; font-family: var(--ml-mono); font-size: 10.5px; white-space: nowrap; text-overflow: ellipsis; }
.ml-run-head .ml-link { flex: none; margin-left: auto; font-size: 11px; }
.ml-run-body { padding: 0 8px 6px; }
.ml-run-out { margin: 0; max-height: 220px; overflow: auto; color: var(--ml-ink); font-family: var(--ml-mono); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-all; }
.ml-run-err { margin-top: 4px; padding-left: 6px; border-left: 2px solid var(--ml-line); color: var(--ml-ink2); }
.ml-spin { flex: none; width: 10px; height: 10px; border: 1.5px solid var(--ml-line); border-top-color: var(--ml-ink); border-radius: 50%; animation: ml-spin 0.8s linear infinite; }
@keyframes ml-spin { to { transform: rotate(360deg); } }
.ml-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .ml-world[data-glide="1"] { transition: none; }
  .ml-card[data-fresh="1"] { animation: none; }
}
`

    /** One stylesheet tag this plugin owns; a hot reload replaces it instead of reusing stale rules. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      for (const tag of document.querySelectorAll('style[data-plugin-css="dsh-mainline"]')) tag.parentNode?.removeChild(tag)
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', 'dsh-mainline')
      tag.setAttribute('data-plugin-css-rev', UI_REV)
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.parentNode?.removeChild(tag)
    }

    /**
     * Re-render on a language change. `locale.subscribe` is called **on** the service (it
     * touches `this`), and a throw here would get the slot entry retired by the shell — a
     * blank panel forever — so it is wrapped.
     */
    function withLocale(ctx, Component) {
      return function LocaleBound(props) {
        activeLang = resolveLang(ctx)
        const [, bump] = useState(0)
        useEffect(() => {
          const locale = ctx.locale
          if (!locale || typeof locale.subscribe !== 'function') return undefined
          let previous = resolveLang(ctx)
          try {
            return locale.subscribe(() => {
              const next = resolveLang(ctx)
              if (next !== previous) {
                previous = next
                bump((value) => value + 1)
              }
            })
          } catch (error) {
            try {
              console.error('[dsh-mainline] 语言订阅失败（面板仍可用）', error)
            } catch {
              /* logging must never throw */
            }
            return undefined
          }
        }, [])
        return h(PanelBoundary, { component: Component, componentProps: { ...props, ctx, lang: resolveLang(ctx) } })
      }
    }

    /**
     * Keep a crash inside this panel: the shell retires a slot entry whose component throws,
     * which a person sees as a blank panel that never comes back. (A class only because
     * React error boundaries have to be one.)
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = () => this.setState({ error: null })
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-mainline] 面板渲染出错', error)
        } catch {
          /* logging must never throw */
        }
      }

      render() {
        if (this.state.error !== null) {
          const lang = this.props.componentProps?.lang ?? activeLang
          return h(
            'div',
            { className: 'ml-root' },
            h('div', { className: 'ml-state', role: 'alert' }, translate(lang, 'boundary.error', { message: this.state.error?.message ?? String(this.state.error) }), h('button', { type: 'button', className: 'ml-btn', onClick: this.retry }, translate(lang, 'action.retry'))),
          )
        }
        return h(this.props.component, this.props.componentProps)
      }
    }

    // ------------------------------------------------------------------ apply

    return {
      inject: ['sessions', 'uiWorkspace', 'slots', 'locale'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTS), `${LOCALE_NS}: dictionaries`)
        ctx.effect(installStyles, `${LOCALE_NS}: styles`)
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: SLOT_ID,
              order: 85,
              label: () => (resolveLang(ctx) === 'zh' ? zh['entry.label'] : en['entry.label']),
              locale: LOCALE_NS,
            },
            Glyph,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: SLOT_ID,
              locale: LOCALE_NS,
              // The session-scoped child is the door the embedded conversation renders
              // through: under a SessionProvider its useSession binds to our session.
              children: { [CHAT_SLOT]: { kind: 'single', scope: 'session' } },
            },
            withLocale(ctx, Panel),
          ),
        )
        // Registered on its own: `slots.inject` fires once the spec exists, which the
        // children declaration above is what creates.
        ctx.slots.inject(CHAT_SLOT, () => ctx.slots.register({ name: CHAT_SLOT }, ChatConversation))
      },

      /** Pure helpers, for test/client.test.mjs. */
      __test: {
        parseMarkdown,
        parseInline,
        plainInline,
        extractFences,
        scanFences,
        peekOf,
        toggleTask,
        indexTree,
        isLive,
        lineOf,
        refsOf,
        countTodo,
        shortTitle,
        withDraft,
        computeFolds,
        foldSignature,
        nextFold,
        globalFold,
        nextGlobalFold,
        globalModeOf,
        revealPath,
        chainOf,
        layout,
        laneNeighbour,
        indentTarget,
        elbow,
        normalizeView,
        wheelIntent,
        translate,
        DICTS,
        CSS,
        constants: { SLOT_ID, CHAT_SLOT, LOCALE_NS, API, DRAFT_ID, VG, HG, FP, FT, FB, LANE_MIN, SHELL_LANGS },
      },
    }
  },
})
