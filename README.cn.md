# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md)

用于 Pi 的 Claude Code Worker 监督扩展。MVP 中 Pi 负责生命周期、状态机、策略门和独立验收；Worker 只是被显式启动的子进程。

> `v0.5.3` 已发布为单 Worker recovery 基线。默认手动 transport 是无额外依赖的
> process pipe，不是 PTY；自动模式支持 Claude JSONL 或 Supervisor 自有的 tmux bridge，被接管的
> tmux session 仍仅限手动交互。当前工作树已实现
> repairable/persistent 能力拆分、可取消验收/Reviewer、证据完整性门禁、启动前
> preflight 和阶段进度通知；真实 Claude Code `2.1.270` 允许编辑的
> repair/reacceptance 演练已在隔离临时 worktree 通过。确认的产品目标是本地开发
> 完全无人值守；详见 [自动化目标](docs/autonomy-target.md)。代码进入远程仓库或
> main/integration 分支仍必须经过独立边界；Supervisor 管理的直接 push/merge 请求会拒绝，
> 而嵌套/自定义能力的硬边界必须由独立保护机制提供。
>
> **无人值守状态：** 自动模式会自主完成本地修改、测试、有限修复、验收、独立 Review
> 和本地提交检查；无法形成候选时自动挂起为不可发布候选。可选出站通知不授予权限，
> push 和 main/integration merge 仍必须经过独立边界。无人值守场景下的失败（Worker 意外退出、
> watchdog 超时、清理未确认）也会发出 `candidate_failed` 通知，状态为 `failed`；webhook 投递
> 会对瞬时错误重试。

## 关键安全边界

- 不会在扩展加载时自动启动 Worker。
- 不经过 shell 启动子进程。
- 手动 Worker 保留小型继承环境，调用方也可以显式传入任意变量。自动 Claude Worker 继承 Supervisor 的完整环境，只移除 `CLAUDECODE`（Claude Code 用它拒绝嵌套会话）；远程凭据、Git/包管理器 helper、自定义配置和网络设置都不会被过滤。
- 自动模式保留完整 Claude Code 工具面，包括 Agent、Task、后台任务、插件和 MCP；会从生效的 `HOME`/`CLAUDE_CONFIG_DIR` 检查 CLI/配置，并拒绝预授权 `Bash` 的规则；在未指定时加入 Claude 的安全 `default` permission mode，使 Bash 请求仍能被 Supervisor 看到（不会移除 Bash 工具本身）。自动 tmux bridge 会在实际 spawn Claude 子进程前再次同步检查设置，启动间隙发生修改时 fail closed。适配器再添加 stream-json transport framing，并把所有 Worker 后代放入 Supervisor 自有的清理边界。由于没有同步在线用户，`AskUserQuestion` 会转换为普通文本。
- 本地命令和权限行为按任务/运行时策略处理；已知的直接 remote push/main-integration 操作和 Git 元数据写入仍会拒绝或挂起，不要求同步人工响应。嵌套/自定义工具继承这些能力并随 Worker 清理，不另起第二套 Supervisor 权限循环。
- Linux 上优先使用可写的 cgroup v2 清理后代进程，包括 `setsid()` 后代；不可用时回退到进程组清理。需要强制失败闭环时，embedding 集成可使用 `cgroupMode: "required"`，并会在 Claude 启动前执行 preflight。
- 自动模式只接受裸的 `claude`/`claude.exe` 命令名，并从 Supervisor 的 PATH 解析、固定由操作者拥有的可执行文件（或使用 `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` 固定路径）；显式路径和可写/不可信位置会被拒绝。自定义工具和嵌套 Worker 是受信任能力，硬性的 remote/main 边界仍必须由此进程之外的独立受保护边界提供。
- Worker 声称完成只会进入 `verifying`，不能作为成功证据。
- 默认独立验收命令为 `git diff --check`。
- 目标是任务启动后本地开发无人值守：Worker 可以修改、测试、修复和本地提交；Supervisor 管理的 remote push 或合并到 `main`/integration 分支请求仍会拒绝，嵌套/自定义能力的最终 remote/main 边界必须由独立保护机制提供。
- 扩展运行时不执行 merge、deploy、release 或 publish；远程/main 集成和仓库 Release 必须经过独立受保护边界。
- 默认 4 小时总时限、20 分钟无输出 watchdog 超时即停止 Worker；paused 期间不消耗无输出预算，resume 会重建基准但不会重置总时限。嵌入调用方可将对应选项设为 `0` 关闭。
- 验收命令、仓库证据收集和独立 Reviewer 共用 abort signal，人工 stop/shutdown 不必等待完整超时。

## 安装和使用

需要 Pi 0.85+ 和 Node.js 22.19+。

Pi 发布的可执行文件可能是 Bun 编译版，因此 Linux cgroup 和 tmux helper
脚本会从 `PATH` 解析真正的 `node`，不会假定 `process.execPath` 支持 `-e`。
如果 Node 不在 Supervisor 的 `PATH` 中，可设置 `PI_CLAUDE_SUPERVISOR_NODE` 指定
可执行文件路径。

```text
pi install npm:pi-claude-supervisor
```

在 Pi 中使用。手动/兼容模式默认使用 process-pipe。要启用事件驱动的 Pi Decision Worker，使用 Claude JSONL 自动模式：

```bash
export PI_CLAUDE_SUPERVISOR_MODE=auto
export PI_CLAUDE_SUPERVISOR_WORKER='claude --permission-mode acceptEdits'
# 可选：候选/失败通知；generic 或 wecom
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL='https://example.invalid/webhook'
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT=generic
# export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_SECRET='shared-secret'
# 每轮独立 Reviewer 的总预算（毫秒），含一次针对 provider 错误的重试（默认 10 分钟）
# export PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS=600000
# events.jsonl 达到该大小（字节）后滚动为带时间戳的文件，保留 5 份（默认 64 MiB）
# export PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES=67108864
```

自动模式支持 `claude-jsonl` 和 Supervisor 自有的 tmux bridge；JSONL 的 `result`、
`control_request` 和进程 `exit` 事件会唤醒 Decision Worker。tmux bridge 把结构化记录
通过同一个 live PTY 的私有 terminal framing 传回适配器，不创建独立 JSONL sidecar；
`adopt-tmux` 仍是手动模式。真实 Claude 检查默认从 `PATH` 解析当前 CLI（包括安装器提供的 `latest` 路径），支持 Claude Code `2.1.270` 及以上版本；本轮的已记录演练版本为 `2.1.270`。

然后在 Pi 中使用：

```text
/supervise capabilities
/supervise start inspect the current repository
/supervise start --spec ./task.json
/supervise poll
/supervise sessions
/supervise recover [--takeover] <task-id>
/supervise stop human requested stop
/supervise verify
/supervise approve <task-id> allow|deny [request-id]
/supervise takeover <task-id>
/supervise resume-auto <task-id>
/supervise install-hooks
/supervise uninstall-hooks
```

`--spec` 接受 JSON 文件；验收命令始终使用 argv 执行，不经过 shell。例如：

```json
{
  "goal": "实现请求的修改",
  "scope": ["src/"],
  "constraints": ["保持公共 API 兼容"],
  "forbidden": ["不要发布构建产物"],
  "acceptance": [
    { "id": "tests", "name": "tests", "command": "npm", "args": ["test"], "required": true }
  ],
  "maxRepairRounds": 3,
  "autonomy": {
    "unattended": true,
    "requireLocalCommit": true,
    "maxDecisionRetries": 2
  }
}
```

候选/失败通知的 generic JSON 格式为（旧 human-intervention webhook 名称保持兼容）：

```json
{
  "schema": "pi-claude-supervisor/candidate/v1",
  "event": "candidate_status",
  "task": { "id": "...", "goal": "...", "cwd": "..." },
  "worker": { "id": "..." },
  "reason": "...",
  "status": "ready|blocked|failed",
  "deliverable": false,
  "note": "This notification does not grant remote push or main/integration merge permission."
}
```

当前 webhook 只是出站候选通知，不直接接受批准命令；显式 stop、takeover 等兼容控制仍通过 Pi。
Worker 意外退出、watchdog 超时或清理未确认等无人值守失败会发出 `candidate_failed` 通知（`status: "failed"`），webhook 投递对 429/5xx/网络错误重试 3 次。

自动模式会将 Decision Worker 会话持久化到状态目录。Pi 非正常重启后，`/supervise sessions`
会显示 `recoverable` 任务；显式执行 `/supervise recover [--takeover] <task-id>` 会恢复 Decision Worker 上下文并
重新启动 Claude Worker，不会静默恢复或重复执行任务。旧 Pi 进程已退出且租约确认旧 Worker
进程组已消失且 cgroup 仍是真实、可读取的空边界时，才可显式添加 `--takeover`；缺失、仍存活或无法确认的 Worker 会被拒绝。自动 Worker 会保留已验证为空的 cgroup，直到所属 cwd 租约释放，以覆盖正常退出后 Pi 在租约收尾前崩溃的窗口；释放租约时再删除它。租约获取时会先持久化“尚未 spawn”的启动标记；适配器会在创建 cgroup/socket 前持久化生成的资源计划，再分阶段记录 cgroup identity 和 tmux server identity，启动期崩溃恢复会检查并清理已创建但尚未完成登记的空资源，而不是假定没有资源。只有确认旧 owner 已退出后才能接管残留标记。租约拒绝被替换或改名的 cgroup。自动 tmux 还要求确认 Supervisor 所有、tmux server identity 已死亡、私有 tmux session 已消失，并先持久化 cleanup-pending 事务，再原子保留私有 socket；替换会复用旧租约记录，写入新租约后才释放保留并删除 guardian 留下的空 cgroup；若恢复中断，新的 Supervisor 会先协调该待清理事务。手动 owned tmux
Worker 可在重启后使用 `adopt-tmux`，而不是 takeover；自动 bridge 会由 parent-death guardian
在 Supervisor 消失时终止，只有通过上述证据检查的 `recover --takeover` 才能重新取得 cwd lease。
自动模式下，Decision Worker 在任务授权范围内自动处理普通问题、测试失败和修复轮次，记录假设和证据；无法形成可交付候选时自动挂起并保留证据，而不是要求人工必须在线。可通过 `PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT=0` 或 task `autonomy.requireLocalCommit` 关闭本地 commit 要求，但自动模式仍要求有效 Git baseline 和可验证的 worktree——任务锚定在该 baseline commit 上，而不是分支名：任务可以在任意分支（包括 `main`）上启动或落地候选，因为 Worker 经常会在任务过程中自行切换分支。远程 push、merge/PR 以及对受保护分支的破坏性改写（硬 reset、直接改写 ref、或删除/移动/强制更新分支）仍由独立边界拒绝。

`v0.5.0` 已完成并发布“多命令验收—独立只读 Reviewer—结构化修复轮次—再次验收”闭环。
任务可通过 API 或 JSON spec 提供 `goal`、`scope`、`constraints`、`forbidden`、多个
`acceptance` 命令和 `autonomy` 控制；旧的纯文本任务继续使用默认 `git diff --check`。
Reviewer 只能使用 `read`、`grep`、`find`、`ls`，不会修改工作树或批准权限。自动模式在
Worker 启动前捕获 git baseline，要求完整的 baseline-relative tracked/commit/untracked evidence，
并在默认情况下要求 Worker 在候选所在的分支（包括受保护分支）本地 commit；候选通知会报告候选当前所在的分支及其是否受保护，仅作信息展示。无效输出、证据不完整、重复 finding、P0/P1 或预算耗尽
会自动挂起候选。自动模式拒绝 process-pipe，并在模型执行前检查目录、可执行文件、依赖
和 cgroup；Claude 的完整工具、Agent/Task、插件、MCP、网络和环境会保持可用。自动模式会在未指定时加入安全的 `default` permission mode，并拒绝 Bash 预授权；Bash 仍通过 Supervisor 可见的 permission request 使用。详见 [自动化目标](docs/autonomy-target.md)。协同多 Worker 属于后续独立开发阶段，
自动模式只接受裸的直接 Claude 命令名，会固定解析后的操作者拥有的可执行文件；任意自定义可执行文件和显式可执行路径会在自动模式拒绝。需要固定路径时设置 `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE`。自定义工具和嵌套 Worker 的 remote/main 权限必须由独立 host/仓库边界保护。

### 交互式 tmux 模式（hooks）

`PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux` 现在默认在 tmux pane 中运行真实、未经修改的
Claude Code TUI——就是你自己运行 `claude` 时看到的那个界面——而不是下文描述的结构化
stream-json bridge。你可以随时 attach 到打印出的 `attach=...` 命令上观察，或者亲自输入；
Pi 通过 Claude Code 自身的 hooks 上报事件，而不是抓取屏幕文字。

一次性设置，每台机器/每个用户只需执行一次：

```text
/supervise install-hooks
```

这会在 `~/.claude/settings.json`（或 `$CLAUDE_CONFIG_DIR/settings.json`）中为全部
七个 Claude Code hook 事件注册一个小型 relay 命令；`/supervise uninstall-hooks` 只会
移除这一条目。owned 的 `/supervise start` 不需要这一步——它会传入自己的 `--settings`
文件——但 `/supervise adopt-tmux` 运行在你自己的 Claude Code 配置中，因此需要它。

```bash
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
export PI_CLAUDE_SUPERVISOR_MODE=auto
# 改为使用旧版 stream-json-in-a-pane transport：
# export PI_CLAUDE_SUPERVISOR_TMUX_MODE=bridge
```

```text
/supervise start <task>
/supervise adopt-tmux <tmux-session> <task>
```

Pi 会在 Claude 结束一轮对话时（`Stop`；轮中 API/模型失败会以 `StopFailure` 到达并按"出错的一轮"
交给 Decision Worker 重试；提示符空闲一分钟且没有结束信号时作为兜底把这一轮收尾）、Claude 即将向你展示真实权限提示时（仅此时——
其余每一次普通工具调用都交给你自己的 Claude Code 权限模式处理）、Claude 询问
`AskUserQuestion` 时（Decision Worker 会选择一个答案，Claude 以普通文本形式继续，
与无人值守自动模式中完全一致），以及 session 退出时介入。在展示提示之前的
`PreToolUse` 否决点只会拒绝已知的直接远程 push/merge/PR 或其他破坏性/受保护分支操作
（或转发一个 `AskUserQuestion`）；它从不干预普通的编辑、读取或本地命令——那些请求会
直接进入你自己的权限模式，Pi 完全不做决策。

**这对安全边界意味着什么。** 交互式模式有意不执行 headless 模式那条"拒绝设置中预授权
`Bash` 或 `auto`/`bypassPermissions` 模式"的检查：你自己的 Claude 配置决定 Claude 无需询问
就能做什么，和你亲自运行 Claude 时完全一样。凡是你的设置已经放行的操作都不会到达
Decision Worker，它只在 Claude 本来要问*你*的地方做判断。硬边界（远程 push/merge/PR、
远端 CLI 变更、`.git` 写入、受保护分支的破坏性改写）由 `PreToolUse` hook 强制执行，
与权限模式无关——已在 Claude Code 2.1.273 的 `auto` 模式下实测——这也是该模式在你自己的
设置之外唯一的保证。需要让每个 `Bash` 调用都经过 Supervisor 时，请使用 headless（`bridge`）模式。

**人机协同。** 如果你在已 attach 的 session 中输入内容，自动化会暂停
（`human_takeover`，以警告形式呈现），直到你执行 `/supervise resume-auto <task-id>`；
你接管期间完成的那一轮会在此时重放给 Decision Worker，因此不会丢失已经完成的工作。

**完成后保持会话开启。** 与其他 transport 不同，任务完成后默认只是让 Pi 与该会话断开，
而不是关闭它，方便你在同一窗口中继续工作或查看 Claude 做了什么；`/supervise stop
<task-id>` 可以显式关闭它。设置 `PI_CLAUDE_SUPERVISOR_CLOSE_WORKER_ON_COMPLETION=1`
可恢复旧的“完成即关闭”行为。被阻塞或失败的候选仍会像以往一样停止 Worker。

**企业微信/出站通知。** 候选通知和“需要你”通知（被阻塞并提出问题的候选，或人工接管通知）
都会在涉及 tmux session 时附带一个 `attach` 字段，内容是可直接执行的
`tmux -S <socket> attach -t <session>` 命令。

**成本核算的限制。** TUI 的 `Stop` hook 没有 `total_cost_usd` 或 token `usage`
（这些字段只出现在 Claude 自己的 `result` stream-json 记录中，而 TUI 不会产生这种记录），
因此交互模式下的成本统计只计算轮次，不计算费用；`--max-budget-usd` 同样不可用
（Claude Code 只在 `-p` 模式下强制执行它），也不会传给交互式启动。如果设置了
`autonomy.maxWorkerCostUsd`，请预期它在交互模式下不起作用；需要硬性成本上限时请使用
bridge/jsonl 模式。

**信任对话框。** Claude Code 第一次在某个目录中运行时，可能会先弹出它自己的一次性
“是否信任该文件夹”对话框，然后 hook 才会开始生效；像对待未受监督的 `claude` session
一样 attach 并按一次 Enter 确认即可。

**恢复。** `/supervise recover` 不会持久化原始任务是否为交互式；它在恢复时根据当前的
`PI_CLAUDE_SUPERVISOR_TRANSPORT`/`PI_CLAUDE_SUPERVISOR_TMUX_MODE` 配置来判断，因此在
启动任务和恢复任务之间请不要改变这两个配置。

### tmux/PTY 交互模式（bridge 模式）

本节描述的是此前就存在的自动 tmux transport：在 pane 内运行结构化的
stream-json bridge，而不是真实 TUI。它只适用于自动模式
（`PI_CLAUDE_SUPERVISOR_MODE=auto`）的 tmux session，且只有显式设置
`PI_CLAUDE_SUPERVISOR_TMUX_MODE=bridge` 时才会启用；手动（非 `auto`）tmux
session 始终直接在 pane 中运行 Claude，不受此设置影响。

如果希望在可见的 Claude Code 终端中工作，可显式启用 tmux transport：

```bash
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
export PI_CLAUDE_SUPERVISOR_WORKER='claude'
# 当前手动 tmux 也要求 Linux（用于 pane identity 和清理）；可使用 cgroup auto/off。
# 设置 PI_CLAUDE_SUPERVISOR_MODE=auto 启用 Supervisor 自有的自动 bridge；自动 tmux
# 要求 Linux cgroup v2 和 parent-death guardian，缺失时会 fail closed。
# 接管非默认 tmux server 时可选：
# export PI_CLAUDE_SUPERVISOR_TMUX_SOCKET=/path/to/tmux.sock
```

`/supervise start <task>` 会在私有 tmux server 中启动 Claude，并返回可复制的 attach 命令。
可以在另一个终端 attach 到同一个 PTY，观察或人工输入。多行消息通过 tmux buffer 和 Enter
发送，不会把消息拼接进 shell 命令；`pipe-pane` 记录原始输出，`capture-pane` 检测稳定的 Claude
输入提示，并复用 watchdog、审计和独立验收流程。自动模式会在 pane 内启动 bridge：它运行
Claude stream-json、把可读输出渲染到附着的终端，并通过同一 PTY 的私有 framing 返回结构化
记录；bridge 及其后代放入受 Supervisor 管理的 Linux cgroup，并由 parent-death guardian
保护；bridge 会在 spawn Claude 前再次读取生效设置，任一 containment 机制或权限检查不可用时 fail closed。适配器直接从 PTY 原始 pipe 解析，因此没有
独立 JSONL sidecar。自动模式拒绝被接管的 session；Supervisor 自有 bridge 支持自动输入串行化、
权限响应、turn 完成和 stop。

如果 Claude 已由你在 tmux 中启动，可以显式接管且不会重放原始任务：

```text
/supervise adopt-tmux <tmux-session-name> <task description>
```

接管会检查 cwd、pane 中的进程，并拒绝已有其他输出 pipe 的 pane；但不宣称拥有该 session。owned session 使用自动生成的私有 tmux socket，
请保存 `start` 输出的完整 `attach=...` 命令。Pi 重启后重新接管时，先把该命令中的 socket 路径设置到
`PI_CLAUDE_SUPERVISOR_TMUX_SOCKET`；只有默认 server 才能只使用 session 名称。对被接管的 session，
`/supervise stop` 和 Pi 关闭只会断开监督，不会杀掉你的 tmux 窗口；需要关闭时请由你执行
`tmux kill-session`。`/supervise takeover <task-id>` 会暂停 Decision Worker 自动发送，只有
`/supervise resume-auto <task-id>` 才恢复。

PTY 屏幕文字本身不是 Claude JSONL，不能把屏幕文字当作结构化权限证据；只有 Supervisor bridge
的私有 framing 记录才是结构化证据。TUI 决策应按任务授权策略处理并记录；无法形成候选时可以自动挂起，不要求人工持续在线。普通终端里已经运行的 Claude 不能安全迁移进 tmux；`--resume`
是读取历史的新进程，不是实时 attach。实时测试请使用 plan/read-only 参数。

可以从不同工作目录启动多个任务会话；活动会话不能共享同一 cwd，建议每个任务使用独立 worktree：

```text
/supervise sessions
/supervise poll all
/supervise poll <task-id>
/supervise send <task-id> continue after checking the test failure
```

当前支持的是**独立任务会话并行**，不是共享工作树的协同多 Worker。后续多 Worker
开发任务会引入 parent/child 任务图、依赖、并发上限、结构化 handoff、汇总验收和
跨进程恢复，但不会放宽“一个 worktree 一个写入者”的边界，也不会自动 merge 或 publish。
该阶段应安排在 Claude `2.1.270` 以上版本的稳定性统计和单 Worker recovery 语义完成之后。

Pull Request 必须通过聚合的 `CI / Quality gate`。Release Please 根据 Conventional Commits 创建版本 PR；维护者合并后，Release workflow 会针对精确 tag commit 重新验证，并通过受保护的 `npm` environment 使用 npm provenance 发布。

详细内容见 [engineering-plan.md](docs/engineering-plan.md)、[autonomy-target.md](docs/autonomy-target.md)、[independent-review.md](docs/independent-review.md)、[architecture.md](docs/architecture.md)、[testing.md](docs/testing.md) 和 [releasing.md](docs/releasing.md)。

## Token 消耗与成本控制

以下数据来自一次真实的无人值守 review 任务（总耗时 29 分钟）：

| 组成部分 | 轮次/调用次数 | Token | 花费 |
| --- | --- | --- | --- |
| Claude Code Worker | 70 轮 | 15.5M cache-read + 370k cache-write + 100k output | $18.46 |
| Pi Decision Worker | 30 次模型调用 | 约 1.0M（91k 未缓存 + 914k cache-read） | $0.04 |

花费几乎全部来自 Worker，而不是 Supervisor 自身的 Decision Worker 或 Reviewer 调用。这次运行中
Worker 每轮平均消耗约 22 万 token 的上下文，原因是它以单个长期 `-p` session 运行在 1M token 窗口下，
从未触发过 compact；一次普通的 Claude Code 轮次仅系统提示词就要消耗约 2.4 万 prompt token，
与配置了哪些 MCP server 无关。30 次 Decision Worker 调用中有 28 次是权限请求；Decision Worker
推翻确定性 policy 的情形有 4 次（拒绝下载和任务目录之外的写入）——这正是默认 `permissionAuthority`
选择 `hybrid` 而不是 `policy` 的原因。把这 28 次请求回放到实际发布的 `isRoutinePermission`
分类器，有 4 次可在本地直接回答；那次任务以内联 `node -e` 脚本和 `$(...)` 替换为主，这两类
永远不算例行操作。普通实现类任务主要是 cwd 内的 `Edit`/`Write`、`npm test` 和
`git status/diff/add/commit`，这些都是例行操作，Decision Worker 调用次数会下降得多得多。

各项开关及其默认值和取舍：

- `PI_CLAUDE_SUPERVISOR_PERMISSION_AUTHORITY` / `autonomy.permissionAuthority`
  （`policy` | `hybrid`，默认 | `decision-worker`）：`hybrid` 会让确定性 policy
  （`src/policy.ts` 的 `isRoutinePermission`）直接回答任务目录内的常规文件编辑和本地
  只读/开发类 shell 命令，其余请求以及任何 policy 拒绝仍会发给 Decision Worker。
  它主要节省的是延迟和 Decision Worker 的上下文大小，而不是费用：上面的 30 次调用本身只花了 $0.04。
- `PI_CLAUDE_SUPERVISOR_WORKER_MODEL` / `--model`：Opus 级和 Sonnet 级模型之间大约相差 5 倍价格，
  是账单上最大的单一杠杆；这是操作者自己的选择，Supervisor 不会替你决定。
- `PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS`（自动模式默认 200000；`0` 保留 Claude 自身默认值）：
  限制每轮 Worker 的上下文大小，避免像本例一样持续累积到约 22 万 token/轮；能节省几十个百分点，
  但会牺牲一些上下文质量。
- `PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD` / `autonomy.maxWorkerCostUsd`：作为 `--max-budget-usd`
  传给 Claude，并由 Supervisor 根据 Worker `result` 的累计花费再次核对；这是一个上限而不是节省手段，
  达到上限的任务会连同证据一起被挂起。
- `PI_CLAUDE_SUPERVISOR_WORKER_MCP_CONFIG`（`--strict-mcp-config --mcp-config`）：限制 Worker 只能
  使用列出的 MCP server；它约束的是 Worker 能触达的范围，而不是普通轮次约 2.4 万 token 的固定开销。
- `PI_CLAUDE_SUPERVISOR_DECISION_MODEL` / `PI_CLAUDE_SUPERVISOR_REVIEWER_MODEL`
  （`provider/model-id`，例如 `anthropic/claude-haiku-4-5-20251001`）：Pi Decision Worker 和
  Reviewer 使用的模型。本例中 Pi 侧花费本就只有几美分，换更便宜的模型主要是换取延迟，而不是显著省钱。
- `PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS`（默认 60000；`0` 关闭）：当持久化的 Decision Worker
  session 估算的上下文超过该阈值时主动 compact，并在 compact 之后的下一次 prompt 里重新发送一次
  启动指令。

Supervisor 记录的是实际花费，而不是事后估算：每条 Worker `result` 记录都会生成一条 `worker_usage`
事件，每次 Decision Worker/Reviewer 模型调用都会生成一条 `pi_usage` 事件，二者都会累计进
`session.usage`（`SupervisorTokenUsage`）。`/supervise status <task-id>` 会打印一行
`cost=… workerTurns=… workerTokens=… piTokens=… decisionCalls=… reviewerCalls=…` 摘要；
进度通知携带 `SupervisorProgress.costUsd`/`.piTokens`，候选通知则通过 `CandidateNotice.usage`
携带同样的摘要（generic webhook 以数值型 `usage` 对象输出，WeCom 格式追加两行费用/tokens）。

除了 Worker 模型和预算的选择之外，以上机制本身并不会改变任务的实际花费；Supervisor 侧的这些改动
主要是削减 Decision Worker 的 token 消耗和延迟，而这部分原本就只有几美分。对成本敏感的无人值守
场景，一个合理的起点是：`PI_CLAUDE_SUPERVISOR_WORKER_MODEL` 选择 Sonnet 级模型、为任务设置明确的
`PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD`、保留默认的 `hybrid` permission authority，并将
`PI_CLAUDE_SUPERVISOR_DECISION_MODEL` 设为 Haiku 级模型。
