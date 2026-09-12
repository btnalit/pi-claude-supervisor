# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md)

用于 Pi 的 Claude Code Worker 监督扩展。MVP 中 Pi 负责生命周期、状态机、策略门和独立验收；Worker 只是被显式启动的子进程。

> 当前默认 transport 是无额外依赖的 process pipe，不是 PTY。已新增可选 Claude JSONL framing，并通过基础 prompt、多轮和 resume Spike。当前优先保证生命周期、进程组清理、恢复和独立验收；低权限用户、OS sandbox 与网络隔离不作为当前主线，按明确授权和宿主机策略运行，后续再做安全加固。

## 关键安全边界

- 不会在扩展加载时自动启动 Worker。
- 不经过 shell 启动子进程。
- Worker 只继承最小环境；凭据必须由调用方显式传入。
- 破坏性命令和绕过权限的 Worker 参数默认拒绝；需要复核的启动命令会请求用户批准，不会一律拒绝。
- Linux 上优先使用可写的 cgroup v2 清理后代进程，包括 `setsid()` 后代；不可用时回退到进程组清理。需要强制失败闭环时，embedding 集成可使用 `cgroupMode: "required"`。
- 普通联网查询不因联网本身被拒绝；下载后直接交给 shell 等高风险模式仍需人工复核。
- Worker 声称完成只会进入 `verifying`，不能作为成功证据。
- 默认独立验收命令为 `git diff --check`。
- 扩展运行时不执行 merge、deploy、release 或 publish；仓库 Release 只会在维护者合并 Release Please PR 且 CI 门禁全部通过后自动发布。
- 默认 4 小时总时限、20 分钟无输出 watchdog 超时即停止 Worker，适合长程开发任务；嵌入调用方可将对应选项设为 `0` 关闭。

## 安装和使用

需要 Pi 0.85+ 和 Node.js 22.19+：

```text
pi install npm:pi-claude-supervisor
```

在 Pi 中使用。手动/兼容模式默认使用 process-pipe。要启用事件驱动的 Pi Decision Worker，使用 Claude JSONL 自动模式：

```bash
export PI_CLAUDE_SUPERVISOR_MODE=auto
export PI_CLAUDE_SUPERVISOR_WORKER='claude --safe-mode --tools Bash'
# 可选：人工升级通知；generic 或 wecom
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL='https://example.invalid/webhook'
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT=generic
# export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_SECRET='shared-secret'
```

自动模式会强制使用 `claude-jsonl`，通过 `result`、`control_request` 和进程
`exit` 事件唤醒 Decision Worker；不会依赖 `/supervise poll` 轮询。本版本固定按已验证设备的
Claude CLI `2.1.268` 运行，跨版本兼容性不在本轮范围内。

然后在 Pi 中使用：

```text
/supervise capabilities
/supervise start inspect the current repository
/supervise poll
/supervise sessions
/supervise recover <task-id>
/supervise stop human requested stop
/supervise verify
/supervise approve <task-id> allow|deny [request-id]
/supervise takeover <task-id>
/supervise resume-auto <task-id>
```

人工升级通知的 generic JSON 格式为：

```json
{
  "schema": "pi-claude-supervisor/human-intervention/v1",
  "event": "human_intervention_required",
  "task": { "id": "...", "goal": "...", "cwd": "..." },
  "worker": { "id": "..." },
  "reason": "...",
  "question": "...",
  "permission": { "requestId": "...", "toolUseId": "...", "toolName": "Bash", "input": {} },
  "actions": ["approve_or_deny_permission", "send_instruction", "stop_worker", "takeover"]
}
```

当前 webhook 是出站通知，不直接接受批准命令；批准或接管仍通过 Pi。
自动模式会将 Decision Worker 会话持久化到状态目录。Pi 非正常重启后，`/supervise sessions`
会显示 `recoverable` 任务；显式执行 `/supervise recover <task-id>` 会恢复 Decision Worker 上下文并
重新启动 Claude Worker，不会静默恢复或重复执行任务。
自动模式下，Decision Worker 可以安全拒绝 `AskUserQuestion`，让 Claude 将问题转成普通文本，
再根据任务和仓库证据自动回答；无法确定时才升级人工。如需微信内闭环，需要另建带签名验证、
一次性 action token 和重放保护的入站 callback 服务。

可以从不同工作目录启动多个任务会话；活动会话不能共享同一 cwd，建议每个任务使用独立 worktree：

```text
/supervise sessions
/supervise poll all
/supervise poll <task-id>
/supervise send <task-id> continue after checking the test failure
```

Pull Request 必须通过聚合的 `CI / Quality gate`。Release Please 根据 Conventional Commits 创建版本 PR；维护者合并后，Release workflow 会针对精确 tag commit 重新验证，并通过受保护的 `npm` environment 使用 npm provenance 发布。

详细内容见 [engineering-plan.md](docs/engineering-plan.md)、[independent-review.md](docs/independent-review.md)、[architecture.md](docs/architecture.md)、[testing.md](docs/testing.md) 和 [releasing.md](docs/releasing.md)。
