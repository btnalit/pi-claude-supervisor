# Pi Claude Supervisor 完整方案

> 文档状态：`v0.5.2` 已发布；Phase A–D 加固、真实 repair/reacceptance、exact-head 独立只读 Review 和受保护发布已完成。当前确认的产品目标是本地开发完全无人值守；代码进入远程仓库或 main/integration 分支必须经过独立边界。详见 [autonomy-target.md](autonomy-target.md)。
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

- **Pi Supervisor**：负责任务约束、生命周期控制、自动决策、证据收集和最终验收。
- **Claude Code Worker**：负责根据任务执行代码修改、运行测试、修复问题和本地提交。
- **Human / independent boundary**：不作为本地开发循环的同步依赖；负责或授权远程 push、main/integration merge，以及事后审查、关闭或拒绝候选。
- **Independent Verifier**：在 Worker 声称完成后，以只读方式重新检查代码和验证结果。

最终目标是让 Claude Code 能够在较长任务中持续工作，同时避免以下问题：

1. Worker 因提问或短暂停顿导致任务中断。
2. Worker 在架构选择上偏离既定约束。
3. Worker 声称完成，但没有实际完成目标。
4. Supervisor 因误判导致无限循环、危险操作或不可审计的修改。
5. 人工无法随时接管或恢复任务。

**当前状态：`v0.5.3` 已正式发布，已完成以 Claude Code `2.1.270` 为兼容下限的稳定性验证、单 Worker recovery、真实只读 Review drill、隔离临时 worktree 的允许编辑 repair/reacceptance drill、exact-head 独立 Review 和受保护发布。当前工作树已落实 repairable/persistent 能力拆分、verifying stop、paused watchdog、baseline-relative repository evidence、可取消验收/Reviewer、启动 preflight、无人值守权限决策、local-commit enforcement、候选挂起和阶段进度通知。自动模式现在要求 direct Claude JSONL 或 Supervisor 自有 tmux bridge、完整 Git baseline、非保护分支和受信任的 Claude 可执行文件；它保留 Claude Code 的完整环境、网络、工具、Agent/Task、插件、MCP 和嵌套 Claude 能力，`CLAUDECODE` 仅为允许嵌套会话而移除。已知直接 remote push/main-integration 操作仍由策略拒绝，cgroup 负责所有后代清理；自定义/嵌套能力的绝对 remote/main 隔离仍由独立边界提供。Legacy human/takeover APIs 仅保留显式兼容控制；普通不确定性不再阻塞本地循环。协同多 Worker 仍是独立后续里程碑。**

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

> 在保留最终远程 push/main merge 独立边界的前提下，让外部 Supervisor 无人值守地运行本地 Claude Code 开发循环，并使用可靠证据判断任务是否真的完成。

### 2.3 需求边界

第一阶段明确只支持：

- 单仓库；
- 每个任务一个 Claude Worker；
- 每个并行任务使用独立 worktree/工作目录；
- Pi 负责监督、自动决策和验收；
- 本地开发循环不依赖人工实时接管；
- Worker 不拥有远程 push 或 main/integration merge 权限，进入远程和主分支必须经过独立边界。

当前扩展已支持多个独立任务会话并行推进，但不允许活动会话共享同一
工作目录。事件日志由跨进程锁协调，状态和 watchdog 按会话隔离。这里要区分两种
“多 Worker”：**独立会话并行**已经属于当前能力；**有依赖、交接和汇总验收的协同多
Worker**属于后续开发任务，不能通过简单地放宽 cwd 限制来实现。

暂不支持：

- 多 Worker 在同一 worktree 的无协调协作；
- 自动生产发布；
- 用 Worker 自己的报告代替独立验收；
- 把远程 push 或 main/integration merge 授权给 Worker。

本地开发中的决策、命令、修复和提交由任务授权策略控制，不额外添加同步人工审批门。无法形成可交付候选时自动重试、失败或挂起并保留证据，不能因此进入远程或主分支。

---

## 3. 设计原则

### 3.1 Worker 和 Supervisor 职责分离

Claude 负责执行，Pi 负责控制和判断。不能让 Worker 自己同时担任执行者、验收者和最终批准者。

### 3.2 确定性策略优先于 LLM 判断

LLM 可以帮助理解上下文，但不能绕过远程/main 权限边界和证据要求。确定性策略负责能力边界、任务授权和进程安全；它不应把普通本地开发动作自动升级为同步人工审批。

```text
事件
  │
  ▼
任务授权 / 确定性能力边界
  │
  ├── 远程 push / main merge：无 Worker 权限，交给独立边界
  ├── 本地开发动作：按任务授权自动允许、重试或记录
  └── 无法形成候选：自动失败/挂起，保留证据，不要求人工在线
```

### 3.3 证据优先于声明

Worker 说“完成了”不是完成证据。最终状态必须由以下信息支持：

- 当前任务目标；
- 任务清单；
- 实际 git diff；
- 测试、lint、typecheck、build 结果；
- 约束检查结果；
- 独立 Reviewer 报告。

### 3.4 本地开发无人值守，远程边界独立

本地开发循环不是人工实时审批流程。Worker 可以在任务授权范围内修改、测试、修复和本地提交；Decision Worker 负责普通决策并记录假设、证据和结果。

人工或独立边界保留以下权力：

- 关闭或停止任务；
- 审查候选和证据；
- 授权或执行远程 push；
- 授权或执行 main/integration merge；
- 拒绝或丢弃候选。

这些权力不能被本地 Worker 或模型响应绕过，但不要求人工持续在线观察开发过程。

### 3.5 以证据约束自动化，而不是以人工门限制自动化

自动化应覆盖本地编辑、命令、测试、修复、验收、Review 和本地提交。时间、轮数、输出、清理和证据完整性是可靠性约束；它们不自动变成同步人工审批。无法完成的任务自动失败或挂起，只有通过独立验收的候选才可进入远程/main 边界。

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
  ├── ANSWER / ASSUME ───> RUNNING
  ├── REDIRECT ──────────> RUNNING
  └── PARK ───────────────> BLOCKED / REVIEW_PENDING

RUNNING ── Worker 报告完成 ──> VERIFYING
VERIFYING ── 通过 ──> COMPLETE (local candidate)
VERIFYING ── 失败 ──> REJECTED / CANDIDATE_FAILED
REJECTED ── 修复 ──> RUNNING
BLOCKED / REVIEW_PENDING ── 恢复条件满足 ──> RUNNING
```

### 5.2 状态说明

| 状态 | 含义 | 自动动作 |
|---|---|---|
| `CREATED` | 任务已创建但尚未执行 | 校验任务配置 |
| `STARTING` | 正在启动 Worker | 等待启动事件 |
| `RUNNING` | Worker 正在工作 | 采集输出和指标 |
| `WAITING` | Worker 正常等待输入 | 判断是否可自动处理 |
| `BLOCKED` | Worker 被异常、环境或依赖阻塞 | 记录原因并自动挂起，不要求人工在线 |
| `DECISION_REQUIRED` | 需要基于任务证据作本地决策 | Decision Worker 自动选择并记录假设；无法选择则挂起 |
| `HUMAN_REQUIRED` | 兼容旧协议或显式 takeover 控制态 | 不自动放行；不是普通本地开发的同步依赖 |
| `VERIFYING` | 执行独立验收 | 只执行验证流程 |
| `REJECTED` | 验收失败，需要修复 | 生成有限修复任务或候选失败 |
| `COMPLETE` | 所有目标和验收证据满足 | 生成本地候选，不能自行 push/merge |
| `FAILED` | 系统或 Worker 不可恢复失败 | 保留现场并报告 |
| `STOPPED` | 用户或策略主动停止 | 不再自动恢复 |

### 5.3 状态转换要求

每次转换必须记录：

```json
{
  "event": "STATE_CHANGED",
  "from": "WAITING",
  "to": "DECISION_REQUIRED",
  "reason": "Worker 提出架构选择；Decision Worker 将按任务证据选择或挂起",
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

自动决策应覆盖任务授权范围内的本地开发动作，包括继续、回答、重定向、测试、修复和本地提交。Decision Worker 必须结合任务规格、仓库证据、当前 diff 和预算做决定，并记录选择和假设。

以下情况不应要求人工实时在线，而应进入自动处理路径：

- 架构方案二选一：按任务约束选择并记录假设；
- 需求存在歧义：采用可回溯假设，或将候选挂起；
- 测试失败：在 repair budget 内继续修复；
- 外部服务、权限或凭据：按任务授权策略处理，无法处理则自动失败/挂起；
- Supervisor 置信度不足：有限重试后形成 `blocked`/`review_pending` 候选，不得 push/merge；
- Worker 连续失败或重复提问：停止该自动循环并保留证据，不要求人工立即接管。

唯一不可由本地 Worker 决定的权限边界是远程 push 和 main/integration merge。其他限制必须来自明确的任务授权或运行时能力配置，而不是默认增加同步人工审批。

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
5. 没有未解决的阻塞性证据或任务授权冲突；本地决策和假设已经记录；
6. 独立 Reviewer 没有未解决的阻塞项；
7. 未超出时间、轮数和费用预算；候选尚未越过远程 push/main merge 独立边界。

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
- 实现可选人工接管和明确的远程/main 独立边界；
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
- 本地开发动作按任务授权自动 continue、修复或挂起；
- 远程 push/main merge 不授予 Worker，交给独立边界；
- 最大执行时间和最大轮数；
- 基础 Goal / Evidence / Sign-off；
- 基础验证命令。

暂不做：

- 无任务证据约束的自由 LLM 决策；
- 无预算的自动修复；
- 多 Worker；
- Worker 远程 push 或 main/integration merge；这些动作必须经过独立边界。

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
- 故障恢复、候选挂起和可选通知。

本阶段不阻塞当前 Supervisor 功能、Worker 生命周期、进程组清理、resume
和独立验收工作。自动 Claude Worker 可在完整继承的环境、网络、工具、Agent/Task、
插件、MCP 和嵌套会话能力下本地修改、测试、修复和提交；已知直接 remote push 或
main/integration merge 请求仍由策略拒绝，但嵌套/自定义能力的绝对边界必须由独立
host/repository 机制提供。

---

## 10. Spike 测试矩阵

| 场景 | 预期行为 | 通过标准 |
|---|---|---|
| 正常完成 | Worker 完成任务并退出 | Supervisor 收集 diff 和测试证据 |
| 普通确认 | Worker 询问是否继续已批准步骤 | 自动发送一次 continue |
| 架构决策 | Worker 提出两种实现方案 | 按任务约束选择并记录假设；无法选择则挂起候选 |
| 长时间无输出 | Worker 无输出但进程仍在 | 触发 watchdog，先检查再决定 |
| Worker 崩溃 | 进程异常退出 | 记录退出原因，可恢复或升级 |
| 测试失败 | Worker 声称完成但测试失败 | 进入 REJECTED 或修复轮次 |
| 重复提问 | Worker 多轮重复等待 | 有限重试后挂起候选，禁止无限 continue |
| 危险命令 | 删除、发布、使用密钥等 | 被 Policy Gate 拦截 |
| 人工接管 | 用户显式接管终端 | Supervisor 停止自动发送指令；这是控制路径而非日常依赖 |
| session 恢复 | Supervisor 重启 | 根据持久化状态恢复或安全暂停 |

---

## 11. 安全设计

### 11.1 权限控制

权限不是“一律拒绝”，而是分层处理：

- Claude Code 自身负责工具级权限请求和用户交互；
- Supervisor 对 Worker 启动命令做确定性分类；
- 明确超出任务授权或绕过权限的参数按策略拒绝或挂起；
- `review` 命令按任务授权策略自动处理并写入事件日志，不能绕过远程/main 独立边界；
- 普通联网命令默认不因“联网”本身拒绝，下载后直接交给 shell 的模式按配置处理，无法安全处理则挂起候选；
- 无交互 UI 时不能伪造批准，也不能把缺少批准转换为远程/main 权限。

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
- 明确超出任务授权的命令、权限绕过参数和生产发布动作仍由 Policy Gate/独立流程控制；
- Worker 不得远程 push 或 merge 到 main/integration 分支。

### 11.2 本地能力与远程边界

本地开发动作按任务规格和运行时授权策略自动处理，不把下列动作默认改成同步人工确认：

- 文件修改、删除、重构、数据库迁移和测试；
- 本地分支操作、提交、回滚和修复；
- 任务授权范围内的外部请求、凭据使用和 CI/配置修改。

Worker 的硬权限边界是：

- 不得远程 `push`，尤其不得强制 push；
- 不得 merge 到 `main` 或其他 integration 分支；
- 不得绕过独立 Review、CI 或其他配置的独立边界。

本地策略仍可按任务需要配置更窄的权限；这属于任务授权，不是本项目额外规定的同步人工门。发布和生产流程继续由其已有的独立受保护工作流处理。

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
- 超过最大轮数自动生成 `blocked`/`candidate_failed` 候选并保留证据，不得 push/merge；
- Supervisor 自身异常时自动暂停或挂起 Worker，而不是继续放行；
- Worker 重启必须保存原始现场；
- 任务恢复时先进入可验证的恢复/Review 状态，不能盲目继续，也不要求人工在线；
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
| LLM 错误判断 | P1 | 任务授权、证据门、有限重试、候选挂起和独立 Review |
| 无限 continue 循环 | P1 | 最大轮数、重复检测、冷却时间 |
| Worker 输出 prompt injection | P1 | 输出不可信化、工具调用前策略拦截 |
| Reviewer 不够独立 | P1 | 独立上下文、只读验收、证据重新采集 |
| 误操作生产环境 | P0 | 任务授权、独立验收、已知直接 remote/main 策略门；完整能力的 host/repository 独立边界作为后续加固 |
| Worker 崩溃后状态丢失 | P2 | Decision Worker session/task mapping 持久化，异常重启后显式 recovery；Claude Worker 本身不静默 resume |
| 多会话互相覆盖 | P1 | 独立 cwd/worktree 检测、共享事件锁、会话级 watchdog |
| Decision Worker/API 不可用 | P1 | 记录事件，按有限重试和候选挂起策略处理；通知是可选投递，不是同步控制依赖 |
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

- [ ] 超出任务授权的命令会被拦截或挂起，不要求人工在线。
- [ ] 人工接管后不再自动发送指令。
- [ ] 有最大时间、轮数和重试限制。
- [ ] 日志不会泄露密钥和 token。
- [ ] Decision Worker API 失败会按有限重试/候选挂起处理；通知是可选的。
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

## 17. 已确认的产品边界与待实现项

以下边界已经确认，不再作为本地开发是否允许无人值守的待决问题：

1. 本地编辑、命令、测试、修复和本地提交可以完全无人值守；
2. Decision Worker 可以在任务授权和仓库证据范围内选择实现方案，并记录假设和理由；
3. 无法形成可靠候选时自动重试、失败或挂起，不能要求人工必须在线；
4. Worker 不拥有远程 push 或 main/integration merge 权限；代码进入远程和主分支必须经过独立边界；
5. 验收、独立 Reviewer、有限修复和证据完整性仍是候选完成条件；
6. stop、cleanup、kill、恢复和审计是系统控制能力，不等同于逐动作人工审批。

仍可由任务或集成方配置的工程参数包括 transport、CLI 版本、任务预算、验收命令、
运行时能力和是否发送通知；这些参数不能削弱远程/main 独立边界，也不能把旧的
同步 human gate 重新作为默认本地开发控制流。

---

## 18. 给 W 的最终结论

> 这个方向已经完成生命周期、恢复、验收、独立 Review 和本地无人值守闭环。实现路径是“自动决策—本地编辑/测试/修复/提交—证据验收—候选挂起或交付”；远程 push 和 main/integration merge 仍由独立边界控制。
>
> 采用“确定性能力边界 + LLM 辅助判断 + 可复现验收 + 独立远程/main 边界”，而不是让 LLM 获得远程写权限。`pi-goals` 的 Goal / Evidence / Sign-off 思想继续适用，PTY、watchdog 和 delegate 能力必须通过统一 Worker Adapter 组合。
>
> 最终判断：**本地开发完全自动化；远程仓库和 main/integration 分支保持独立边界。**

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
- Human/独立边界控制远程 push、main/integration merge 和显式停止；本地 Worker 不拥有这些权限；
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
3. 进入 `BLOCKED`/`CANDIDATE_FAILED` 并保留现场；
4. 可选人工接管或使用基础 Claude CLI Adapter；
5. 完成根因分析前关闭自动化开关。

详细独立评审记录见：`docs/independent-review.md`。

## 附录 A：当前方案中的明确决策

| 决策 | 结论 |
|---|---|
| Pi 是否作为外部 Supervisor | 是 |
| Claude Code 是否继续作为 Worker | 是 |
| 是否默认自动选择架构方案 | 是，在任务授权和证据范围内选择并记录假设；无法选择则挂起 |
| 是否只相信 Worker 的完成声明 | 否 |
| 是否必须独立验收 | 是 |
| Reviewer 是否默认直接改代码 | 否 |
| Worker 是否拥有远程 push/main merge | 否，必须经过独立边界 |
| 是否需要统一 Adapter | 是 |
| 是否允许人工接管 | 必须支持 |
| 是否先做 Spike | 必须 |

## 附录 B：一句话版本

> 先用最小、可审计、可接管的 Supervisor 闭环证明可靠性，再逐步开放 LLM 判断和自动化权限；不要从“自动化最多”开始，而要从“边界最清楚、证据最可靠”开始。

## 20. 近期落地与剩余门禁：稳定的自动验收闭环

本轮已落地 TaskSpec 多命令验收和 autonomy 字段、独立只读 Reviewer、结构化 repair round、重复 finding/P0/P1 候选挂起、JSONL 去重、baseline-relative commit evidence 和确定性 replay fixture。剩余门禁是兼容下限以上 CLI 的重复运行统计，而不是继续扩大本地同步安全边界。Claude Code 以 `2.1.270` 为最低兼容版本；真实 Spike 默认从 `PATH` 解析当前安装（包括 `latest` 路径），接受该版本及更新版本，并记录实际版本和路径。自动模式不再注入 fail-closed sandbox、无出站域名、凭据过滤或 Claude 工具 allowlist；正常 Agent/Task、插件、MCP、网络和嵌套 Claude 均保持可用。OS 级低权限、host-level sandbox、手动/自定义集成的 network allowlist、SBOM 和更深的供应链加固后置，不作为本阶段门禁；已知 remote push/main merge、保护 CI 和发布仍保持独立边界。

### 20.1 Goal / Evidence / Sign-off 模型

任务规格统一为：

```yaml
 goal: 实现用户邀请接口
 scope:
   - 新增接口
   - 添加权限校验
 constraints:
   - 不修改核心数据库模型
 forbidden:
   - 不执行生产部署
 acceptance:
   - id: tests
     command: npm
     args: [test]
   - id: typecheck
     command: npm
     args: [run, typecheck]
   - id: diff-check
     command: git
     args: [diff, --check]
 maxRepairRounds: 3
```

兼容旧任务时，普通任务文本作为 `goal`，默认验收仍为 `git diff --check`。所有验收命令使用 argv 和确定性 Policy Gate，不经过 shell。

验收流程固定为：

```text
Worker result
  → 多命令 acceptance checks
  → 独立只读 Reviewer
      ├── pass   → local candidate
      ├── revise → 结构化修复指令 → Worker → 重新验收
      └── human/invalid → parked candidate
```

Reviewer 必须使用独立 Pi session，只允许 `read`、`grep`、`find`、`ls`，输出结构化 verdict 和 findings；不能修改工作树或直接批准权限。默认最多三轮修复；相同 finding 重复出现或出现 P0/P1 问题时挂起不可发布候选，不要求人工在线。

### 20.2 JSONL 稳定性证据

以 Claude Code `2.1.270` 为最低兼容版本建立以下证据；真实 Spike 可使用 `PATH` 中当前的更高版本：

- JSONL 跨 chunk 拆分、单 chunk 多记录和 malformed 行；malformed 行不能触发完成事件；
- 重复 result、重复 permission request、重复 Supervisor idempotency key 不产生重复动作；
- active request 期间的 SIGTERM、SIGINT、stop 和 Pi shutdown；
- 普通完成、低风险 Bash allow、`AskUserQuestion` deny-to-text、多轮、验收失败修复和恢复回放。

真实 Claude Spike 不进入普通 CI；确定性 fake Worker/replay fixture 进入 CI。当前自动模式仍需显式启用是实现状态，不是本地开发目标的额外人工门；后续应补齐任务级自治配置和正常完成、修复、歧义、候选挂起的回放/真实 Claude 演练。门禁仍要求无重复动作、无错误 complete、无未清理 Worker，且关键事件可以完整回放。

### 20.3 明确不属于本阶段

- OS sandbox、低权限执行和网络隔离；
- Worker 获得远程 push 或 main/integration merge 权限；
- 多 Worker 在同一工作树协作。

本地开发自动化不属于可选的后续限制，而是已确认的目标；本节列出的技术项目不能被用来要求人工在线。

## 21. 后续开发路线图

`v0.5.2` 的发布不代表所有自动化目标都已完成。后续任务按“自治决策与候选挂起 → 稳定性/恢复 → 协同
调度 → 安全加固”推进；多 Worker 可以纳入开发任务，但应作为独立阶段，不能与当前
单 Worker 稳定性门禁混在一起。

### 21.1 短期：稳定性收尾

- 使用 PATH 中当前的 Claude Code（不得低于 `2.1.270`）完成重复 Spike：普通任务连续 10 次，权限和问题回退各至少 5 次，并记录实际版本/路径；
- 补齐 replay：多轮修复、验收失败修复、repair budget 耗尽、takeover、recover 和 Pi shutdown；
- 补齐边界测试：Reviewer 流式输出上限、`DecisionSessionStore.list()` 任务 ID 校验、跨进程恢复和超时/输出截断；
- 继续观察 npm `0.5.2`、GitHub Release 资产、provenance 和回滚路径；
- 验收标准：无重复动作、错误 complete、未清理 Worker 或未审计的自动放行。

### 21.2 中期：恢复能力

- 设计安全的 Claude session resume；明确 `--resume` 与实时 PTY attach 的边界；
- 完善 takeover、recover、Pi shutdown、Worker 崩溃和部分完成的状态语义；
- 增加跨进程恢复端到端测试，包括 cwd lease、Decision Worker session、Worker 身份和事件日志一致性；
- 恢复失败必须进入 `BLOCKED`/`CANDIDATE_FAILED`，不能静默重放原始任务或重复发送输入；后续人工接管是可选恢复路径。

### 21.3 后续：多 Worker 协作与调度

第一阶段只做**独立 worktree 的多 Worker 编排**，不允许共享工作树写入。建议拆成以下
开发任务：

1. **任务图与角色模型**：增加 `parentTaskId`、Worker role、`dependsOn`、worktree、handoff
   artifact 和子任务状态；明确 root task 与 child task 的审计关联。
2. **受限调度器**：实现并发上限、依赖就绪、全局时间/修复预算、取消传播和失败隔离；
   不让任意 Worker 自行启动、停止或批准另一个 Worker。
3. **结构化交接**：Worker 之间只通过受限 artifact、事件引用和验收报告交接，不直接共享
   控制通道；交接内容必须经过 schema 校验和大小限制。
4. **汇总验收**：每个 child 先独立验收，root task 再汇总目标、diff、测试和 Reviewer 结果；
   冲突、缺失证据或任一 P0/P1 自动阻止候选并挂起，不要求人工在线。
5. **恢复与关闭**：支持单个 child、整棵任务图和 Pi shutdown 的一致性恢复；父任务不能在
   子任务状态未知时报告 `completed`。
6. **冲突检测和独立整合**：只允许在独立 integration worktree 中进行整合；Worker 不
   得 push 或 merge，冲突和整合动作必须经过独立远程/main 边界。

多 Worker 阶段的最小验收矩阵：两个独立 Worker 并行、依赖顺序、一个 Worker 失败、取消
传播、重复交接、工作树冲突、单 child 恢复、整棵任务图恢复和 shutdown 中断。通过这些
门禁后，才评估是否需要更复杂的 lead-worker 或动态任务分解。

### 21.4 后置：安全加固

- Claude CLI 破坏性变更检测和跨版本兼容矩阵（当前最低兼容版本为 `2.1.270`）；
- OS sandbox、低权限执行、网络隔离/allowlist；
- 更深的供应链、SBOM、密钥隔离和生产监控。

## 22. v0.5.2 发布后的自动化自治计划

`v0.5.1` 发布后的真实 Claude Code `2.1.270` 演练完成了
Worker → 验收 → 独立 Reviewer → fail-closed 候选挂起链路。验收六项全部通过，
但发现两个 P1 和两个 P2 生命周期/证据问题。正式记录、复现结果、实施阶段和门禁
见 [`docs/automation-hardening-plan.md`](automation-hardening-plan.md)。

已完成的加固和下一轮自治实现顺序为：

1. **生命周期与能力模型**：拆分 `persistentSession` 与 `repairableSession`，修复非持久
   JSONL repair 的非法终态转换，并支持 `verifying` 状态的 stop/shutdown；
2. **watchdog 与证据完整性**：暂停 no-output 时钟，记录 task baseline，补齐
   baseline-relative committed/staged/unstaged diff、commit summaries 和安全的 untracked evidence；
3. **自动化协议**：按 assistant message 边界解析 Reviewer/Decision Worker 输出，增加
   启动 preflight、可观测 heartbeat、permission gate 一致性和 signal 生命周期；
4. **验证门禁**：已补齐真实 capability 矩阵、隔离 worktree 的真实
   repair/reacceptance 演练、exact-head 独立 Reviewer 和受保护发布；本地候选仍不得绕过远程/main 独立边界。

本轮不增加本地同步人工门：Reviewer 仍只读，验收仍使用 argv/`execFile`，不伪造 Claude
`--resume`；Supervisor 管理的已知 remote push 或 main/integration merge 仍拒绝，P0/P1、
重复 finding、超时、API 错误和不完整证据继续 fail-closed 并生成不可发布候选。自动
Claude 的 Agent/Task、插件、MCP、网络和嵌套 Claude 能力保持开放，cgroup 只负责后代
清理；多 Worker 协作继续后置。
