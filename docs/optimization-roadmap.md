# 后续优化路线图（0.9.2 之后）

> 状态：提案（未实施）。本文区分 **现状（Current Reality）**、**目标（Target）** 与 **迁移路径（Migration）**；
> 文中所有新模块、新事件、新字段均为提案，尚不存在于代码中。

## 1. 背景与目标

0.9.0 → 0.9.2 的独立审查与真实模型端到端测试（`npm run spike:decision`）暴露出一个共同根因：
**核心编排器 `Supervisor` 的生命周期状态分散在大量字段与布尔标志中，未被显式建模。**
这一轮修复的缺陷几乎全部来自这些标志之间的交互：

| 版本 | 缺陷 | 本质 |
|---|---|---|
| 0.9.1 | 修复后 Decision 死循环不 verify | 验证结果无时效语义（快照被当作现状） |
| 0.9.2 | 过期 stop 被吞掉；stop→verify 期间 Worker 存活 | 停止意图与验证生命周期交叉 |
| 0.9.2 | 操作员 stop 与 Decision stop 竞态 → blocked | 两个停止意图没有唯一所有者 |
| 0.9.2 | 新增 key 脱敏规则导致会话注册失败 | 脱敏函数被兼用作路径/分支校验（语义漂移） |

**目标**（按优先级）：

1. 让“长任务无人值守”的质量 **可度量**（先有指标，再谈改进）。
2. 用 **确定性机制** 兜住 LLM 决策的失控模式，而不是继续追加 prompt 条款。
3. 把核心生命周期 **显式建模**，从结构上消除一类竞态缺陷。
4. 让恢复（recover）路径与正常路径 **语义一致**。

**非目标**：不新增传输方式、不做多 Worker 并行、不引入新基础设施（数据库、图存储、服务拆分）。
在第 2 阶段完成前冻结功能扩展。

## 2. 现状（Current Reality）

- `src/supervisor.ts`：3132 行、73 个方法、约 90 个私有字段；`src/supervisor.test.ts` 4262 行。
- 主状态机 `src/state.ts`：`idle → starting → running/waiting/paused → verifying → completed/blocked/failed/stopped`，
  只覆盖任务主状态。
- 以下 **子生命周期没有状态机**，由字段组合隐式表达：

| 子生命周期 | 现有字段（节选） |
|---|---|
| 验证 / 修复 | `#lastVerification` `#lastVerificationTurn` `#verificationAbortController` `#repairRound` `#lastFindingSignature` `#repairSendInProgress` `#stopVerification` |
| 终止意图 | `#stopRequested` `#stopCloseReason` `#stopVerification` `#preemptiveStop` `#startStopReason` `#deadlineNotices` |
| 发布 | `#publishState` `#publishTarget` `#publishRemote` `#remoteGrant` `#verifiedHead` `#prUrl` `#publishShortfall` |
| 人工闸门 | `#humanRequired` `#humanGate` `#candidateParked` |
| 待决决策 | `#pendingDecisionKey` `#pendingDecisionSince` `#waitTimer` `#lastTurnCompleted` |
| 启动 | `#startAbortController` `#startToken` `#startAbortError` `#startAbortCompletion` |

- Decision 覆盖规则（guard）分散在 `#applyDecision` 各分支中：`#decisionIsStale`、`#verifyOnTurnBudget`、
  `#verifyStaleFailure`、`#verifyStop`，优先级只由代码顺序隐式决定。
- `redactSensitive` 同时承担 **脱敏** 与 **校验**（`decision-session-store.ts` 的 `assertNoCredentialPath`、
  `tmux-adapter.ts` 的 `isSafeAbsolutePath` 以“脱敏前后是否相等”判定合法性）。
- 恢复记录 `DecisionSessionRecord` 持久化了 `turn`、`repairRound`、`lastFindingSignature` 等，
  但 **未持久化** 最近验证结果、验证轮次、终止意图与各 guard 计数；recover 后部分确定性保护失效。
- 事件日志已有约 50 种事件类型，足以计算质量指标，但没有任何汇总工具。
- 真实链路（Claude TUI / hooks / cgroup v2 / 限流 / 长 idle）无自动化覆盖；部分单测依赖
  `process.cwd()` 为干净 git 仓库，在世界可写 `/tmp` 下会误报。

## 3. 领域模型（Domain Model）

### 3.1 概念

| 概念 | 类别 | 说明 |
|---|---|---|
| Task | 实体 | 一次受监督的实现任务；主状态机的承载者 |
| Worker Turn | 事件 | Worker 的一轮输出（`turn_completed`），带序号 |
| Decision | 决策 | Decision Worker（LLM）提出的动作；**是提议，不是权威** |
| Guard | 策略 | 对 Decision 的确定性裁决（放行 / 覆盖 / 丢弃），**权威** |
| Verification | 观察 | 某一 Worker 轮次时刻的验收 + 审查结果；**有时效（atTurn）** |
| Repair Round | 状态转换 | 由失败验证触发的纠正轮；受预算约束 |
| Termination Intent | 意图 | 谁要求结束任务、以何种方式；**同一时刻只能有一个所有者** |
| Candidate | 产物 | 通过或被搁置（parked/blocked）的候选结果 |
| Progress Fingerprint | 派生 | 某轮次的仓库状态（HEAD + diff 摘要）与 Worker 回复摘要（提案） |

### 3.2 必须恒成立的不变量（Invariants）

1. **终止意图唯一所有者**：同一时刻至多一个终止意图；优先级
   `operator_stop > deadline > decision_stop > none`。高优先级意图可取代低优先级，反之不可。
2. **修复前置条件**：仅当 最近验证失败 ∧ 终止意图为 none ∧ 修复预算未耗尽 ∧ Worker 可就地修复。
3. **验证时效**：任何基于验证结果的判断都必须知道其 `atTurn`；`atTurn < 当前轮次` 的结果只能作为历史证据。
4. **发布前置条件**：仅当存在对 `verifiedHead` 的通过验证 ∧ 远端授权有效 ∧ 基线未变化。
5. **人工闸门**：人工闸门打开时，Decision 只能被延迟，不能被执行。
6. **终态无挂起资源**：进入终态后不得存在计时器、中止控制器或待决决策。
7. **Guard 裁决可审计**：每次覆盖都产生一条带理由的 `decision_overridden` 事件。

这些不变量在目标架构中由 **转换表 + 前置条件函数 + 测试** 共同保证，而不是依赖调用顺序。

### 3.3 子生命周期状态机（目标）

```text
Verification:  none → acceptance → review → passed
                                     ├→ repair_requested → (Worker turn) → none
                                     ├→ parked            (终态)
                                     └→ failed            (终态)
Termination:   none → decision_stop(verifyFirst) | deadline_close_out | operator_stop  (按优先级只升不降)
Publish:       none → requested → settled | abandoned
HumanGate:     closed → open(permission|other) → closed
```

## 4. 目标架构（Target）

保持 **模块化单体**，不拆服务。`Supervisor` 变为薄编排层，生命周期逻辑下沉为可独立测试的模块：

```text
src/supervisor/
  core.ts            编排：事件分发、主状态机、调用各子模块（目标 < 1200 行）
  verification.ts    VerificationCycle：验收/审查/修复预算/时效，自带转换表
  termination.ts     TerminationIntent：唯一所有者与优先级裁决
  publish.ts         PublishCycle：授权、基线、PR 确认
  decision-guards.ts DecisionGuard[]：有序的确定性裁决管线
  progress.ts        进度指纹与无进展检测（新）
  watchdog.ts        deadline / idle / no-output 计时
  usage.ts           成本与 token 统计
src/validation.ts    路径、分支、凭据形状的显式校验（从 redaction 拆出）
```

**Decision Guard 管线**（取代 `#applyDecision` 中的分支判断）：

```ts
interface DecisionGuard {
  id: string;                       // 写入 decision_overridden.guard
  appliesTo(action, event, ctx): boolean;
  decide(action, event, ctx): GuardVerdict; // pass | drop(reason) | override(action, reason)
}
// 固定顺序：stale-event → human-gate → turn-budget → no-progress → stale-failure → stop-verify
```

每个 guard 单独测试；新增兜底只需新增一个 guard，不再修改分支结构。

## 5. 分阶段实施

### 阶段 0：先度量（1–2 个 PR，低风险，建议立即做）

**0.1 质量报告命令**：`npm run report -- <events.jsonl…>`（或 `/supervise report`），从事件日志统计：
- 任务终态分布（completed / blocked / parked / failed / stopped）及 park/block 原因直方图；
- 修复轮次分布、`decision_overridden` 次数与 guard 分布、`decision_worker_failed` 次数；
- 首个候选耗时、Worker 成本、Decision/Reviewer token；
- Reviewer 格式失败率（`invalid Reviewer output`）。

**验收**：对 spike 产出的事件日志给出与人工核对一致的数字。
**价值**：后续每个阶段都用它对比前后，避免“感觉更稳定”。

**0.2 拆分校验与脱敏**：新增 `src/validation.ts`（`assertSafeAbsolutePath`、`assertSafeBranchName`、
`looksLikeCredential`），`decision-session-store` 与 `tmux-adapter` 改用显式校验；
`redactSensitive` 此后只负责脱敏，可自由演进。**验收**：现有测试全绿；新增“脱敏规则变化不影响路径合法性”的测试。

### 阶段 1：通用无进展兜底（1 个 PR）

**问题**：现有兜底都是针对具体症状的补丁；“从未验证过、Decision 一直 continue”只受 `maxTurns=100` 约束。

**方案**：`progress.ts` 为每个 `turn_completed` 计算指纹 `{head, diffHash, resultHash}`（`git diff` 摘要 +
归一化后的 Worker 回复摘要）。规则：
- 连续 `N`（默认 3）个完成轮次指纹不变，且 Decision 仍选择 continue/redirect/answer/retry →
  覆盖为 verify（事件 `no_progress_detected` + `decision_overridden{guard:"no-progress"}`）；
- 验证失败后仍无进展 → 走既有修复预算，耗尽即 park，原因 `no_progress`。

**边界**：Worker 自身 API 错误轮不计入；等待后台任务（`wait`）不计入。
**验收**：单测覆盖；`spike:decision` 新增 `idle-chatter` 场景（Worker 只回复不改代码、且从不宣称完成）→ 有界结束。

### 阶段 2：核心生命周期显式化（4–6 个 PR，主体工作）

采用 **绞杀者模式**，每个 PR 只搬一个子生命周期，**不混入行为变更**：

| PR | 内容 | 前置 |
|---|---|---|
| 2.0 | **行为基线**：为 12–15 个关键场景录制“黄金事件序列”（事件类型 + 关键字段），作为特征测试 | — |
| 2.1 | 抽出 `TerminationIntent`（不变量 1），替换 `#stopRequested/#stopVerification/#stopCloseReason/#preemptiveStop` | 2.0 |
| 2.2 | 抽出 `VerificationCycle`（不变量 2、3），含修复预算与 `atTurn` | 2.1 |
| 2.3 | 抽出 `DecisionGuard` 管线，迁移现有 4 个 guard + 阶段 1 的 no-progress | 2.2 |
| 2.4 | 抽出 `PublishCycle`（不变量 4） | 2.2 |
| 2.5 | 抽出 `watchdog` / `usage`；`core.ts` 收敛到 < 1200 行 | 2.3, 2.4 |

**黄金事件序列场景清单**（2.0）：正常完成；验收失败→修复→通过；Reviewer revise→修复；
修复预算耗尽；重复发现→human；Decision stop→verify 通过/失败；操作员 stop 与 Decision stop 竞态；
deadline 收尾；Worker 无输出 idle；权限请求（允许/拒绝/AskUserQuestion）；发布成功/中止；启动中止。

**每个 PR 的验收**：黄金序列逐字节一致；全量单测通过；`spike:decision` 在两个模型上通过；独立 review 通过。
**完成标准**：子生命周期均有转换表与表驱动测试；§3.2 的不变量各有至少一个违反即失败的测试。

### 阶段 3：恢复路径补齐（1–2 个 PR）

- `DecisionSessionRecord` 升级 schema（`version` +1，旧记录按保守默认迁移）：持久化
  `lastVerification{ok, atTurn, findingSignature}`、`termination{kind, reason}`、guard 计数与进度指纹。
- recover 时重建 `VerificationCycle` / `TerminationIntent` / guard 状态，使阶段 1、2 的兜底在恢复后仍然生效。
- 新增测试：修复中途 recover、stop→verify 中途 recover、发布中途 recover；
  `spike:decision` 新增 `recover` 场景（中途重建 Supervisor 实例继续）。

### 阶段 4：验证环境与测试卫生（可与阶段 2 并行）

- **发版清单**：每次发版前在 cgroup v2 主机执行 `spike:decision`（至少两个模型）+ `spike:automation` + `spike:tmux`，
  结果记录到 `docs/stability-matrix-*.md`。
- **测试卫生**：依赖 `process.cwd()` 的测试改为各自创建临时 git 仓库；修复世界可写 `/tmp` 下
  `environment.test.ts` 的误报（测试自建 0700 目录）。
- **Reviewer 解析冻结**：记录现有威胁模型与已接受残余风险（见 `architecture.md`），不再追加防御层。
- **上游契约测试**：为 Claude Code `stream-json` / hooks 负载保存版本化夹具，版本升级时先跑契约测试。

### 阶段 5：部署门槛（需要你决策）

automatic 模式强制 cgroup v2，容器、macOS、部分 NAS/WSL 无法使用。可选方案：

| 方案 | 说明 | 风险 |
|---|---|---|
| A. 维持现状 | 只在 cgroup v2 主机运行 | 可用范围窄 |
| B. 显式降级模式（推荐评估） | `PI_CLAUDE_SUPERVISOR_CONTAINMENT=process-group` 显式开启；事件与 `status` 醒目标注“降级隔离”；子进程回收依赖进程组 + 超时强杀 | 后台逃逸进程可能残留 |
| C. 容器化隔离 | 每任务一个容器 | 复杂度与依赖显著上升，不建议现在做 |

## 6. 可观测性与审计

- 新事件（提案）：`no_progress_detected`、`guard_verdict`（或在 `decision_overridden` 中增加 `guard` 字段）、
  `termination_intent_changed`、`verification_state_changed`。
- 阶段 0 的报告命令作为唯一的质量看板入口；不引入外部监控组件。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 重构引入行为回归 | 黄金事件序列 + 每 PR 只搬一个生命周期 + 独立 review |
| 范围膨胀 | 阶段 2 完成前冻结功能；每 PR 限定 diff 规模 |
| LLM 行为随模型变化 | 以 guard 兜底而非 prompt；spike 多模型回归 |
| 无进展检测误伤合法的长时间思考 | 只统计 `turn_completed`；阈值可配置；先以事件观察模式上线一版再启用覆盖 |
| schema 迁移破坏旧恢复记录 | 版本化 + 保守默认 + 迁移测试 |

## 8. 成功标准

- `src/supervisor/core.ts` < 1200 行；子生命周期各有转换表与表驱动测试。
- §3.2 每条不变量有对应的“违反即失败”测试。
- 报告命令可给出无人值守完成率、park 原因分布、覆盖次数；阶段 1 后“无进展导致的超时/配额耗尽”归零。
- recover 后所有确定性兜底仍然生效（阶段 3 测试）。
- 连续两个版本发版清单全部通过，且无因生命周期交互导致的回归。

## 9. 建议顺序与当前最小版本

```text
阶段0（度量 + 校验拆分） → 阶段1（无进展兜底） → 阶段2（生命周期显式化） → 阶段3（恢复补齐）
                              阶段4（测试卫生/发版清单）并行推进；阶段5 待决策
```

**最小下一步**：阶段 0.1 报告命令 + 0.2 校验拆分，各一个 PR；它们不改变任何运行时行为，
却为之后的所有改动提供度量基线与安全边界。
