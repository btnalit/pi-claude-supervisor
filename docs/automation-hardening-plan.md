# 自动化稳定性与生命周期加固计划

> 计划状态：Phase A–D、真实可编辑 repair/reacceptance、exact-head 独立只读 Review、受保护发布和本地无人值守闭环已完成；远程 push/main merge 仍是独立边界。
> 基线：`v0.5.2` / `eefc7bc`
> 真实验证：Claude Code `2.1.270`
> 记录日期：2026-09-14

## 1. 实际演练结论

本轮真实演练完成了以下链路：

```text
真实 Claude Code Worker
  -> Decision Worker 判断完成
  -> argv/execFile 验收
  -> 独立只读 Reviewer
  -> P1/P2 阻塞发现
  -> fail-closed / parked non-publishable candidate
  -> Worker、Pi、lease 清理
```

六项验收全部通过：

- `git diff --check`
- `npm run check`
- `npm run check:workflows`
- `npm run test:pi`
- `npm run test:install`
- `npm run build`

本次任务明确使用只读 Claude 权限并设置 `maxRepairRounds=0`，因此没有进入真实的
repair/reacceptance。现有 replay 测试覆盖了模拟 repair，但没有覆盖真实
`ProcessWorkerAdapter` 能力矩阵。

完整事件证据位于本机临时目录：

```text
/tmp/pi-claude-supervisor-real-state-3/events.jsonl
```

### 1.1 Phase D：真实可编辑 repair/reacceptance

在不触碰主仓库的临时 Git 工作树中，使用真实 Claude Code `2.1.270` 和
`ProcessWorkerAdapter(mode=claude-jsonl, cgroup=off)` 完成了一个 bounded repair：

- task：`cd39ed51-6003-4aad-8518-ebd6ab5de7e7`；`maxRepairRounds=1`。
- Worker 首轮只创建 `add.mjs`；第一次 `node check.mjs` 按 drill 设计失败并给出
  `repair required`。
- Supervisor 发送 repair round 1；真实 Worker 创建 `add.test.mjs`。
- 第二轮验收通过，独立只读 Reviewer 返回 `pass`，没有 human intervention。
- 最终状态为 `completed`；Worker 状态为 `running=false`、`exitReason=stopped`、
  `processGroupCleaned=true`；Decision Worker closure 为 `cleanupConfirmed=true`。
- UI progress 覆盖 `starting -> worker -> acceptance(failed) -> repair -> worker ->
  acceptance(passed) -> review -> completed`，并包含 Worker heartbeat。
- Cwd lease 在 Worker 启动后记录了 PID/start time；结束后 `leaseAfterRelease=[]`，
  未留下 lease。

事件序列为：

```text
task_started -> worker_started -> worker_output -> worker_waiting -> decision_made
-> acceptance_started -> acceptance_check_finished -> acceptance_result
-> repair_requested -> worker_message_sent -> worker_output -> worker_waiting
-> decision_made -> acceptance_started -> acceptance_check_finished -> acceptance_result
-> review_started -> review_result -> review_finished -> verification_passed
```

证据归档位置（均在主仓库之外）：

```text
/tmp/pi-cs-repair4-runtime-X6MLob/events.jsonl
/tmp/pi-cs-repair4-runtime-X6MLob/decision/
/tmp/pi-cs-repair4-runtime-X6MLob/leases/   # 结束时为空
/tmp/pi-cs-repair4.log
```

## 2. 正式发现与复现结果

### P1-1：非持久 JSONL repair 会触发非法状态转换

`ProcessWorkerAdapter` 的 JSONL Worker 没有 `persistentSession`，Supervisor 在验收前停止
Worker；验收失败或 Reviewer `revise` 后，`requestRepair()` 先执行
`verifying -> failed`，调用方又执行 `failed -> failed`。

已用非持久 JSONL fake adapter 复现：

```text
InvalidTransitionError: Invalid supervisor transition: failed -> failed
```

根本修复不是把 JSONL 伪装成可跨重启恢复，而是把 Worker 能力拆成：

- `persistentSession`：能否在 Pi 重启/断开后继续存在；
- `repairableSession`：当前 Supervisor 生命周期内能否继续发送 repair turn。

JSONL 可以是 `repairableSession=true`、`persistentSession=false`；tmux 两者都可以为
`true`。终结和人工介入必须通过单一幂等路径完成，不能由 `requestRepair()` 和
`finalizeVerification()` 重复转换终态。

### P1-2：`verifying` 状态下 stop 无效

当前 `stop()` 和 `#stopInternal()` 没有处理 `verifying`。已复现：

```text
before stop: verifying
adapter.stop calls: 0
after stop: verifying
```

结果可能是 Decision Worker 未关闭、Pi shutdown 不释放 cwd lease、后续任务被错误地
判定为 cwd 冲突。

修复要求：`verifying` 支持 stop、cleanup、`worker_stopped` 事件、Decision Worker
关闭、closure callback 和 lease 回收；并确保人工 stop 优先于正在完成的 verification。

### P2-1：paused Worker 仍触发 no-output watchdog

`SIGSTOP` 后 Worker 本来就不会产生输出，但 watchdog 仍把 `paused` 纳入 no-output
计算。使用 50ms timeout 暂停 1.25s 已复现 Worker 被停止。

修复要求：暂停期间暂停 no-output 时钟；resume 时重建基准；wall-clock deadline 仍然
保持累计，不允许通过 pause 绕过总时限。

### P2-2：Reviewer diff evidence 遗漏 staged 和 untracked 内容

当前使用 unstaged-only 的 `git diff`。已复现：

```text
status: M  tracked.txt / ?? new.txt
diff:   (none)
```

修复要求：tracked 文件使用 `git diff HEAD`，额外安全读取 untracked regular files，
拒绝 symlink，限制单文件和总证据大小；证据不完整或被截断时 Reviewer 不得返回
`pass`。

## 3.1 当前实现状态

已完成并有确定性回归覆盖：

- `repairableSession` 与 `persistentSession` 已分离；JSONL 仅支持当前进程内 repair，tmux 才声明持久恢复。
- `verifying` 的 stop/shutdown 使用统一 cleanup/finalize 路径，人工 stop 优先于验收结果，cleanup 不确定时保留恢复记录。
- paused Worker 不消耗 no-output watchdog；resume 重建 no-output 基准，但不重置累计 deadline。
- Reviewer evidence 使用任务 baseline-relative diff、baseline 后 commit summaries、受限 untracked regular-file 内容、路径组件/symlink 门禁，并对 incomplete/truncated fail-closed。
- Acceptance 子进程、证据收集和 Reviewer 共享 abort signal；Pi UI 可看到 startup、Worker heartbeat、acceptance、review、repair 和 candidate/decision phases。
- 自动模式启动前检查运行目录、cwd、Worker/tmux 可执行文件、transport 依赖和 required cgroup；显式 `process-pipe` 不再进入自动模式。
- Reviewer/Decision Worker 只解析 assistant message 边界的最终文本；permission pending 会在自动响应后清除，候选状态不会被错误解除；扩大的 exec buffer 避免普通大测试报告被误判为命令失败。

本轮已完成：

- 普通本地命令和权限不再进入同步人工审批；Decision Worker 的无效输出、API 错误、Reviewer 失败、P0/P1、重复 finding、证据不完整和预算耗尽会进入 `blocked` 候选。
- TaskSpec 和环境变量提供 unattended/local-commit/Decision retry 控制；Worker 可在本地修改、测试、修复并提交，push、merge、发布和破坏性边界仍硬拒绝并写入审计。
- replay、候选通知和 baseline-relative commit evidence 覆盖正常完成、修复、歧义和挂起；保持独立 Review、保护 CI、Release Please 和 provenance 发布边界。

## 4. 实施顺序

### Phase A：生命周期和能力模型（最高优先级）

1. 增加 `repairableSession` capability。
2. JSONL 在当前 Supervisor 生命周期内支持 repair，仍不声明跨重启恢复。
3. 重构 repair/finalize/candidate 分支，保证终态转换和 Decision Worker closure 幂等。
4. `verifying` 支持 stop/shutdown，保留 cleanup 不确定时的 lease。
5. 增加真实非持久 adapter 和 stop-from-verifying 测试。

### Phase B：watchdog 与证据完整性

1. paused no-output 时钟暂停，resume 重建基准。
2. 记录任务开始时的 HEAD；baseline-relative diff 覆盖 committed/staged/unstaged tracked 修改，并记录 baseline 后 commits。
3. 安全收集 untracked regular-file evidence，防 symlink 和路径逃逸。
4. evidence truncation/incomplete 生成不可发布候选并自动挂起，不能自动 `pass`。

### Phase C：自动化协议和运行前保护

1. Reviewer/Decision Worker 按 assistant message 边界解析最终响应，不拼接所有工具回合文字。
2. 自动模式启动前执行 transport、Claude、cgroup、state/lease 目录 preflight。
3. 区分 Worker heartbeat、验收、Reviewer、repair 阶段，并提高实时可观测性。
4. 修复自动 permission 响应后的 stale pending request，并使本地决策不会依赖同步 human gate。
5. 清理 Pi extension 自己安装的 signal handler，避免与 Pi `session_shutdown` 竞争。

### Phase D：回归、真实演练和发布门禁

1. 扩展 acceptance/replay/capability 矩阵。
2. 在临时 worktree 中使用真实 Claude 做一次受控 repair/reacceptance；禁止触碰主仓库。
3. 运行 `npm run check`、Pi/npm smoke、build 和真实只读 review。
4. 只有独立 Reviewer `pass`、所有检查通过、cleanup/lease 证据完整后，才生成可交付本地候选；远程 push 和 main/integration merge 仍必须经过独立边界。

## 5. 验收矩阵

| 场景 | 预期 |
|---|---|
| JSONL Worker alive + P2 revise | 发送一次 bounded repair，重新验收 |
| JSONL Worker 已退出 + 验收失败 | 不抛非法 transition，记录 `verification_failed`，生成不可发布候选 |
| Reviewer `human` + Worker alive | 不自动完成；按预算修复或挂起 `blocked` 候选，不要求人工在线 |
| Reviewer `human` + Worker 已退出 | 完成 cleanup、关闭 Decision Worker、保留 recoverable/parked record |
| `stop()` from `verifying` | `stopped`、cleanup confirmed 后释放 lease |
| shutdown from `verifying` | 不泄漏 Worker、Decision Worker 或 cwd lease |
| pause 超过 no-output timeout | 仍保持 paused |
| resume 后无输出 | 从 resume 时刻重新计算 timeout |
| staged + untracked 修改 | Reviewer evidence 包含两者 |
| evidence 截断/不可验证 | Reviewer 只能阻止 `pass`，候选自动挂起 |
| malformed/multi-message model output | 不误判为 pass/action |
| preflight 失败 | Claude 尚未启动前 fail-closed |

## 6. 明确不改变的安全边界

- Reviewer 继续只允许 `read`、`grep`、`find`、`ls`。
- 验收命令继续使用 argv 和 `execFile`，不经过 shell 拼接。
- 不伪造 Claude `--resume`；`resumeSession` 仍然是明确能力声明。
- Worker 不得远程 push 或 merge 到 main/integration；发布仍走独立受保护 workflow。
- 不允许多 Worker 共享同一可写 worktree。
- P0/P1、重复 finding、超时、API 错误、无效输出和不完整证据继续 fail-closed，并自动生成不可发布/挂起候选，而不是要求同步人工响应。
