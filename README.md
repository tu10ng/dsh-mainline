# dsh-mainline · 工作树

DeepSeek Harness 插件：把工程工作记成**攻略**，而不是清单。

- **主线**：照着走的步骤，从上往下。
- **分叉**：主线在这里分成几条并排的支线（两套环境、两个互相竞争的猜想），走完合回主线。
- **参考**：挂在某一步上的命令、代码位置、寄存器值、链接、设计文档。查的，不是走的，不画进主线。
- **疑问**：带 `?` 的一步；有了答案写进正文，改成「不用做」。

状态只有三种：记录、要做、不用做（做完了或暂停了，不区分）。

## 和 AI 一起用

右侧是一个**普通的 DSH 会话**（侧边栏里也能看到，所有插件、工具、审批照常生效）。

- 你在面板上点卡片、改状态、分叉、移动，这些操作都会排进这个会话的收件箱，**不打断 AI**，跟你的下一句话一起送到；
- AI 每一轮都知道你此刻聚焦在哪个项目、哪一步、前后是什么；
- 卡片里的 `bash` / `pwsh` 代码块可以 **▶ 运行**（宿主的 shell，输出贴在代码块下面），也可以 **交给 AI**；
- AI 用 `mainline_*` 工具读写这棵树；
- 所有改动都是事件：写进 `.mainline/events.jsonl`，并以 `mainline/event`、`mainline/<type>` 发到 cordis 总线，别的插件可以监听。

## 数据是纯文本，自带 git

```
$DSH_HOME/mainline/          一个 git 仓库，插件自己提交
  mainline.json              项目顺序
  blog.md                     一个项目一个 Markdown 文件：标题层级就是树的层级
  homelab.md
  .mainline/                 本机状态（不进 git）：锁、事件日志、会话 id、视图
```

````markdown
# HALT NAS 迁移到 ZFS {#hl01}

## REF 设计文档 {#r2des}

## FORK 两台机器 {#r2fork}

### nas-b {#r2lq}

#### 换盘 {#r2q03}

```bash
dmesg | grep -i ata
```

##### REF 校验 {#r2q03b}

## TODO ? mpu 是否不跑该函数 {#q1}
````

可以直接用编辑器改这些文件，插件会发现外部修改并提交（`external`）；面板和 AI 的写入都走同一把跨进程锁。几秒内的改动合成一次提交；恢复旧版本是一次新提交，从不改写历史。

## 操作

| 操作 | 方式 |
|---|---|
| 选中（AI 会知道） | 点卡片 |
| 改名 | 双击标题 / Enter |
| 加下一步 | Ctrl+Enter |
| 折叠 / 展开 / 全部展开 | Tab（选中的卡片）；Shift+Tab（整个项目：总览 → 目录 → 全部） |
| 自由摆放 / 复位 | 拖动卡片；R 复位，Shift+R 全部复位 |
| 移动结构 | Ctrl+X，然后 Ctrl+V（下一步）/ Ctrl+Shift+V（子步骤） |
| 其他 | 右键菜单 |

## 安装（开发中）

```sh
dsh plugin --profile web add link:<本仓库路径>
```

然后在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加上 `dsh-mainline`，重启 dsh-web。

本地调试面板不需要 DSH：`npm run dev` → http://localhost:4710/（真实的宿主端 + 临时目录 + 假 shell）。

```sh
npm run verify   # 静态检查 + 全部测试
```

设计约定见 [docs/SPEC.md](docs/SPEC.md)。
