# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md)

用于 Pi 的 Claude Code Worker 监督扩展。MVP 中 Pi 负责生命周期、状态机、策略门和独立验收；Worker 只是被显式启动的子进程。

> `v0.5.2` 已发布为单 Worker recovery 基线。默认手动 transport 是无额外依赖的
> process pipe，不是 PTY；自动模式只使用 Claude JSONL 或 tmux。当前工作树已实现
> repairable/persistent 能力拆分、可取消验收/Reviewer、证据完整性门禁、启动前
> preflight 和阶段进度通知；真实 Claude Code `2.1.270` 允许编辑的
> repair/reacceptance 演练已在隔离临时 worktree 通过。确认的产品目标是本地开发
> 完全无人值守；详见 [自动化目标](docs/autonomy-target.md)。代码进入远程仓库或
> main/integration 分支必须经过独立边界，Worker 不拥有 push/merge 权限。
>
> **无人值守状态：** 自动模式会自主完成本地修改、测试、有限修复、验收、独立 Review
> 和本地提交检查；无法形成候选时自动挂起为不可发布候选。可选出站通知不授予权限，
> push 和 main/integration merge 仍必须经过独立边界。

## 关键安全边界

- 不会在扩展加载时自动启动 Worker。
- 不经过 shell 启动子进程。
- Worker 只继承最小环境；凭据必须由调用方显式传入。
- 本地命令和权限行为按任务/运行时授权策略处理；超出授权的动作自动拒绝或挂起，不要求同步人工响应。
- Linux 上优先使用可写的 cgroup v2 清理后代进程，包括 `setsid()` 后代；不可用时回退到进程组清理。需要强制失败闭环时，embedding 集成可使用 `cgroupMode: "required"`，并会在 Claude 启动前执行 preflight。
- 普通联网查询不因联网本身被拒绝；下载后直接交给 shell 等高风险模式按配置处理，无法安全处理时挂起候选。
- Worker 声称完成只会进入 `verifying`，不能作为成功证据。
- 默认独立验收命令为 `git diff --check`。
- 目标是任务启动后本地开发无人值守：Worker 可以修改、测试、修复和本地提交；Worker 必须没有远程 push 或合并到 `main`/integration 分支的权限。
- 扩展运行时不执行 merge、deploy、release 或 publish；远程/main 集成和仓库 Release 必须经过独立受保护边界。
- 默认 4 小时总时限、20 分钟无输出 watchdog 超时即停止 Worker；paused 期间不消耗无输出预算，resume 会重建基准但不会重置总时限。嵌入调用方可将对应选项设为 `0` 关闭。
- 验收命令、仓库证据收集和独立 Reviewer 共用 abort signal，人工 stop/shutdown 不必等待完整超时。

## 安装和使用

需要 Pi 0.85+ 和 Node.js 22.19+：

```text
pi install npm:pi-claude-supervisor
```

在 Pi 中使用。手动/兼容模式默认使用 process-pipe。要启用事件驱动的 Pi Decision Worker，使用 Claude JSONL 自动模式：

```bash
export PI_CLAUDE_SUPERVISOR_MODE=auto
export PI_CLAUDE_SUPERVISOR_WORKER='claude --safe-mode --tools Bash'
# 可选：候选/失败通知；generic 或 wecom
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL='https://example.invalid/webhook'
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT=generic
# export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_SECRET='shared-secret'
```

自动模式默认使用 `claude-jsonl`，通过 `result`、`control_request` 和进程
`exit` 事件唤醒 Decision Worker；显式选择 tmux 时仍使用屏幕交互，不使用 JSONL 权限协议，也不会依赖 `/supervise poll` 轮询。本版本固定按已验证设备的
Claude CLI `2.1.270` 运行，跨版本兼容性不在本轮范围内。

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
自动模式会将 Decision Worker 会话持久化到状态目录。Pi 非正常重启后，`/supervise sessions`
会显示 `recoverable` 任务；显式执行 `/supervise recover [--takeover] <task-id>` 会恢复 Decision Worker 上下文并
重新启动 Claude Worker，不会静默恢复或重复执行任务。旧 Pi 进程已退出且租约确认旧 Worker
进程组已消失且 cgroup 仍是真实、可读取的空边界时，才可显式添加 `--takeover`；缺失、仍存活或无法确认的 Worker 会被拒绝。持久 tmux
Worker 应使用 `adopt-tmux`，而不是 takeover。
自动模式下，Decision Worker 在任务授权范围内自动处理普通问题、测试失败和修复轮次，记录假设和证据；无法形成可交付候选时自动挂起并保留证据，而不是要求人工必须在线。可通过 `PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT=0` 或 task `autonomy.requireLocalCommit` 关闭本地 commit 要求；远程 push 和 main/integration merge 仍由独立边界控制。

`v0.5.0` 已完成并发布“多命令验收—独立只读 Reviewer—结构化修复轮次—再次验收”闭环。
任务可通过 API 或 JSON spec 提供 `goal`、`scope`、`constraints`、`forbidden`、多个
`acceptance` 命令和 `autonomy` 控制；旧的纯文本任务继续使用默认 `git diff --check`。
Reviewer 只能使用 `read`、`grep`、`find`、`ls`，不会修改工作树或批准权限。自动模式记录
任务开始时的 git baseline，要求完整的 baseline-relative tracked/commit/untracked evidence，
并在默认情况下要求 Worker 本地 commit；无效输出、证据不完整、重复 finding、P0/P1 或预算耗尽
会自动挂起候选。自动模式拒绝显式 process-pipe，并在模型执行前检查目录、可执行文件、依赖
和 cgroup。详见 [自动化目标](docs/autonomy-target.md)。协同多 Worker 属于后续独立开发阶段，
暂不把 sandbox、低权限和网络隔离作为本阶段门禁。

### tmux/PTY 交互模式

如果希望在可见的 Claude Code 终端中工作，可显式启用 tmux transport：

```bash
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
export PI_CLAUDE_SUPERVISOR_WORKER='claude --permission-mode plan'
# 可选自动 Decision Worker（当前显式启用；目标是无人值守本地开发）：
# export PI_CLAUDE_SUPERVISOR_MODE=auto
# 接管非默认 tmux server 时可选：
# export PI_CLAUDE_SUPERVISOR_TMUX_SOCKET=/path/to/tmux.sock
```

`/supervise start <task>` 会在私有 tmux server 中启动 Claude，并返回可复制的 attach 命令。
可以在另一个终端 attach 到同一个 PTY，观察或人工输入。多行消息通过 tmux buffer 和 Enter
发送，不会把消息拼接进 shell 命令；`pipe-pane` 记录原始输出，`capture-pane` 检测稳定的 Claude
输入提示，并复用 watchdog、Decision Worker、审计和独立验收流程。

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

PTY 屏幕文字不是 Claude JSONL，不能把屏幕文字当作结构化权限证据。TUI 决策应按任务授权策略处理并记录；无法形成候选时可以自动挂起，不要求人工持续在线。普通终端里已经运行的 Claude 不能安全迁移进 tmux；`--resume`
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
该阶段应安排在固定 Claude `2.1.270` 稳定性统计和单 Worker recovery 语义完成之后。

Pull Request 必须通过聚合的 `CI / Quality gate`。Release Please 根据 Conventional Commits 创建版本 PR；维护者合并后，Release workflow 会针对精确 tag commit 重新验证，并通过受保护的 `npm` environment 使用 npm provenance 发布。

详细内容见 [engineering-plan.md](docs/engineering-plan.md)、[autonomy-target.md](docs/autonomy-target.md)、[independent-review.md](docs/independent-review.md)、[architecture.md](docs/architecture.md)、[testing.md](docs/testing.md) 和 [releasing.md](docs/releasing.md)。
