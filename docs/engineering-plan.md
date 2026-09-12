# Pi Claude Supervisor 完整方案

> 文档状态：方案设计稿 / MVP 实施基线  
> 目标项目目录：`pi-claude-supervisor`  
> 适用对象：W、项目负责人、实现人员、评审人员

## 1. Executive Summary

本项目的目标不是替代 Claude Code，也不是简单地给 Claude 增加一个自动 `continue` 脚本，而是建立一个外部工程监督回路：

```text
用户
  │
  ▼
Pi Supervisor
  │ 观察、判断、纠偏、验收
  ▼
Claude Code Worker
  │ 编码、测试、修改工作树
  ▼
代码、测试结果、git diff、运行证据
```

核心角色定义：

- **Pi Supervisor**：负责任务约束、生命周期控制、停顿判断、人工升级、证据收集和最终验收。
- **Claude Code Worker**：负责根据任务执行代码修改、运行测试和汇报当前状态。
- **Human**：处理产品决策、架构分歧、危险操作和 Supervisor 无法可靠判断的问题。
- **Independent Verifier**：在 Worker 声称完成后，以只读方式重新检查代码和验证结果。

最终目标是让 Claude Code 能够在较长任务中持续工作，同时避免以下问题：

1. Worker 因提问或短暂停顿导致任务中断。
2. Worker 在架构选择上偏离既定约束。
3. Worker 声称完成，但没有实际完成目标。
4. Supervisor 因误判导致无限循环、危险操作或不可审计的修改。
5. 人工无法随时接管或恢复任务。

**总体判断：架构方向可以 GO。先完成兼容性 Spike、生命周期和故障恢复验证；低权限用户、OS sandbox 与网络隔离不作为当前主线或硬性阻塞，按调用者明确授权和宿主机策略运行，后续再做安全加固。**

---

## 2. 背景与问题定义

### 2.1 当前问题

Claude Code 适合作为实际开发 Worker，但在长时间任务中可能出现：

- 等待用户回答；
- 询问“是否继续”；
- 长时间无输出但进程仍存活；
- 运行测试或外部命令时卡住；
- 选择了不符合项目约束的实现方案；
- 在未完成全部目标时提前停止；
- 输出了“已完成”，但没有可复现的证据。

单纯使用正则匹配并自动发送 `continue` 存在明显风险：它只能识别表面语言，无法理解当前任务、代码差异、项目规范和风险等级。

### 2.2 目标问题

本项目需要解决的是一个**工程控制问题**：

> 在不剥夺人工控制权的前提下，让一个外部 Supervisor 观察和管理 Claude Code 的执行过程，并使用可靠证据判断任务是否真的完成。

### 2.3 需求边界

第一阶段明确只支持：

- 单仓库；
- 每个任务一个 Claude Worker；
- 每个并行任务使用独立 worktree/工作目录；
- Pi 负责监督和验收；
- 人工可以随时接管；
- 不自动 merge、deploy 或 release。

当前扩展已支持多个独立任务会话并行推进，但不允许活动会话共享同一
工作目录。事件日志由跨进程锁协调，状态和 watchdog 按会话隔离。

暂不支持：

- 多 Worker 在同一 worktree 的无协调协作；
- 自动生产发布；
- 自动处理所有架构和产品决策；
- 将网络一律封禁或声称有未经验证的域名 allowlist；
- 无人工审批的危险操作；
- 用 Worker 自己的报告代替独立验收。

---

## 3. 设计原则

### 3.1 Worker 和 Supervisor 职责分离

Claude 负责执行，Pi 负责控制和判断。不能让 Worker 自己同时担任执行者、验收者和最终批准者。

### 3.2 确定性策略优先于 LLM 判断

LLM 可以帮助理解上下文，但不能绕过硬性安全策略。所有高风险动作必须先经过确定性 Policy Gate。

```text
事件
  │
  ▼
确定性 Policy Gate
  │
  ├── 明确禁止：拒绝
  ├── 必须人工：升级
  ├── 低风险且白名单：允许
  └── 需要语义理解：交给 Supervisor LLM
```

### 3.3 证据优先于声明

Worker 说“完成了”不是完成证据。最终状态必须由以下信息支持：

- 当前任务目标；
- 任务清单；
- 实际 git diff；
- 测试、lint、typecheck、build 结果；
- 约束检查结果；
- 独立 Reviewer 报告。

### 3.4 人工拥有最高控制权

人工可以：

- 暂停 Worker；
- 修改 Supervisor 指令；
- 直接回答问题；
- 接管终端；
- 强制终止任务；
- 否决 Supervisor 的继续决定。

Supervisor 任何时候都不能阻止人工接管。

### 3.5 默认保守，逐步自动化

MVP 只自动处理低风险、可逆、规则明确的情况。随着测试和审计证据增加，再逐步开放更多自动化能力。

### 3.6 所有重要动作可追溯

每次状态变更、发送给 Worker 的指令、人工操作、验证结果都必须写入事件日志。

---

## 4. 推荐总体架构

```text
┌──────────────────────────────────────────────┐
│                    User / Human              │
│        接管、审批、回答决策、终止任务         │
└─────────────────────┬────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│                 Pi Supervisor                │
│                                              │
│  Task Context                                │
│  State Machine                               │
│  Policy Gate                                 │
│  Supervisor Judgment                         │
│  Event Log                                   │
│  Budget / Timeout Controller                 │
│  Verification Coordinator                   │
└─────────────────────┬────────────────────────┘
                      │ Worker Adapter
                      ▼
┌──────────────────────────────────────────────┐
│               Claude Code Worker             │
│                                              │
│  PTY 或 headless JSONL                      │
│  实时输出                                    │
│  输入 / 继续 / 纠偏                          │
│  session resume                              │
└─────────────────────┬────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│              Repository / Worktree           │
│      source code / tests / git diff          │
└─────────────────────┬────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│              Independent Verifier            │
│   测试、静态检查、diff 审核、安全和证据检查    │
└──────────────────────────────────────────────┘
```

### 4.1 Worker Adapter

Supervisor 不应直接依赖某一个 package 的内部 API，而应定义自己的 Worker Adapter 接口：

```ts
interface WorkerAdapter {
  start(input: WorkerStartInput): Promise<WorkerHandle>;
  getStatus(handle: WorkerHandle): Promise<WorkerStatus>;
  readOutput(handle: WorkerHandle): Promise<WorkerOutputChunk[]>;
  send(handle: WorkerHandle, message: string): Promise<void>;
  pause(handle: WorkerHandle): Promise<void>;
  resume(handle: WorkerHandle): Promise<void>;
  takeover(handle: WorkerHandle): Promise<void>;
  stop(handle: WorkerHandle, reason: string): Promise<void>;
  resumeSession(sessionId: string): Promise<WorkerHandle>;
}
```

Adapter 必须屏蔽以下实现差异：

- PTY 交互模式；
- headless JSONL 模式；
- 不同 package 的事件格式；
- session ID 和进程 ID 的差异；
- 退出码和异常退出语义。

### 4.2 初始组件策略

不要一开始同时引入所有候选项目。

建议顺序：

1. 优先验证 `pi-interactive-shell` 是否能稳定完成启动、观察、输入和人工接管。
2. 借鉴 `pi-goals` 的 Goal / Evidence / Sign-off 思路，而不是直接假设它可以作为 Claude Worker。
3. 如需 headless watchdog，再验证 `pi-claude-code` 类方案。
4. 将 `pi-harness-delegate` 作为 review、resume 或独立任务执行候选。
5. 所有组件通过 `WorkerAdapter` 接入，避免多个 package 重复管理生命周期。

候选项目的具体 API、版本、发布时间和 Claude 兼容性必须以实际安装和测试结果为准。当前调研文档中的“70%～85% 已完成”没有可审计计算依据，不能作为工程承诺。

---

## 5. 状态机设计

### 5.1 状态定义

```text
CREATED
  ↓
STARTING
  ↓
RUNNING
  ├── WAITING
  ├── BLOCKED
  ├── DECISION_REQUIRED
  ├── VERIFYING
  ├── FAILED
  └── STOPPED

WAITING ────────────────┐
  │                     │
  ├── CONTINUE ─────────┘
  ├── ANSWER ────────────> RUNNING
  ├── REDIRECT ──────────> RUNNING
  └── ESCALATE ──────────> HUMAN_REQUIRED

RUNNING ── Worker 报告完成 ──> VERIFYING
VERIFYING ── 通过 ──> COMPLETE
VERIFYING ── 失败 ──> REJECTED
REJECTED ── 修复 ──> RUNNING
HUMAN_REQUIRED ── 人工决定 ──> RUNNING / STOPPED
```

### 5.2 状态说明

| 状态 | 含义 | 自动动作 |
|---|---|---|
| `CREATED` | 任务已创建但尚未执行 | 校验任务配置 |
| `STARTING` | 正在启动 Worker | 等待启动事件 |
| `RUNNING` | Worker 正在工作 | 采集输出和指标 |
| `WAITING` | Worker 正常等待输入 | 判断是否可自动处理 |
| `BLOCKED` | Worker 被异常、环境或依赖阻塞 | 收集原因并升级 |
| `DECISION_REQUIRED` | 需要架构/产品/权限决策 | 默认人工审批 |
| `HUMAN_REQUIRED` | 已明确升级人工 | 暂停自动动作 |
| `VERIFYING` | 执行独立验收 | 只执行验证流程 |
| `REJECTED` | 验收失败，需要修复 | 生成修复任务 |
| `COMPLETE` | 所有目标和验收证据满足 | 允许 sign-off |
| `FAILED` | 系统或 Worker 不可恢复失败 | 保留现场并报告 |
| `STOPPED` | 用户或策略主动停止 | 不再自动恢复 |

### 5.3 状态转换要求

每次转换必须记录：

```json
{
  "event": "STATE_CHANGED",
  "from": "WAITING",
  "to": "DECISION_REQUIRED",
  "reason": "Worker 提出架构选择",
  "actor": "supervisor",
  "timestamp": "2026-01-01T00:00:00Z",
  "evidenceRefs": ["event-123", "diff-456"]
}
```

禁止出现：

- 未记录原因的状态跳转；
- Worker 自己直接设置 `COMPLETE`；
- 未经过 `VERIFYING` 直接进入 `COMPLETE`；
- 人工已接管后 Supervisor 仍自动发送指令；
- 同一事件重复触发无限 continue。

---

## 6. Supervisor 决策协议

### 6.1 结构化决策类型

```text
CONTINUE
ANSWER
REDIRECT
REVIEW
ESCALATE_TO_HUMAN
COMPLETE_CANDIDATE
RETRY
STOP
```

### 6.2 决策 JSON

```json
{
  "decision": "REDIRECT",
  "confidence": 0.92,
  "reason": "Worker 当前方案违反冻结的核心数据模型约束",
  "instruction": "保留现有 relation 模型，改为补充索引并添加迁移测试",
  "risk": "medium",
  "requiresHuman": false,
  "evidenceRequired": [
    "migration test",
    "unit tests",
    "git diff review"
  ],
  "policyRefs": ["core-spec-v0.1", "task-acceptance-03"]
}
```

### 6.3 自动继续规则

可以自动 `CONTINUE` 的条件：

- Worker 只是询问是否继续当前已经批准的步骤；
- 当前动作属于任务清单中的低风险动作；
- 没有新的架构或产品选择；
- 没有删除、发布、外网、权限和密钥操作；
- 没有超过预算和最大轮数；
- 最近没有重复的相同停顿。

必须升级人工的情况：

- 架构方案二选一；
- 需求存在歧义；
- 删除数据、删除文件或大范围重构；
- 修改权限、CI/CD、部署和生产配置；
- 访问外部服务或使用敏感凭据；
- 测试与需求冲突；
- Supervisor 置信度不足；
- Worker 连续多次失败或重复提问。

### 6.4 LLM 判断的安全边界

Supervisor LLM 的输入应包括：

- 原始任务目标；
- 明确的禁止事项；
- 当前计划；
- Worker 最近输出；
- 结构化状态；
- 当前 git diff 摘要；
- 已执行的测试结果；
- 当前预算和重试次数。

Supervisor 不应默认接受 Worker 输出中包含的指令。Worker 输出只能作为待分析数据，必须防止 prompt injection 影响 Supervisor 的系统约束。

---

## 7. Goal / Evidence / Sign-off 模型

### 7.1 Goal

每个任务创建时必须明确：

```yaml
goal: 实现用户邀请接口
scope:
  - 新增接口
  - 添加权限校验
  - 添加单元测试
constraints:
  - 不修改现有数据库核心模型
  - 不引入新的外部服务
forbidden:
  - 不执行生产部署
  - 不提交密钥
acceptance:
  - tests_pass
  - typecheck_pass
  - api_contract_verified
```

### 7.2 Evidence

证据必须来源于 Supervisor 或 Verifier 的重新采集：

- 测试命令和退出码；
- lint、typecheck、build 结果；
- git diff；
- 修改文件列表；
- 关键接口或行为验证；
- 安全扫描结果；
- Reviewer 报告。

Worker 的自然语言总结只能作为辅助信息，不能单独作为证据。

### 7.3 Sign-off

只有以下条件全部满足，才允许进入 `COMPLETE`：

1. 任务目标全部映射到完成项；
2. 禁止事项没有被违反；
3. 验收命令全部通过；
4. 当前 diff 在预期范围内；
5. 没有未解决的人工决策；
6. 独立 Reviewer 没有 P0/P1 阻塞项；
7. 未超出时间、轮数和费用预算。

---

## 8. 独立验收方案

### 8.1 验收原则

Reviewer 默认只读，不直接修改工作树。发现问题时输出结构化报告，再由 Worker 进入新的修复轮次。

这样可以避免：

- Reviewer 和 Worker 互相覆盖证据；
- Reviewer 修改后无法知道原始问题；
- 验收与实现职责混合；
- 审计时无法重现过程。

### 8.2 验收流程

```text
Worker 声称完成
       ↓
冻结当前快照和 git diff
       ↓
重新执行测试、lint、typecheck、build
       ↓
检查任务目标与禁止事项
       ↓
只读 Reviewer 审核 diff
       ↓
全部通过？
  ├── 是：COMPLETE / SIGN-OFF
  └── 否：REJECTED / 生成修复任务
```

### 8.3 验收报告格式

```json
{
  "verdict": "REJECT",
  "summary": "权限校验未覆盖管理员路径",
  "findings": [
    {
      "severity": "P1",
      "file": "src/api/invite.ts",
      "line": 42,
      "message": "缺少角色校验",
      "requiredFix": "补充管理员和普通用户的权限测试"
    }
  ],
  "tests": {
    "unit": "passed",
    "typecheck": "passed",
    "security": "failed"
  }
}
```

---

## 9. MVP 分阶段实施计划

### Phase 0：兼容性 Spike

目标：证明底层 Worker 控制链路可用。

工作内容：

- 固定 Pi、Claude Code 和候选 package 版本；
- 实现最小 Worker Adapter；
- 启动 Claude；
- 读取实时输出；
- 发送输入；
- 检测退出和异常；
- 实现人工接管；
- 验证 session resume；
- 保存最小事件日志。

通过标准：

- 4 个固定场景全部可重复；
- 不出现输入丢失；
- 不出现进程孤儿；
- 人工可随时接管；
- 异常退出可以被识别并报告。

### Phase 1：安全 MVP

范围：

- 单仓库；
- 单 Worker；
- 单 worktree；
- 单任务；
- 低风险自动 continue；
- 高风险人工升级；
- 最大执行时间和最大轮数；
- 基础 Goal / Evidence / Sign-off；
- 基础验证命令。

暂不做：

- 自由 LLM 决策；
- 自动修复；
- 多 Worker；
- 自动 merge/deploy。

### Phase 2：Supervisor 决策层

工作内容：

- 完整状态机；
- 结构化决策协议；
- Policy Gate；
- Supervisor LLM 判断；
- WAITING、BLOCKED、DECISION_REQUIRED 分类；
- 重复停顿检测；
- 任务持久化和恢复。

### Phase 3：独立验收

工作内容：

- 干净快照验证；
- 测试、lint、typecheck、build；
- 只读 Reviewer；
- 结构化 findings；
- 修复轮次和重新验证；
- 证据归档。

### Phase 4：生产化与安全加固（非当前主线）

生命周期正确性和可审计性完成后再推进：

- 可选 OS sandbox、低权限用户和网络白名单；
- 密钥隔离；
- 依赖和版本锁定；
- 审计日志；
- 监控和告警；
- 费用控制；
- 灰度运行；
- 故障恢复和人工值守。

本阶段不阻塞当前 Supervisor 功能、Worker 生命周期、进程组清理、resume
和独立验收工作。Worker 可在用户明确授权及宿主机策略允许的权限范围内运行，
但不自动 merge、deploy、release 或 publish。

---

## 10. Spike 测试矩阵

| 场景 | 预期行为 | 通过标准 |
|---|---|---|
| 正常完成 | Worker 完成任务并退出 | Supervisor 收集 diff 和测试证据 |
| 普通确认 | Worker 询问是否继续已批准步骤 | 自动发送一次 continue |
| 架构决策 | Worker 提出两种实现方案 | 升级人工，不自动选择 |
| 长时间无输出 | Worker 无输出但进程仍在 | 触发 watchdog，先检查再决定 |
| Worker 崩溃 | 进程异常退出 | 记录退出原因，可恢复或升级 |
| 测试失败 | Worker 声称完成但测试失败 | 进入 REJECTED 或修复轮次 |
| 重复提问 | Worker 多轮重复等待 | 触发人工升级，禁止无限 continue |
| 危险命令 | 删除、发布、使用密钥等 | 被 Policy Gate 拦截 |
| 人工接管 | 用户接管终端 | Supervisor 停止自动发送指令 |
| session 恢复 | Supervisor 重启 | 根据持久化状态恢复或安全暂停 |

---

## 11. 安全设计

### 11.1 权限控制

权限不是“一律拒绝”，而是分层处理：

- Claude Code 自身负责工具级权限请求和用户交互；
- Supervisor 对 Worker 启动命令做确定性分类；
- 明确破坏性或绕过权限的参数仍拒绝；
- `review` 命令通过 Pi UI 请求用户批准，批准结果写入事件日志；
- 普通联网命令默认不因“联网”本身拒绝，下载后直接交给 shell 的模式要求人工复核；
- 无交互 UI 时不能伪造批准，review 命令失败关闭。

### 11.1.1 多会话与活跃请求

每个任务会话拥有独立 Supervisor、Worker handle、turn budget、watchdog
和状态机。共享 EventLog 使用原子 lock directory、owner PID、超时和存活
检测；写入前刷新磁盘序号，避免多个 Pi 进程产生重复序号。

Claude JSONL adapter 追踪 `activeRequests`、`lastInputAt` 和
`lastOutputAt`，以 `result` 记录作为一轮完成信号。Supervisor/UI 可通过
`poll` 或 `sessions` 查看各会话进度；`poll all` 批量观察活动会话。当前不
自动调度任务依赖、不在同一工作树合并变更，也不把“有输出”当作已完成。

MVP 默认：

- 使用独立 worktree，活动会话之间不得共享或重叠工作目录；
- 权限和网络不作一律封禁，由调用者显式配置并承担宿主机权限责任；
- 凭据仍按最小必要继承，避免无意泄露；
- 明确危险命令、权限绕过参数和生产发布动作仍需 Policy Gate/人工批准；
- 不自动 merge、deploy、release 或 publish。

### 11.2 危险操作

以下操作必须人工确认：

- `rm`、批量删除、数据库迁移破坏性操作；
- `git reset --hard`、强制 push；
- 修改 CI/CD、部署和生产配置；
- 发送外部请求；
- 读取或写入密钥；
- 发布 npm/package/release；
- 自动 merge；
- 启动高权限命令。

### 11.3 Prompt Injection 防护

- Worker 输出视为不可信内容；
- Supervisor 的系统约束不能被 Worker 覆盖；
- 工具调用前必须经过 Policy Gate；
- 外部内容、README、issue 和日志不能直接改变安全策略；
- 重要决策需要结构化证据。

### 11.4 日志脱敏

日志中禁止保存：

- API key；
- token；
- cookie；
- 密码；
- 完整私钥；
- 未脱敏的用户隐私数据。

---

## 12. 成本、超时和失控控制

必须配置以下限制：

```yaml
limits:
  # Long development-task defaults; each task may override them.
  maxTaskDuration: 4h
  maxSupervisorRounds: 100
  maxWorkerRestarts: 3
  maxRepeatedContinue: 3
  maxNoOutputDuration: 20m
```

控制规则：

- 相同输出和相同停顿不得无限触发 continue；
- 超过最大轮数必须升级人工；
- Supervisor 自身异常时默认暂停 Worker，而不是继续放行；
- Worker 重启必须保存原始现场；
- 任务恢复时先进入 `HUMAN_REQUIRED` 或 `VERIFYING`，不能盲目继续；
- 时间、自动轮数和重试次数必须记录；模型供应商自身的上下文/token 限制不由本项目重复管理。

---

## 13. 可观测性和审计

### 13.1 事件类型

```text
TASK_CREATED
WORKER_STARTED
WORKER_OUTPUT
WORKER_WAITING
WORKER_INPUT_SENT
POLICY_BLOCKED
SUPERVISOR_DECISION
HUMAN_TAKEOVER
WORKER_EXITED
WORKER_FAILED
VERIFICATION_STARTED
VERIFICATION_RESULT
STATE_CHANGED
TASK_COMPLETED
TASK_REJECTED
TASK_STOPPED
```

### 13.2 最小事件字段

```json
{
  "eventId": "evt-001",
  "taskId": "task-001",
  "timestamp": "2026-01-01T00:00:00Z",
  "type": "SUPERVISOR_DECISION",
  "actor": "supervisor",
  "state": "WAITING",
  "payload": {},
  "evidenceRefs": [],
  "parentEventId": null
}
```

### 13.3 必须可回答的问题

系统完成后，应能回答：

1. Worker 为什么停顿？
2. Supervisor 为什么选择继续或升级？
3. 发送了什么指令？
4. 哪些动作是人工批准的？
5. 最终 diff 是什么？
6. 哪些测试实际重新执行过？
7. 谁批准了最终完成？
8. 是否超出预算、权限或任务边界？

---

## 14. 关键风险和应对方案

| 风险 | 等级 | 应对方案 |
|---|---:|---|
| package API 与文档不一致 | P1 | 固定版本，先做 Spike，不直接承诺兼容 |
| PTY 输出解析不稳定 | P1 | Worker Adapter + 事件归一化 + 回放测试 |
| LLM 错误判断 | P1 | Policy Gate、人工升级、置信度阈值 |
| 无限 continue 循环 | P1 | 最大轮数、重复检测、冷却时间 |
| Worker 输出 prompt injection | P1 | 输出不可信化、工具调用前策略拦截 |
| Reviewer 不够独立 | P1 | 独立上下文、只读验收、证据重新采集 |
| 误操作生产环境 | P0 | 人工审批、独立验收、禁止自动 merge/deploy/release/publish；sandbox/白名单作为后续加固 |
| Worker 崩溃后状态丢失 | P2 | Decision Worker session/task mapping 持久化，异常重启后显式 recovery；Claude Worker 本身不静默 resume |
| 多会话互相覆盖 | P1 | 独立 cwd/worktree 检测、共享事件锁、会话级 watchdog |
| Decision Worker/API 不可用 | P1 | 直接记录事件并通过人工通知通道告警，不尝试第二个 LLM fallback |
| 审计无法复现 | P2 | 保存事件、输入、输出摘要、diff 和验证结果 |

---

## 15. MVP 验收标准

MVP 必须满足：

### 功能验收

- [ ] 可以创建带目标、约束和验收命令的任务。
- [ ] 可以启动 Claude Worker。
- [ ] 可以读取 Worker 输出。
- [ ] 可以向 Worker 发送低风险继续指令。
- [ ] 可以识别等待、异常退出和超时。
- [ ] 可以人工接管和停止任务。
- [ ] 可以记录状态变化和 Supervisor 决策。
- [ ] 可以重新执行验收命令。
- [ ] 可以输出最终 diff 和证据报告。
- [ ] 未通过验证时不能进入 `COMPLETE`。

### 安全验收

- [ ] 危险命令会被拦截或升级人工。
- [ ] 人工接管后不再自动发送指令。
- [ ] 有最大时间、轮数和重试限制。
- [ ] 日志不会泄露密钥和 token。
- [ ] Decision Worker API 失败会直接触发人工通知。
- [ ] Worker 输出不能覆盖 Supervisor 的安全策略。
- [ ] Supervisor 故障时默认采取 fail-closed 行为。

### 稳定性验收

- [ ] 四个基础场景可重复通过。
- [ ] 进程异常退出后不会留下失控 Worker。
- [x] Supervisor/Pi 非正常重启后可以发现 `recoverable` 任务，并通过显式 recovery 恢复 Decision Worker 上下文；不会静默重复启动。
- [ ] 相同事件不会被无限重复处理。
- [ ] 事件日志可以还原一次完整任务过程。

---

## 16. 建议的实现顺序

```text
1. 确定候选 package 和精确版本
2. 编写 WorkerAdapter 接口
3. 完成 Claude 启动 / 输出 / 输入 / 停止 Spike
4. 加入事件日志
5. 实现有限状态机
6. 加入 Policy Gate
7. 加入人工 takeover
8. 加入固定验收命令
9. 加入独立只读 Reviewer
10. 加入持久化和恢复
11. 完成安全和故障测试
12. 再考虑 LLM 自动判断和生产化
```

不建议的顺序：

```text
直接安装多个 package
  ↓
直接让 LLM 自动判断所有停顿
  ↓
直接自动修复、merge、deploy
```

---

## 17. 待确认问题

在进入正式开发前，需要 W 明确：

1. 第一阶段是否只支持 Claude Code CLI？
2. 是否必须支持人工实时接管？
3. Worker 是否允许联网？允许哪些域名？
4. 哪些命令被视为高风险？
5. Reviewer 是否必须使用不同模型或不同上下文？
6. 是否允许 Reviewer 生成修复建议但不直接改代码？
7. 任务最大运行时间和费用预算是多少？
8. 验收命令由谁提供？项目是否已有统一测试脚本？
9. 第一版是否需要 session resume？
10. 是否要求产出完整的审计日志和任务报告？

---

## 18. 给 W 的最终结论

> 这个方向可以做，但当前调研文档不能直接作为生产实施方案。建议先固定 Pi、Claude Code 和相关 package 的版本，完成一个真实任务的兼容性 Spike，证明系统能够稳定完成“启动—观察—提问—接管—恢复—独立验收”闭环。
>
> 第一版应采用“确定性策略 + LLM 辅助判断 + 人工升级 + 可复现验收”，而不是让 LLM 自由决定所有动作。`pi-goals` 的 Goal / Evidence / Sign-off 思想值得吸收，但 PTY、watchdog 和 delegate 能力必须通过统一 Worker Adapter 组合。
>
> 最终判断：**架构方向 GO；先完成生命周期和故障恢复主线。低权限用户、sandbox 与网络隔离属于后续安全加固，不作为当前主线阻塞；在明确授权下仍禁止自动发布类动作。**

---

## 19. 独立评审后的整合决策

本方案已经过独立子 Agent 评审，并结合候选扩展检索结果进行修订。核心原则从“组合多个 package”调整为“复用已验证的底层能力，自建最薄的控制边界”。

### 19.1 复用决策

| 类型 | 处理方式 |
|---|---|
| `pi-interactive-shell` | 优先作为 PTY transport 做 Spike；验证通过后复用其 PTY、实时输出和人工接管能力 |
| `pi-foreground-chains` | 只借鉴有限循环、等待检测和 reviewer 分阶段流程；不直接复制 regex 决策 |
| `pi-goals` / `pi-goals-extension` | 复用 Goal、Evidence、Discriminator、Sign-off 数据模型；不直接作为 Claude Worker runtime |
| `pi-claude-code` | 暂不作为 MVP 核心依赖；完成版本、API、许可证和故障审计后再评估 |
| `pi-harness-delegate` | 作为可选 review/resume adapter；不能和 Supervisor 重复管理生命周期 |
| Claude Code Stop Hook | 作为 Worker 内部早停护栏；不能替代外部 Supervisor 或独立验收 |

### 19.2 唯一控制权

MVP 中必须保证：

- `WorkerAdapter` 唯一负责 spawn、stop、kill process group 和 transport 细节；
- Supervisor 唯一负责 watchdog、状态机、Policy Gate 和自动指令；
- Human 始终拥有最高控制权；
- Independent Verifier 唯一负责最终验收证据；
- 任何扩展不能暗中重复执行 resume、retry 或 stop。

PTY 和 headless JSONL 只能选择一个作为 MVP 的主 transport，禁止两个组件同时管理同一个 Claude 进程。

### 19.3 生产准入

候选扩展必须在进入生产依赖前完成：

- 精确版本和 commit SHA 锁定；
- LICENSE/SPDX 和传递依赖审计；
- API 和退出码验证；
- 输入竞争、无输出、崩溃、孤儿进程、恢复测试；
- 安全、权限、密钥和 prompt injection 测试；
- 可卸载和可回退验证。

“70%～85% 已完成”、候选项目星级、未经核验的发布日期和版本信息不能作为生产决策依据。

### 19.4 失败回滚

出现状态不一致、重复发送、策略解析失败、验证器不可用、扩展加载失败或权限越界时：

1. 立即停止自动发送；
2. 保留 worktree、日志和原始输出；
3. 进入 `HUMAN_REQUIRED`；
4. 人工接管或使用基础 Claude CLI Adapter；
5. 完成根因分析前关闭自动化开关。

详细独立评审记录见：`docs/independent-review.md`。

## 附录 A：当前方案中的明确决策

| 决策 | 结论 |
|---|---|
| Pi 是否作为外部 Supervisor | 是 |
| Claude Code 是否继续作为 Worker | 是 |
| 是否默认自动选择架构方案 | 否，升级人工 |
| 是否只相信 Worker 的完成声明 | 否 |
| 是否必须独立验收 | 是 |
| Reviewer 是否默认直接改代码 | 否 |
| 是否自动 merge/deploy | MVP 阶段否 |
| 是否需要统一 Adapter | 是 |
| 是否允许人工接管 | 必须支持 |
| 是否先做 Spike | 必须 |

## 附录 B：一句话版本

> 先用最小、可审计、可接管的 Supervisor 闭环证明可靠性，再逐步开放 LLM 判断和自动化权限；不要从“自动化最多”开始，而要从“边界最清楚、证据最可靠”开始。
