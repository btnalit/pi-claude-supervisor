# 后续优化路线图（0.9.2 之后）

> 状态：实施中（已完成项以 ✅ 标注，其余仍为提案）。本文区分 **现状（Current Reality）**、**目标（Target）** 与 **迁移路径（Migration）**；
> 除 ✅ 项外，文中新模块、新事件、新字段均为提案，尚不存在于代码中；§2 现状描述的是路线图起草时（0.9.2）的代码。
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

**维护者指示（优先级依据）**：要的是 **稳定、可靠的无人值守自动化**，主力模式是 **interactive tmux**
（自动化驱动真实 Claude Code TUI + hooks）。过度保守的安全限制、过度防御与过度工程，只要妨碍这一目标就应放宽或简化；
安全只保留 §5.2 的“底线清单”。

**目标**（按优先级）：

1. **interactive tmux 模式在无人值守下不卡死、不误判、不无故 park**（§5.1，阶段 T）。
2. **去掉过度防御造成的误拒、误 park 与人工依赖**，同时补齐真正的底线（§5.2，阶段 D）。
3. 让质量 **可度量**，并用 **确定性机制** 兜住 LLM 决策的失控模式（阶段 0、1）。
4. 把终止、验证两个子生命周期显式建模，从结构上消除竞态缺陷（阶段 2），恢复路径与正常路径语义一致（阶段 3）。

**非目标**：不新增传输方式、不做多 Worker 并行、不引入新基础设施（数据库、图存储、服务拆分）。
在阶段 T、D 与阶段 2 核心完成前冻结功能扩展；structured bridge 等非主力传输冻结（只修缺陷，不扩展）。

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
  已释放/终态 → 人工闸门（记 `decision_deferred` 并丢弃）→ 事件去重 → 按动作分支；
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
   操作员停止（见 B1）。重复 `stop()`：验证进行中时，最后一次的原因与关闭原因生效（`#finalizeVerification`
   读取被覆盖的字段）；其他状态下第一次生效，后续调用在任务已 `stopped` 时直接返回。
2. **收尾与停止正交**：deadline 收尾不是停止；收尾期间允许修复轮（剩余 ≥ `MIN_CLOSE_OUT_REPAIR_MS`），
   Decision 停止照常经 `#verifyStop`。deadline + grace 到期由 watchdog **停止** Worker（`worker_watchdog_timeout`）。
3. **修复前置条件**（`#requestRepair`）：自动化模式 ∧ 人工闸门关闭 ∧ 无 verify-first 停止 ∧ 修复预算未耗尽 ∧
   有存活 handle 且 Worker 仍在运行 ∧ 状态为 running/waiting/verifying ∧ 可就地修复 ∧ 收尾剩余时间足够。
   触发来源：验收失败、截断证据、本地 commit 缺失、Reviewer revise，**以及通过验证后发布预检发现未提交改动**。
4. **验证时效**：基于验证结果的 Decision 判断以 `atTurn` 标注其时效；例外——发布轮返回后，若 HEAD 与工作树未变，
   复用发布前的通过验证（`#settlePublish`），不重新验证。
5. **发布**：`remoteAuthority = none` 时验证通过即 `completed`。否则 `#requestPublish` **按以下顺序** 检查：
   手动模式 → takeover/停止请求 → 传输能力 → 收尾窗口 → 受保护/未知分支 → HEAD 不可读 → 证据缺失 →
   **工作树有未提交/未跟踪改动（→ 修复轮；无修复预算 → shortfall + `completed`）** → 证据 HEAD 缺失或 HEAD 已变 →
   Git 目录非本地 → Worker 忙 → 远端 URL/基线变化 → `pr` 模式缺仓库标识 → 状态非 verifying。
   除未提交改动外，任一不满足 **不阻塞**：记 `publish_skipped` shortfall 后以 `completed` 结束（存在停止请求则为 `stopped`）。
   发布 **只尝试一次**：发布轮返回后由 `#settlePublish` 得出 `completed`、publish-only `blocked`，或 HEAD/树变化 →
   `publish_abandoned`（`#publishState` 置为 settled）→ 重新验证，且重新验证后不再发起发布，以带放弃说明的 `completed` 结束。
6. **人工闸门**：闸门打开时 Decision 被记录为 `decision_deferred` 并 **丢弃**；`resumeAutomation` 只重新询问最后一个
   `turn_completed`（见 B2）。闸门检查位于已释放/终态检查之后。
7. **无输出**：自动化下空闲 Worker 的无输出超时触发 **验证**（`worker_idle_timeout`）；轮次中途静默才 **停止**。
8. **成本预算**（仅自动化模式）：超出 `maxWorkerCostUsd`（或 Claude `error_max_budget_usd`）**立即 park**，不验证。

**B. 目标不变量**——当前不成立，须以 **独立的行为变更 PR** 实现（建议作为阶段 0.3，见 §5）：

1. **操作员停止唯一优先**：任何 Decision 终止类动作（普通 stop、park、ask_human、noop→park）在操作员停止
   已请求时都让位；任务以 `stopped` / `human_stop` 结束。（复审已用临时测试复现：Decision `park` 与操作员 stop
   竞态时任务以 `blocked` 结束；Decision 普通 stop 竞态时关闭原因为 `recoverable_failure` 而非 `human_stop`。）
2. **延迟而不丢失**：人工闸门期间的权限回应在闸门关闭后重放，或权限请求被重新交给 Decision Worker。
3. **终态无挂起资源**：进入终态后清除计时器、中止控制器与 `#pendingDecisionKey`（当前 stop/park/finalize 不清除后者）。
4. **裁决可审计**：每次覆盖带结构化 guard 标识（阶段 2.3 引入；当前 stale 丢弃记 `decision_ignored`，
   权限覆盖记 `permission_decision`，`decision_overridden` 仅有文本 `reason`）。
5. **释放后不再驱动或停止 Worker**：验证进行中 `release()` 时，Supervisor 仍会尝试修复轮（`#requestRepair` 不检查
   `#releasing`）并在收尾时对已释放的 handle 调用 `adapter.stop`。对真实 tmux 适配器：`send()` 在已释放记录上抛错，
   修复未送达但已记 `repair_requested`；随后 `stop` 再次 release，面板仍在运行，owned handle 的清理确认失败 →
   任务以 **`failed`**（`verification_failed`，恢复关闭原因 `recoverable_failure`）结束——验收与审查阶段皆然
   （复审以 tmux 形态的假适配器复现）；adopted handle 则以 parked 结束。**直接影响 interactive tmux 模式。**

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
  review ── pass ▶ publish? ─┬─ remoteAuthority=none ▶ completed
       │                     ├─ 按 §3.2 A5 顺序检查：未提交/未跟踪改动 ▶ repair?（无预算 ▶ shortfall ▶ completed）
       │                     ├─ 其他前置条件不满足 ▶ publish_skipped（shortfall）▶ completed（有停止请求 ▶ stopped）
       │                     └─ requested ▶ (publish turn) ▶ HEAD/树未变 ▶ #settlePublish ▶ completed | publish-only blocked
       │                                                   ├ HEAD/树不可读 ▶ publish-only blocked
       │                                                   └ 已变化 ▶ abandoned ▶ 重新验证 ▶ 不再发布 ▶ completed（附放弃说明）
       ├─ revise ▶ repair?（同上）；重复发现 ▶ human ▶ parked
       └─ human / Reviewer 失败 ▶ parked
  任一阶段：操作员停止 ▶ cancelled（stopped）；证据采集失败 ▶ parked
  验证中 release：owned tmux handle ▶ 尝试修复/停止已释放的 handle ▶ failed；adopted handle ▶ parked（缺陷，见 §3.2 B5）
  验证中 takeover：在 #exclusive 队列中等待验证结束后才生效
  （注：所有 blocked 的验证结果都会置 #candidateParked，“blocked”与“parked”在状态上相同）
StopIntent（终止意图，现状）：
  none → decision_stop{verifyFirst | plain} | operator_stop{human | abort_start | recoverable_failure}
  另：watchdog（deadline+grace）与无输出停止直接调用 #stopInternal，不设置 #stopRequested
      （自动化下仅轮次中途静默才停止；非自动化下空闲 Worker 也会被停止）
  decision_stop{verifyFirst} → operator_stop（操作员取代，现状只在此路径成立）
  operator_stop → operator_stop：验证进行中时最后一次生效；其他状态下第一次生效（见 §3.2 A1）
Park（终止但非停止意图）：成本预算、Decision park/ask_human/noop —— running/waiting/paused/starting 下经
  #stopInternal(…, "blocked") 结束；verifying 下（含验证 blocked）经 #finalizeVerification 结束并记 candidate_parked
Release（非终止）：断开 Supervisor；交互 Worker 移出 cgroup 交还操作员，任务状态与恢复记录不变
  （验证进行中 release 的影响见上方 Verification 注释）
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
//   allow/deny_permission: 无法回应权限 → park（先检查）；策略 deny 覆盖 Decision 的 allow；
//                          AskUserQuestion 的 deny_permission 以 reason 携带答案
//   continue/redirect/answer 且待决 AskUserQuestion: 以权限 deny 携带答案（先于过期检查）
//   continue/redirect/answer/retry: stale-event(drop) → turn-budget → *no-progress → stale-failure
//   verify:   stale-event(drop, decision_ignored) → 验证
//   stop:     verify-stop(handled)；以下回落为普通 stop：非 turn_completed 事件、状态非 waiting、非自动化、
//             人工闸门打开、有远端授权、决策已过期
//   park/ask_human/noop: → park（noop 在 clean exit 上 → 验证）
//   wait:     deadline 预警重放（先检查）或收尾期 wait→verify（二者互斥），否则重设等待计时器
```

## 5. 分阶段实施

阶段 T、D 是当前最高优先级（直接对应维护者指示）；阶段 0–3 是支撑它们的度量、兜底与结构工作。

### 5.1 阶段 T：interactive tmux 无人值守可靠性（最高优先级）

来源：只读可靠性审计（代码 + Claude Code 2.1.281 二进制 + 本地 tmux 实验）。标记：**[code]** 代码证实；
**[exp]** 本地 tmux 实验证实；**[bin]** 由 Claude 二进制强烈暗示；**[hyp]** 需真实 Claude 运行验证。
**测试缺口**：目前没有任何真实 Claude spike 走 interactive 适配器的 hooks 路径（`spike-claude-tmux-interactive.mjs`
直接驱动 tmux，`spike-claude-tmux.mjs` 用 plan 模式），这是这些问题未被发现的原因。

| # | 问题 | 后果 | 修复（倾向简单、确定性） | 等级 |
|---|---|---|---|---|
| T1 ✅ | hook 路由按 `event.cwd` 查找 socket，Claude 在 Bash 中 `cd` 子目录后 cwd 随之改变 [code][bin] | 此后所有 hook 静默 no-op：Stop 丢失、PreToolUse 策略跳过、权限对话框等人 → 20 分钟/4 小时后失败 | Worker 环境设 `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`；relay 按 `CLAUDE_PROJECT_DIR` 路由（回退：`event.cwd`；不沿父目录查找，否则 Worker 在子目录启动的嵌套 Claude 会被路由到本任务），请求携带路由键；shell cwd 偏离任务目录的 Bash 请求以 `cd <cwd> && <命令>` 交给策略判定 | 高 |
| T2 | 发送无送达确认：paste → Enter 之间不检查 `pane_in_mode`，不等待对应 UserPromptSubmit [code][exp] | copy-mode 吞掉 Enter，文本滞留输入框，`activeRequests` 卡 1 → 无输出 watchdog 失败 | 发送前 `#{pane_in_mode}`=1 则 `send-keys -X cancel`；Enter 后 5–10 s 等匹配的 UserPromptSubmit，未到则截屏：**仅当** 输入框仍显示所粘贴文本且无任何对话框时重发 Enter（≤2 次，盲发 Enter 会选中对话框默认项、绕过策略）；否则抛可重试错误。hook 通道失效（T1、T10）导致 UserPromptSubmit 永不到达时告警/park，而不是与 D1 叠加无限重试 | 高 |
| T3 | `#send` 在屏幕非“干净就绪”时直接抛错，经 `#decisionFailure` 标为“Decision Worker API failed”并 park、杀死 Worker [code] | 横幅、残留输入、prompt suggestion 幽灵文本 [hyp] 都会导致无故 park | 适配器内轮询就绪 30–60 s 后再拒绝，并标记为可重试；Supervisor 对发送失败单独分类并重试；owned `--settings` 关闭 `promptSuggestionEnabled` | 高 |
| T4 | 与待发消息不精确匹配的 UserPromptSubmit 一律视为人工输入 → `humanRequired`，且 `worker_prompt` 来源不发 webhook，无输出 watchdog 暂停 [code] | 自动化 **无限期静默暂停** 直到 deadline 失败 | 适配器发送未确认的 30 s 窗口内的 UserPromptSubmit 视为自身消息；待发消息按时间过期而非在 Stop 时清空；无人值守时对 takeover 发告警；为 `worker_prompt` 引起的闸门单独记来源（现与显式 `takeover()` 共用 `#humanGate="other"`），仅该来源在可选/无人值守配置下“N 分钟无新人工输入且 Worker 空闲则自动恢复”——**永不** 清除显式 takeover 或 recover 后的接管 | 高 |
| T5 | Pi 正常关闭会 release owned 会话（移出 cgroup、停 guardian、退订 hooks、释放租约）；`recover` 总是启动 **新的** Claude [code] | 旧 Claude 在无监督下继续跑（hooks no-op），新 Claude 丢失上下文，二者同写一个工作树 | 最简：关闭时停止未完成任务的 owned Worker；更好：保留租约与 tmux 身份，`recover` 重新 adopt 存活的 pane（已有 `tmuxExpectedIdentity` 能力），不存在时才新起。须保持 `ownership=owned`（adopted 会话不允许 `killProcessGroup`）、重新挂回隔离、按“可能正处于轮次中”处理；并与 D12 协调——保留的租约 + 死掉的所有者 + 存活的 tmux 不能被当作孤儿回收 | 高 |
| T6 | `activeRequests` 只由发送或 UserPromptSubmit 置 1；忽略 `stop_hook_active` 与 Stop 的 `background_tasks`/`session_crons` [code][bin] | Stop-hook 续跑或后台代理运行时被当作空闲：发送被拒 → park，或边改文件边验证 | 主线程（无 `agent_id`）的 PreToolUse/PermissionRequest 在空闲时把 `activeRequests` 置回 1；Stop 的后台任务非空时确定性 `wait`（有界：常驻开发服务器永不结束，依赖 §3.2 A7 的空闲 watchdog 收口） | 中高 |
| T7 | StopFailure 的结构化 `error` 枚举（`rate_limit`/`overloaded`/`billing_error`/…）与 `error_details` 未被利用（`describeHookError` 只把类型/状态/消息作为文本交给 Decision）；重试由 Decision 决定且立即重发 [code][bin] | 限流/配额期间重试风暴 → 修复预算或 Decision 失败 → park | 限流/过载/服务错误由 Supervisor 按退避或 `error_details` 中的重置时间 **自动续跑**（不消耗 Decision 与修复预算）；认证/计费错误立即 park 并告警；识别“continuing automatically”（等待）与“press enter to continue”（发 Enter） | 中高 |
| T8 | interactive 模式下 `#monitor` 不看屏幕；`permission_prompt` 通知只记日志；AskUserQuestion 的 PreToolUse 超时返回 `{}` [code] | 对话框只能靠 20 分钟 watchdog（失败）发现；转圈卡住的轮次要等 4 小时 | AskUserQuestion 超时改为 deny（“无人可答，写明假设后继续”）；无待决请求时收到 `permission_prompt`/`elicitation_dialog` 通知 → 立即告警并 park；以“活跃轮次内 X 分钟无 hook 活动”作为卡死信号（X 须大于最长单次 Bash 工具运行时间） | 中 |
| T9 | hook 服务端单行 1 MB 上限，超限直接断开 [code] | 大文件 Write/Edit 权限请求或超长 Stop 失败 → 回退到等人的对话框 | relay 截断超长字段（保留长度与哈希），提高上限；**被截断的 Bash 命令一律拒绝**（不能对截断文本做策略判断） | 中 |
| T10 | hook socket 位于 `$XDG_RUNTIME_DIR`（无 linger 时随最后会话退出被删）；自动模式要求可写的委派 cgroup（ssh `session-N.scope` 为 root 所有）[code][hyp] | 所有 hook 静默 no-op；从 ssh 启动即失败 | socket 移到 `/tmp/pi-claude-supervisor-<uid>` 并定期自检重建；与 D7 一并解决 cgroup；文档写明 `loginctl enable-linger` 与 `systemd-run --user --scope -p Delegate=yes` | 中 |
| T11 | 验证中 release 以 `failed` 结束（§3.2 B5）；park 时 `#stopInternal` 关闭 owned tmux 会话 | 早上接手时 Claude 上下文已丢失 | 与 0.3 一并修 B5；interactive 模式下 park 改为 **交还会话（hand-back）**，保留 Claude 上下文供人接手 | 中 |

**其余（小项）**：信任对话框按 500 ms 间隔循环处理（2.1.281 有输入保护 [bin]）；其他启动对话框失败时附屏幕尾部；
权限决策时长封顶在 hook 预算内并丢弃过期排队事件；验证持有 `#exclusive` 期间 pre-phase 策略回答移到锁外；
以 `/`、`!`、`#` 开头的消息加安全前缀 [hyp]；重新 adopt 时关闭我方遗留的 `pipe-pane`；Worker 设 `DISABLE_AUTOUPDATER=1` [bin]
（或恢复时接受同一安装根）；`#detachCgroup` 前先 `cgroup.freeze`；SessionStart 后按 `session_id` 绑定。

**验收**：新增 **gated 真实 Claude interactive spike（走适配器 + hooks）**，覆盖：`cd` 后调用工具、>4 KB 消息、
copy-mode、Stop-hook block、后台任务、AskUserQuestion、限流模拟；在维护者的 cgroup v2 主机上作为发版清单必跑项。

### 5.2 阶段 D：去除过度防御，补齐底线

来源：只读防御机制审计（代码阅读 + 对 `evaluatePermission`/`parseReview` 的临时探针）。按“可靠性收益 / 风险”排序：

| # | 机制 | 对无人值守的伤害 | 建议 | 风险 |
|---|---|---|---|---|
| D1 | Decision 失败即 park：约 3 分钟重试后 park；应用动作时抛出的任何错误也被当作 API 失败 | 429/529 常持续更久；发送失败被误标为 API 失败 | 无人值守下对 **可重试的** provider 错误（限流、过载、5xx、超时）按上限退避持续重试直到 deadline；认证、计费、模型不存在等配置错误立即 park 并告警；权限请求回退到策略答案；动作应用错误单独分类（配合 T3） | 低 |
| D2 | Reviewer 回复解析：前后散文、额外键、字段顺序、嵌套值、缺 reviewId 均判格式失败；二次失败 → human → park；Provider 失败 4 次即 park | 真实模型的正常输出被判失败 | 保留 reviewId 与重复键检查；取回复中第一个带匹配 reviewId 的对象；忽略未知键；**取消字段顺序与扁平值规则**；格式失败换新会话重试；Provider 耗尽后稍后重验而非 park | 低–中 |
| D3 | 未跟踪的二进制、符号链接、硬链接、不可读文件使证据“不完整” → **无修复直接 park**（Reviewer 也拒绝） | Worker 加一张 PNG / fixture DB / symlink 就 park | 这类文件记为“omitted”，证据仍视为完整；git 读取失败重试一次；截断仍走修复 | 低 |
| D4 | 远端边界正则对整条命令匹配：误拒 `git commit -m "fix: push handler"`、`git stash push`、`git merge --abort`、`git log --grep=merge`、`grep -rn shutdown src/` 等；同一拒绝表也用于验收命令 | 常规开发命令被拒，Worker 反复绕路 | 按语句、在 git 子命令位置匹配（已有 `gitSubcommandIndex`）；只拒 push/send-pack/受保护 ref 的 update-ref，merge 仅在当前或目标为受保护分支时拒；shutdown/reboot 锚定到命令位置 | 低–中 |
| D5 | 含动态参数（`$VAR`、`$(…)`）的命令一律拒绝：`git show $SHA`、`npx vitest run $TEST_FILE` 等 | 频繁无谓拒绝 | 仅在 push/remote/config/改写分支语句中，或会被 shell/eval/xargs 执行时拒绝 | 低–中 |
| D6 | 可信 Claude 可执行文件要求每级父目录都无组写/全局写；恢复时钉死旧 realpath | umask 002 的发行版直接启动失败；Claude 自动更新后恢复失败 | 只拒全局可写或他人所有的路径；恢复时重新解析并记 `worker_executable_changed` 事件 | 低 |
| D7 | 自动模式强制 cgroup v2（`required`），父 cgroup 须可写，探针 1 s 超时 | ssh 会话、容器、高负载机器启动失败 | **（原阶段 5，采纳方案 B）** 复用 `PI_CLAUDE_SUPERVISOR_CGROUP_MODE`，默认 `auto`：cgroup 不可用时回退到按进程树/会话清理（已有 `process-tree.ts`，不只依赖 `kill-server`），每个任务标注“降级隔离”；`required` 可选。**依赖**：`canTakeoverLease` 要求已验证的 cgroup 边界（`cwd-lease.ts`），回退主机上崩溃后无法 `recover --takeover`——须先完成 D12 的租约改造 | 低–中 |
| D8 | 基线被改写（amend/squash 起始提交）即 park；detached HEAD 即 park | rebase 冲突中途或整理提交就 park | 基线改写：记事件并继续（`git diff <base>` 仍可用；须同时修改 `automaticRepositoryBoundary` 中同样的拒绝）；detached HEAD：先发修复轮（完成/中止 rebase、切回分支）再 park | 低 |
| D9 | `hybrid` 授权下的常规命令集以 npm 为中心；Write/Edit 到 `/tmp` 被拒；cwd 内经符号链接目录或硬链接的路径被误报为“Git metadata” | python/cargo/go/make/pnpm 每次都要 Decision 裁决（又一个 park 来源） | interactive 无人值守默认 `policy` 授权（配合下方删除底线）；允许 `os.tmpdir()`；realpath 仍在根内的符号链接放行；去掉 `nlink>1` 规则，保留 `.git` realpath 检查 | 中 |
| D10 | 重复相同发现 → human → park；Decision 回复中 `confidence` 越界或字段超 8 KB 使整个动作无效；noop 经再提示后 park | 可修复的情形被提前 park | 交给修复预算决定；clamp/忽略 `confidence`、截断长字段；`turn_completed` 上的 noop 映射为 verify | 低 |
| D11 | 运行时目录的 lstat “非真实目录”检查（dotfiles 管理器常把 `~/.local/state` 做成符号链接）；adopt 身份检查要求 pane cwd 逐字节一致且把 Claude argv 过拒绝表 | 启动/接管无故失败 | 先解析路径再检查；argv 不过拒绝表（配合 D4） | 低 |
| D12 | cwd 租约（1288 行）：崩溃的 Pi 留下的租约在 tmux/cgroup 仍存活时需人工 `recover --takeover` | 无人值守下无法自动接续 | 自动回收可证明为孤儿的 owned tmux 服务器；接管事务机制简化为“锁 + 所有者 pid/启动时间 + Worker 存活检查” | 中 |

**底线清单（必须保留或新增）**：
- **新增：删除/移动底线**（**必须先于 D9、D5 上线**）。现状：Bash 中只拦截 `/`、`/*`、`-- /`；`rm -rf ~/other-project`、
  `rm -rf ~`、`rm -rf /home`、`rm -rf /usr`、`find ~ -delete`、`rm -rf "$HOME"`、`rm -rf $(pwd)/../x`、`cd /tmp && rm -rf *`、
  `rm -rf .git` 均被放行（现有 `hybrid` 授权下这些不是常规命令，由 Decision LLM 把关；放宽为 `policy` 后只剩底线）。规则：
  对 `rm`/`mv`/`find -delete`/`git clean`/`shred` 等删除或移动类语句——
  1. 目标为动态（变量、命令替换、glob）时拒绝；同一命令中该语句前有 `cd`/`pushd`/`-C` 时拒绝；
  2. 字面目标解析后位于 cwd、写入根与临时目录之外时拒绝（`namesPathOutsideCwd` 会把 `"$HOME"`/`$(...)` 当作 cwd 内路径，不能单独依赖）；
  3. 删除或移动 `.git`，以及 `git gc --prune`、`git reflog expire` 拒绝（`remoteAuthority` 默认 none，本地提交是唯一副本）；
  4. D5 的动态参数放宽 **不适用于** 删除/移动目标。
- 保留：拒绝 push、send-pack/receive-pack、PR/release/API 变更、合并进受保护分支（按 D4 收窄匹配方式）；拒绝修改
  git remote 与传输配置（`remote`、`url`、`push`、`credential`、`core.hooksPath`）；拒绝写 `.git` 元数据（现状仅覆盖 Write/Edit；Bash 侧由上条补齐）；拒绝改写/删除受保护分支；
  interactive 模式保留 PreToolUse 否决；开启推送授权时保留字面授权与远端 URL 基线；杀进程/tmux 服务器前的 pid + 启动时间身份核验；
  每个工作树一个租约（核心形态）；日志/prompt/webhook 的脱敏（与校验分离）；deadline、轮次与修复预算。

**冻结或移除候选**：`#humanGate = "permission"` 死代码；structured bridge（审计估计约占 `tmux-adapter.ts` 一半，未精确统计）、process-pipe/manual 传输、
仅 headless 的设置检查——若 interactive 为主力，冻结或移到独立文件；发布授权机制已默认关闭，保持现状。

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

**0.3 已知行为缺口修复**（显式行为变更，单独 PR）：实现 §3.2 B1（操作员停止唯一优先）、B3（终态清除待决决策）
与 B5（`#releasing` 时跳过修复与 `adapter.stop`，以 released/parked 结束），各带竞态回归测试；B2（延迟而不丢失）需先确认权限请求重放的交互，单独评估。

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
| 2.3 | 抽出 Decision 裁决管线，保持现有顺序与语义（含 §3.2 A6）；事件增加结构化 guard 字段（B4） | ✅ |
| 2.4 | 抽出 `PublishCycle`（保持 §3.2 A5） | 可选 |
| 2.5 | 抽出 watchdog / usage（保持 §3.2 A7、A8）；进一步缩减 `supervisor.ts` | 可选 |

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
- 哪些终止会关闭恢复记录：清理已确认的 `completed` 与 `human_stop`。`blocked`、`failed`、关机停止
  （`preserveDecisionSession` → `recoverable_failure`）、watchdog / 无输出停止、Decision 普通 stop、启动期间的停止或失败、
  清理未确认的停止都会标记为可恢复中断；`release()` 本身不改动记录（但验证中 release 会以 failed 结束，见 B5）。正是这些任务需要完整的恢复状态。
- 同时消除 `index.ts` 中两处重复的进度持久化逻辑（启动与恢复路径共用一个函数）。
- 测试：修复中途 recover、stop→verify 中途 recover；`spike:decision` 新增 `recover` 场景。

### 阶段 4：验证环境与测试卫生（可与阶段 2 并行）

- **发版清单**：每次发版前在 cgroup v2 主机执行 `spike:decision`（至少两个模型）+ `spike:automation` + `spike:tmux`，
  结果记录到 `docs/stability-matrix-*.md`。
- **测试卫生**：依赖 `process.cwd()` 的测试改为各自创建临时 git 仓库；`environment.test.ts` 的可信可执行文件夹具
  放到可信父目录下（如 `$HOME` 下的 0700 目录），不能放在 `/tmp` 下。
- **Reviewer 解析**：按 D2 简化，不再追加防御层；以 `architecture.md` 记录简化后的威胁模型与已接受残余风险。
- **上游契约测试**：为 Claude Code `stream-json` / hooks 负载保存版本化夹具，版本升级时先跑契约测试。

### 阶段 5：部署门槛（已决策：采纳方案 B，并入阶段 D 的 D7）

automatic 模式强制 cgroup v2，容器、macOS、部分 NAS/WSL 无法使用：

| 方案 | 说明 | 风险 |
|---|---|---|
| A. 维持现状 | 只在 cgroup v2 主机运行 | 可用范围窄 |
| B. 降级模式（**已采纳，见 D7**） | 复用现有 `PI_CLAUDE_SUPERVISOR_CGROUP_MODE`，自动模式默认 `auto`：cgroup 不可用时回退到进程组/进程树清理，每个任务都在事件与 `status` 标注“降级隔离”；`required` 可选 | setsid/daemon 化的后台进程可能残留 |
| C. 容器化隔离 | 每任务一个容器 | 复杂度与依赖显著上升，不建议现在做 |

## 6. 本路线图之外、但影响长任务的已知风险

以下议题中，tmux 屏幕/hooks 可靠性与策略拒绝已分别并入阶段 T 与阶段 D；其余作为后续独立议题跟踪：

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
| 放宽防御后出现破坏性操作 | 删除底线先于 D9 上线；§5.2 底线清单逐项保留并有测试 |
| [hyp] 项判断有误 | 先建 interactive 真实 spike，用实测确认后再改；未证实的项不作为行为变更依据 |
| LLM 行为随模型变化 | 以 guard 兜底而非 prompt；spike 多模型回归 |
| 无进展检测误伤合法的连续排查 | 先观察模式；阈值可配置；只看仓库指纹 |
| schema 迁移破坏旧恢复记录 | 版本化 + 保守默认 + 迁移测试 |

## 9. 成功标准

- interactive 真实 spike（走适配器 + hooks）在发版清单中通过，覆盖 §5.1 验收列出的场景。
- 阶段 0 报告中，“发送失败 / 误判人工接管 / 证据不完整 / 策略误拒”导致的 park 归零或有明确解释；删除底线测试覆盖 §5.2 列出的全部示例。

- `StopIntent` 与 `VerificationCycle` 独立成模块，有转换表与表驱动测试；§3.2 A 有特征测试，B 已实现并有违反即失败的测试。
- 报告命令可给出无人值守完成率、park 原因分布、覆盖次数；阶段 1 启用覆盖后，“无验证运行到 deadline/配额耗尽”归零。
- recover 后所有确定性兜底仍然生效（阶段 3 测试）。
- 连续两个版本发版清单全部通过，且无因生命周期交互导致的回归。

## 10. 建议顺序与当前最小版本

```text
第一波（速赢，S 级，确定性）：T1 T2 T3 T4、D1 D3、0.3（B1 B3 B5）+ T11 hand-back、删除底线、0.1 报告、interactive 真实 spike
第二波：T5 T6 T7 T8、D12（租约简化，先于 D7 与 T5 的重新 adopt）、D2 D4 D5 D6 D7 D8 D9 D10、0.2 校验拆分
第三波：阶段1（无进展，先观察）→ 阶段2 核心（2.0→2.1→2.2→2.3）→ 阶段3（恢复补齐）；T9 T10、D11、阶段4 并行
```

**依赖与顺序理由**：第一波每项都小且独立，直接消除“静默卡死 / 无故 park / 杀掉会话”；删除底线必须先于 D9 放宽上线；
interactive 真实 spike 先建好，用于验证第一、二波中标 [hyp] 的项；阶段 2 重构放在行为修正之后，
避免一边改行为一边搬代码。

**最小下一步**：T1（hook 路由，一行环境变量 + relay 路由键）与 T2/T3（发送确认与就绪轮询）——
它们是 interactive tmux 下“静默失去监督”和“无故 park”的最大来源，改动小、可单测，且能用新的 interactive spike 实证。
