# 后续优化路线图（0.9.2 之后）

> 状态：提案（未实施）。本文区分 **现状（Current Reality）**、**目标（Target）** 与 **迁移路径（Migration）**；
> 文中所有新模块、新事件、新字段均为提案，尚不存在于代码中。
> 与既有文档的关系：[`engineering-plan.md`](engineering-plan.md) 描述整体设计，
> [`automation-hardening-plan.md`](automation-hardening-plan.md) 记录自动化加固；本文只覆盖 0.9.2 之后的
> **收敛与稳定性** 工作，不改变它们确立的边界与目标。

## 1. 背景与目标

0.9.0 → 0.9.2 的独立审查与真实模型端到端测试（`npm run spike:decision`）暴露出一个共同根因：
**核心编排器 `Supervisor` 的子生命周期状态分散在大量字段中，未被显式建模。**
这一轮修复的缺陷几乎全部来自这些字段之间的交互（“引入”指缺陷所在版本，均已在 0.9.2 修复）：

| 引入版本 | 缺陷 | 本质 |
|---|---|---|
| 0.9.1 | 修复后 Decision 死循环不 verify | 验证结果无时效语义（快照被当作现状） |
| 0.9.2 开发中 | 过期 stop 被吞掉；stop→verify 期间 Worker 存活 | 停止意图与验证生命周期交叉 |
| 0.9.2 开发中 | 操作员 stop 与 Decision stop 竞态 → blocked | 停止意图没有唯一所有者 |
| 0.9.2 开发中 | 新增 key 脱敏规则导致会话注册失败 | 脱敏函数被兼用作路径/分支校验（语义漂移） |

**目标**（按优先级）：

1. 让“长任务无人值守”的质量 **可度量**（先有指标，再谈改进）。
2. 用 **确定性机制** 兜住 LLM 决策的失控模式，而不是继续追加 prompt 条款。
3. 把 **最常出错的两个** 子生命周期（终止、验证）显式建模，从结构上消除这一类竞态缺陷。
4. 让恢复（recover）路径与正常路径 **语义一致**。

**非目标**：不新增传输方式、不做多 Worker 并行、不引入新基础设施（数据库、图存储、服务拆分）。
在阶段 2 的核心部分完成前冻结功能扩展。

## 2. 现状（Current Reality）

- `src/supervisor.ts`：3132 行、73 个方法（不含构造函数与 11 个 getter）、74 个私有字段（209–307 行）；
  `src/supervisor.test.ts` 4262 行。已有 `src/automation-replay.test.ts`（`ReplayEventLog`）可重放事件序列。
- 主状态机 `src/state.ts` 覆盖任务主状态：`idle → starting → running/waiting/paused → verifying →
  completed/blocked/failed/stopped`（另有 `verifying → running`（修复）、`stopped → blocked`、终态 `→ idle`）。
  “parked” 不是独立状态，而是 `blocked` + `#candidateParked`。
- 以下 **子生命周期没有状态机**，由字段组合隐式表达：

| 子生命周期 | 现有字段（节选） |
|---|---|
| 验证 / 修复 | `#lastVerification` `#lastVerificationTurn` `#verificationAbortController` `#repairRound` `#lastFindingSignature` `#repairSendInProgress` |
| 终止 | `#stopRequested` `#stopCloseReason` `#stopVerification` `#preemptiveStop` |
| 释放 / 交接（非终止） | `#releasing` `#released`（交互任务完成后保留会话时也会置位）；`#terminalNoticeSent` 仅防重复通知 |
| 截止 / 收尾 | `#deadlineNotices` `#deadlineMs` `#deadlineGraceMs`（收尾与终止 **相互独立**，见 §3.2） |
| 发布 | `#publishState` `#publishTarget` `#publishRemote` `#remoteGrant` `#verifiedHead` `#prUrl` `#publishShortfall` |
| 人工闸门 | `#humanRequired` `#humanGate` `#candidateParked` |
| 待决决策 | `#pendingDecisionKey` `#pendingDecisionSince` `#waitTimer` `#lastTurnCompleted` |
| 启动 | `#startAbortController` `#startToken` `#startStopReason` `#startAbortError` `#startAbortCompletion` |

- **Decision 的现有裁决顺序**（`#applyDecision`，由代码顺序隐式决定）：
  已释放/终态 → 人工闸门延迟（`decision_deferred`）→ 事件去重 → 按动作分支；
  分支内：`stop` 先经 `#verifyStop`（其中过期 stop 退化为普通 stop）；`continue/redirect/answer/retry`
  依次经 `#decisionIsStale` → `#verifyOnTurnBudget` → `#verifyStaleFailure`；
  `wait` 另有收尾期 `wait → verify` 覆盖与 deadline 预警重放。**staleness 语义随动作不同**
  （过期 stop 仍要停止；`wait` 与权限回应不检查过期）。
- **无验证的 continue 循环** 目前受三道约束：`maxTurns`（默认 100）、deadline（默认 4h，收尾时强制验证空闲 Worker）、
  可选的 `autonomy.maxWorkerCostUsd`。缺口是：**最多 100 轮或 4 小时的花费** 内可以一次验证都没有。
- `redactSensitive` 同时承担 **脱敏** 与 **校验**：`decision-session-store.ts` 的 `assertNoCredentialPath`、
  `assertResolvedExecutable`，`tmux-adapter.ts` 的 `isSafeAbsolutePath`，均以“脱敏前后是否相等”判定合法性；
  另外 `redactRepositoryEvidence` 会脱敏分支名，而脱敏后的值被用于 `#trackBranchChange` 与 detached HEAD 判断。
- 恢复记录 `DecisionSessionRecord` 持久化了 `turn`、`repairRound`、`lastFindingSignature`、`workerCostUsd` 等，
  **未持久化** 最近验证结果与轮次、guard 计数；进度持久化逻辑在 `index.ts` 中重复两处（启动与恢复路径）。
  恢复后的 Worker 是 **新进程**。
- 事件日志约 55 种事件类型；日志按 64 MB 轮转并保留多份。**没有单一的“任务终态”事件**，
  终态需由 `verification_passed` / `candidate_parked` / `verification_failed` / `worker_stopped` / 启动失败等推导；
  `decision_overridden` 只有自由文本 `reason`，没有结构化的 guard 标识。
- 已有重放测试：`src/automation-replay.test.ts` 中 `ReplayAdapter` 负责重放，`ReplayEventLog` 负责记录事件。
- 真实链路（Claude TUI / hooks / cgroup v2 / 限流 / 长 idle）无自动化覆盖。
  部分单测依赖 `process.cwd()` 为干净 git 仓库（有未跟踪文件时约 5 个 supervisor 测试失败）；
  在世界可写 `/tmp` 下 `environment.test.ts` 误报（`assertSecureExecutablePath` 逐级检查父目录，`/tmp` 的 1777 权限必然不通过）。

## 3. 领域模型（Domain Model）

### 3.1 概念

| 概念 | 类别 | 说明 |
|---|---|---|
| Task | 实体 | 一次受监督的实现任务；主状态机的承载者 |
| Worker Turn | 事件 | Worker 的一轮输出（`turn_completed`），带序号 |
| Decision | 提议 | Decision Worker（LLM）提出的动作；**不是权威** |
| Guard | 策略 | 对 Decision 的确定性裁决；**权威**，可带副作用（如先停 Worker 再验证） |
| Verification | 观察 | 某一 Worker 轮次时刻的验收 + 仓库证据 + 审查结果；**有时效（atTurn）** |
| Repair Round | 状态转换 | 由失败验证触发的纠正轮；受预算与收尾剩余时间约束 |
| Stop Intent | 意图 | 谁要求结束任务、以何种方式；**同一时刻只有一个所有者** |
| Close-out | 时间约束 | deadline 收尾窗口；**独立于 Stop Intent**，只约束“还来得及做什么” |
| Candidate | 产物 | 通过或被搁置（blocked/parked）的候选结果 |
| Progress Fingerprint | 派生 | 某轮次的仓库状态摘要（提案，见阶段 1） |

### 3.2 现有行为（重构必须保持）与目标不变量（需显式行为变更）

**A. 现有行为**——阶段 2 的提取 PR 必须逐条保持；这里如实描述代码，包括不理想之处：

1. **Decision verify-first 停止让位于操作员停止**：`#verifyStop` 与 `#finalizeVerification` 检查操作员停止，
   已存在操作员停止时以其为准。其余路径（Decision 普通 stop、`park` / `ask_human` / `noop` → park）**不检查**
   操作员停止（见 B1）。再次调用 `stop()` 会覆盖原因与关闭原因。
2. **收尾与停止正交**：deadline 收尾不是停止；收尾期间允许修复轮（剩余 ≥ `MIN_CLOSE_OUT_REPAIR_MS`），
   Decision 停止照常经 `#verifyStop`。deadline + grace 到期由 watchdog **停止** Worker（`worker_watchdog_timeout`）。
3. **修复前置条件**（`#requestRepair`）：自动化模式 ∧ 人工闸门关闭 ∧ 无 verify-first 停止 ∧ 修复预算未耗尽 ∧
   有存活 handle 且 Worker 仍在运行 ∧ 状态为 running/waiting/verifying ∧ 可就地修复 ∧ 收尾剩余时间足够。
   触发来源：验收失败、截断证据、本地 commit 缺失、Reviewer revise，**以及通过验证后发布预检发现未提交改动**。
4. **验证时效**：基于验证结果的 Decision 判断以 `atTurn` 标注其时效；例外——发布轮返回后，若 HEAD 与工作树未变，
   复用发布前的通过验证（`#settlePublish`），不重新验证。
5. **发布前置条件**：存在对 `verifiedHead` 的通过验证 ∧ 远端授权有效 ∧ 远端基线未变化；用户拒绝发布时仍以
   completed 结束并记录 shortfall。
6. **人工闸门**：闸门打开时 Decision 被记录为 `decision_deferred` 并 **丢弃**；`resumeAutomation` 只重新询问最后一个
   `turn_completed`（见 B2）。闸门检查位于已释放/终态检查之后。
7. **无输出**：自动化下空闲 Worker 的无输出超时触发 **验证**（`worker_idle_timeout`）；轮次中途静默才 **停止**。
8. **成本预算**：超出 `maxWorkerCostUsd`（或 Claude `error_max_budget_usd`）**立即 park**，不验证、不停止意图。

**B. 目标不变量**——当前不成立，须以 **独立的行为变更 PR** 实现（建议作为阶段 0.3，见 §5）：

1. **操作员停止唯一优先**：任何 Decision 终止类动作（普通 stop、park、ask_human、noop→park）在操作员停止
   已请求时都让位；任务以 `stopped` / `human_stop` 结束。（复审已用临时测试复现：Decision `park` 与操作员 stop
   竞态时任务以 `blocked` 结束；Decision 普通 stop 竞态时关闭原因为 `recoverable_failure` 而非 `human_stop`。）
2. **延迟而不丢失**：人工闸门期间的权限回应在闸门关闭后重放，或权限请求被重新交给 Decision Worker。
3. **终态无挂起资源**：进入终态后清除计时器、中止控制器与 `#pendingDecisionKey`（当前 stop/park/finalize 不清除后者）。
4. **裁决可审计**：每次覆盖带结构化 guard 标识（阶段 2.3 引入；当前 stale 丢弃记 `decision_ignored`，
   权限覆盖记 `permission_decision`，`decision_overridden` 仅有文本 `reason`）。

### 3.3 子生命周期（目标形态，覆盖现有真实路径）

```text
Verification（每轮）：
  acceptance ──fail──▶ repair? ─┬─ yes ▶ repair_requested ▶ (Worker turn) ▶ 下一轮
       │                        └─ no  ▶ blocked（预算耗尽 / 收尾不足 / 禁止修复）
       ▼ pass
  repository evidence ── truncated ▶ repair?（同上）；incomplete / baseline rewritten / detached ▶ parked
       ▼ ok
  local commit check ── missing ▶ repair? / blocked
       ▼ ok
  review ── pass ▶ publish? ─┬─ none / 用户拒绝 ▶ completed（拒绝时记 shortfall）
       │                     ├─ 预检：未提交/未跟踪改动 ▶ repair?（同上）
       │                     └─ requested ▶ (publish turn) ▶ HEAD/树未变 ▶ settled（复用通过验证）▶ completed
       │                                                   └ 变化 ▶ abandoned ▶ 重新验证 | publish-only blocked
       ├─ revise ▶ repair?（同上）；重复发现 ▶ human ▶ parked
       └─ human / Reviewer 失败 ▶ parked
  任一阶段：操作员停止 ▶ cancelled（stopped）；证据采集失败 / 验证中 takeover 或 release ▶ parked
  （注：所有 blocked 的验证结果都会置 #candidateParked，“blocked”与“parked”在状态上相同）
StopIntent（终止意图，现状）：
  none → decision_stop{verifyFirst | plain} | operator_stop{human | watchdog(deadline+grace) | mid-turn no_output | abort_start | recoverable_failure}
  decision_stop{verifyFirst} → operator_stop（操作员取代，现状只在此路径成立）
  operator_stop → operator_stop（再次 stop 覆盖原因，现状）
Park（终止但非停止意图）：成本预算、Decision park/ask_human/noop、验证 blocked —— 经 #stopInternal(…, "blocked") 结束
Release（非终止）：断开 Supervisor；交互 Worker 移出 cgroup 交还操作员，任务状态与恢复记录不变
Budget：turns 耗尽 → 验证；deadline 收尾 → 验证空闲 Worker；deadline+grace → watchdog 停止；cost → 立即 park
```

## 4. 目标架构（Target）

保持 **模块化单体**，不拆服务。按风险收益排序，只有前三项是必做：

```text
src/supervisor/
  stop-intent.ts      StopIntent：唯一所有者、取代规则（必做）
  verification.ts     VerificationCycle：§3.3 的阶段、修复前置条件、atTurn（必做）
  decision-guards.ts  Decision 裁决管线（必做）
  progress.ts         进度指纹与无进展检测（阶段 1，新）
  publish.ts          PublishCycle（可选）
  watchdog.ts / usage.ts  计时与成本（可选）
src/validation.ts     路径、分支、可执行文件、凭据形状的显式校验（从 redaction 拆出）
```

**Decision 裁决管线**（保持现有顺序与语义，而不是重排）：

```ts
type GuardVerdict =
  | { kind: "pass" }
  | { kind: "defer"; reason: string }                 // 人工闸门
  | { kind: "drop"; reason: string }                  // 例如过期的 continue
  | { kind: "override"; action: DecisionAction; reason: string }
  | { kind: "handled"; reason: string };              // guard 已执行带副作用的流程（如 stop→停 Worker→验证）
interface DecisionGuard {
  id: string;                                         // 写入事件的结构化 guard 字段
  actions: ReadonlyArray<DecisionAction["action"]>;   // 按动作适用，staleness 语义随动作不同
  decide(action, event, ctx): Promise<GuardVerdict>;
}
// 顺序（现状；标 * 者为提案新增）：
//   已释放 → 终态 → 人工闸门（defer，现状为丢弃，见 §3.2 B2）→ 去重（wait 不去重）→ 记录 decision_made → 按动作：
//   allow/deny_permission: 策略 deny 覆盖 Decision 的 allow；无法回应权限 → park
//   continue/redirect/answer 且待决 AskUserQuestion: 以权限 deny 携带答案（先于过期检查）
//   continue/redirect/answer/retry: stale-event(drop) → turn-budget → *no-progress → stale-failure
//   verify:   stale-event(drop, decision_ignored) → 验证
//   stop:     verify-stop(handled；过期或有远端授权 → pass→普通 stop)
//   park/ask_human/noop: → park（noop 在 clean exit 上 → 验证）
//   wait:     收尾期 wait→verify、deadline 预警重放
```

## 5. 分阶段实施

### 阶段 0：先度量（2 个 PR）

**0.1 质量报告命令**（无运行时行为变更）：`npm run report -- <events.jsonl…>`，支持读取轮转日志，统计：
- 任务终态分布（由多类事件推导，推导规则写进代码与文档）与 park/block 原因直方图；
- 修复轮次分布、`decision_overridden` 次数（阶段 2 之前按 `reason` 文本归类）、`decision_worker_failed` 次数；
- 首个候选耗时、Worker 成本、Decision/Reviewer token、Reviewer 格式失败率。

**验收**：对 spike 产出的事件日志，数字与人工核对一致。

**0.2 拆分校验与脱敏**（**有意的行为变更**：合法路径的判定改为显式规则）：新增 `src/validation.ts`
（`assertSafeAbsolutePath`、`assertSafeBranchName`、`assertSafeExecutablePath`、`looksLikeCredential`），
替换 `assertNoCredentialPath`、`assertResolvedExecutable`、`isSafeAbsolutePath` 中的“脱敏前后相等”判定；
分支跟踪、detached HEAD 判断与发布授权的分支/受保护分支检查改用原始分支名，仅在输出时脱敏。
**验收**：现有测试全绿；新增“脱敏规则变化不影响路径/分支合法性”的测试；列出被新规则放行或拒绝的差异样例。

**0.3 已知行为缺口修复**（显式行为变更，单独 PR）：实现 §3.2 B1（操作员停止唯一优先）与 B3（终态清除待决决策），
各带竞态回归测试；B2（延迟而不丢失）需先确认权限请求重放的交互，单独评估。

### 阶段 1：通用无进展兜底（1 个 PR，先观察后覆盖）

**问题**：见 §2——最多 100 轮或 4 小时的花费内可以一次验证都没有。

**指纹**（只看仓库，不看回复文本——LLM 回复几乎不会逐字重复，tmux 屏幕尾部含计时器/动画）：
`{ head, trackedDiffHash, untrackedHash }`。
- untracked 文件纳入（`git ls-files --others --exclude-standard` + 内容摘要）；
- 复用 `collectRepositoryEvidence` 的大小与超时上限；计算在 `#exclusive` 之外完成或设超时，超时视为“未知”而非“无变化”。

**规则**：自上次验证（或任务开始）以来，连续 `N`（默认 3，可配置）个完成轮次指纹不变，且 Decision 选择
continue/redirect/answer/retry → 覆盖为 verify；Worker 自身 API 错误轮与 `wait` 不计入。
与 `#verifyStaleFailure` 的关系：后者处理“验证失败后”的情形，本规则处理“从未验证/验证后无变化”，二者合并进同一管线。

**上线方式**：第一版只记录 `no_progress_detected`（观察模式），用阶段 0 报告评估误报率后再启用覆盖。
**注意**：无变更的仓库被强制验证时，`requireLocalCommit=false` 的任务可能只剩 Reviewer 把关；
覆盖版本需保证“无任何改动”不会被判为 completed（例如要求验收之外存在差异或由 Reviewer 明确给出理由）。
**验收**：单测；`spike:decision` 新增 `idle-chatter` 场景（Worker 只回复、不改代码、不宣称完成）→ 有界结束。

### 阶段 2：终止与验证显式化（核心 3 个 PR + 可选 2 个）

采用 **绞杀者模式**，每个 PR 只搬一个子生命周期，**不混入行为变更**：

| PR | 内容 | 必做 |
|---|---|---|
| 2.0 | **行为基线**：可控时钟（`node:test` 的 `mock.timers` 或注入 clock）+ 在 `automation-replay.test.ts` 的 `ReplayEventLog` 基础上录制 12–15 个场景的 **归一化事件序列**（事件类型 + 关键字段；剔除 `at` 与 `data` 内的时间戳如 `checkedAt`/`startedAt`、临时路径、耗时、成本） | ✅ |
| 2.1 | 抽出 `StopIntent`（保持 §3.2 A1、A2、A7），替换 `#stopRequested` `#stopVerification` `#stopCloseReason` `#preemptiveStop`，纳入 watchdog / 无输出 / abortStart 来源 | ✅ |
| 2.2 | 抽出 `VerificationCycle`（保持 §3.2 A3、A4、A5，§3.3 全部路径） | ✅ |
| 2.3 | 抽出 Decision 裁决管线，保持现有顺序与语义；事件增加结构化 guard 字段 | ✅ |
| 2.4 | 抽出 `PublishCycle`（保持 §3.2 A5） | 可选 |
| 2.5 | 抽出 watchdog / usage；进一步缩减 `supervisor.ts` | 可选 |

**场景清单**（2.0）：正常完成；验收失败→修复→通过；Reviewer revise→修复；截断证据→修复；本地 commit 缺失→修复；
修复预算耗尽；重复发现→human；Decision stop→verify 通过/失败；可发布任务上的 Decision stop（普通 stop）；
操作员 stop 与 Decision stop 竞态；deadline 收尾内修复；Worker 无输出 idle；权限请求（允许/拒绝/AskUserQuestion）；
发布成功/中止后重新验证；启动中止。

**每个 PR 的验收**：归一化事件序列一致；全量单测通过；`spike:decision` 在两个模型上通过；独立 review 通过。
**完成标准**：`StopIntent` 与 `VerificationCycle` 有转换表与表驱动测试；§3.2 A 的每条现有行为有特征测试，
B 的每条目标不变量在对应的行为变更 PR 中有违反即失败的测试。

### 阶段 3：恢复路径补齐（1–2 个 PR）

- 恢复后的 Worker 是新进程，因此 **不恢复进行中的验证**，而是恢复“它的结论”：
  `DecisionSessionRecord` 升级 schema（`version` +1，旧记录按保守默认迁移），持久化
  `lastVerification{ok, atTurn, findingSignature}` 与 guard 计数（含进度指纹基线）。
- 恢复后的任务先处于 `takeover()` 空闲状态，直到 resume-auto 或 `--extend` 才恢复自动化（`index.ts`）；
  自动化恢复时：若最近验证失败，stale-failure / no-progress guard 从持久化计数继续；若中断时处于 Decision
  verify-first 停止，恢复自动化后的第一个动作是一次验证而不是发送 Worker 轮次。
- 哪些终止会关闭恢复记录：只有清理已确认的 `human_stop`。关机停止（`preserveDecisionSession` →
  `recoverable_failure`）、watchdog / 无输出停止、清理未确认的 `human_stop` 都会标记为可恢复中断；
  `release` 不改动记录。正是这些任务需要完整的恢复状态。
- 同时消除 `index.ts` 中两处重复的进度持久化逻辑（启动与恢复路径共用一个函数）。
- 测试：修复中途 recover、stop→verify 中途 recover；`spike:decision` 新增 `recover` 场景。

### 阶段 4：验证环境与测试卫生（可与阶段 2 并行）

- **发版清单**：每次发版前在 cgroup v2 主机执行 `spike:decision`（至少两个模型）+ `spike:automation` + `spike:tmux`，
  结果记录到 `docs/stability-matrix-*.md`。
- **测试卫生**：依赖 `process.cwd()` 的测试改为各自创建临时 git 仓库；`environment.test.ts` 的可信可执行文件夹具
  放到可信父目录下（如 `$HOME` 下的 0700 目录），不能放在 `/tmp` 下。
- **Reviewer 解析冻结**：以 `architecture.md` 记录现有威胁模型与已接受残余风险，不再追加防御层。
- **上游契约测试**：为 Claude Code `stream-json` / hooks 负载保存版本化夹具，版本升级时先跑契约测试。

### 阶段 5：部署门槛（需要维护者决策）

automatic 模式强制 cgroup v2，容器、macOS、部分 NAS/WSL 无法使用：

| 方案 | 说明 | 风险 |
|---|---|---|
| A. 维持现状 | 只在 cgroup v2 主机运行 | 可用范围窄 |
| B. 显式降级模式（建议评估） | `PI_CLAUDE_SUPERVISOR_CONTAINMENT=process-group` 显式开启；事件与 `status` 醒目标注“降级隔离”；回收依赖进程组 + 超时强杀 | 后台逃逸进程可能残留 |
| C. 容器化隔离 | 每任务一个容器 | 复杂度与依赖显著上升，不建议现在做 |

## 6. 本路线图之外、但影响长任务的已知风险

以下不在本轮范围内，但应作为后续独立议题跟踪（均为观察，未验证其严重程度）：

- `tmux-adapter.ts`（2665 行）：就绪判断依赖屏幕抓取（`isReadyScreen` / `readyStreak`），轮次检测依赖 hooks；
  Claude TUI 变化时最脆弱。
- Decision Worker 自身在长任务中的上下文增长与压缩质量。
- `policy.ts`（1476 行）的权限拒绝是无人值守卡住的常见来源；阶段 0 报告应单列其统计。
- `index.ts`（1305 行）中启动与恢复路径的重复逻辑。

## 7. 可观测性与审计

- `#humanGate` 的 `"permission"` 取值当前从未被赋值，可在阶段 2 清理。
- 新事件/字段（提案）：`no_progress_detected`；`decision_overridden.guard`；`stop_intent_changed`；
  `verification_stage_changed`；一个推导性的任务终态事件（如 `task_finished{outcome, reason}`）便于统计。
- 阶段 0 的报告命令作为唯一质量看板入口；不引入外部监控组件。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 重构引入行为回归 | 可控时钟 + 归一化事件序列 + 每 PR 只搬一个生命周期 + 独立 review |
| 规格与现状不符导致“重构即改行为” | §3.2 区分“现有行为（保持）”与“目标不变量（显式变更）”；前者以代码为准 |
| 范围膨胀 | 阶段 2 只有 2.0–2.3 必做；可选项在指标证明必要时再做 |
| LLM 行为随模型变化 | 以 guard 兜底而非 prompt；spike 多模型回归 |
| 无进展检测误伤合法的连续排查 | 先观察模式；阈值可配置；只看仓库指纹 |
| schema 迁移破坏旧恢复记录 | 版本化 + 保守默认 + 迁移测试 |

## 9. 成功标准

- `StopIntent` 与 `VerificationCycle` 独立成模块，有转换表与表驱动测试；§3.2 A 有特征测试，B 已实现并有违反即失败的测试。
- 报告命令可给出无人值守完成率、park 原因分布、覆盖次数；阶段 1 启用覆盖后，“无验证运行到 deadline/配额耗尽”归零。
- recover 后所有确定性兜底仍然生效（阶段 3 测试）。
- 连续两个版本发版清单全部通过，且无因生命周期交互导致的回归。

## 10. 建议顺序与当前最小版本

```text
阶段0（度量 + 校验拆分 + 已知缺口） → 阶段1（无进展，先观察） → 阶段2 核心（2.0→2.1→2.2→2.3） → 阶段3（恢复补齐）
                             阶段4（测试卫生/发版清单）并行；阶段2 可选项与阶段5 视指标与决策再定
```

**最小下一步**：阶段 0.1 报告命令（无运行时变更）、0.2 校验拆分与 0.3 已知缺口修复（小而明确的行为变更），各一个 PR。
