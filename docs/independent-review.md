# 独立子 Agent 方案评审报告

> 本评审按已确认目标更新：本地开发完全无人值守；远程 push 和 main/integration merge 必须经过独立边界。文中旧的“人工升级”表述表示候选不可发布/可挂起状态，不是要求人工在线。

> 评审对象：`requirement.txt`、`docs/engineering-plan.md`  
> 评审重点：复用现有扩展、减少重复开发、形成可整合架构并验证到生产

## 1. 评审结论

总体架构合理，但当前不能把候选扩展直接叠加到生产环境。推荐采用：

> **复用 Pi 扩展加载机制和 Claude Code runtime；选择一个 Worker transport；自建极薄 Adapter、Policy Gate、状态机、事件日志和独立验证器。**

核心原则：

- 不让多个扩展同时拥有 Claude 的 spawn、watchdog、resume、stop 控制权。
- PTY 和 headless JSONL 只选择一个作为 MVP 主传输路径。
- `pi-goals` 主要复用 Goal / Evidence / Sign-off 数据模型。
- `pi-foreground-chains` 主要复用有限循环、等待检测和 reviewer 阶段思想。
- `pi-interactive-shell` 如果通过版本、API、许可证和故障测试，应优先复用其 PTY 和人工接管实现。
- `pi-claude-code`、`pi-harness-delegate` 在完成供应链、API 和故障语义审计前，不作为核心依赖。

**结论：架构方向 GO；生命周期、故障恢复和独立验收主线已完成。产品目标是本地开发完全无人值守，因此当前自动模式保留 Claude Code 的完整环境、网络、工具、Agent/Task、插件、MCP 和嵌套 Claude 能力；只保留已知直接 remote push/main-integration 操作的策略拒绝、Git 元数据保护、cgroup 清理和独立验收。`CLAUDECODE` 仅为允许嵌套会话而移除；自定义/嵌套工具如需绝对 remote/main 隔离，必须由独立 host/repository 边界提供。详见 [autonomy-target.md](autonomy-target.md)。**

## 2. 外部参考源审查结果

| 参考源 | 建议 | 可复用内容 | 当前判断 |
|---|---|---|---|
| `pi-interactive-shell` | 优先做 Spike | PTY、实时输出、输入、人工接管、worktree 会话 | 候选主 transport，但必须验证 |
| `pi-foreground-chains` | 借鉴并局部复用 | continue loop、有限轮次、reviewer 阶段、进度记录 | 不能直接复制 regex 决策；文档主要展示 Codex Worker |
| `@mporenta/pi-claude-code` | 暂不作为核心依赖 | headless Claude 执行、watchdog、完成/异常事件 | 版本、日期、API、许可证和稳定性待核验 |
| `pi-goals-extension` / 相关 pi-goals 页面 | 复用设计思想或 schema | Goal、discriminator、evidence、sign-off | 不直接作为 Claude runtime |
| `pi-harness-delegate` | 可作为可选 adapter | Claude delegate、review、resume | 可能与本项目生命周期和审计逻辑重复 |
| Claude Code hooks | 作为 Worker 内部护栏 | Stop 前测试、阻止不完整停止 | 不能替代外部 Supervisor 和独立验收 |

### 2.1 需要特别纠正的事实

- `requirement.txt` 中的“70%～85% 已完成”没有计算方法，不能作为进度依据。
- 相关包的版本、发布日期、API 和生产能力必须以精确版本、commit、许可证和实测结果为准。
- 搜索结果显示 `pi-goals-extension` 这一名称更值得核验，不能直接假设普通 `pi-goals` 包名可安装。
- `pi-foreground-chains` 的资料重点是 Codex Worker 的自动继续流程，不应表述为 Claude 已经完成端到端验证。
- `@mporenta/pi-claude-code` 的发布时间和版本信息存在时间核验问题，在 lockfile 固定前必须重新确认。

## 3. 最小整合架构

```text
Pi Extension Loader / UI / Human Takeover
                  │
                  ▼
         pi-claude-supervisor
                  │
       ┌──────────┼──────────┐
       ▼          ▼          ▼
  Policy Gate  State Machine  Event Log
                  │
                  ▼
            Worker Adapter
                  │
        只选择一个 transport
          ┌───────┴────────┐
          ▼                ▼
       PTY Spike       Headless Spike
          │                │
          └───────┬────────┘
                  ▼
            Claude Code CLI
                  │
                  ▼
          Git Worktree / Tests
                  │
                  ▼
         Independent Verifier
```

### 3.1 唯一控制权原则

MVP 中以下职责只能由一个组件负责：

| 职责 | 唯一拥有者 |
|---|---|
| spawn | Worker Adapter |
| stop / kill process group | Worker Adapter + Policy Gate |
| watchdog | Supervisor |
| session resume | Worker Adapter，但必须由 Supervisor 授权 |
| 状态转换 | Supervisor State Machine |
| 最终完成批准 | Independent Verifier + Supervisor |
| 人工接管 | Human，系统必须立即让权 |

任何第三方扩展如果内部再次自动重试、自动 resume 或自动 stop，必须关闭这些能力，或者不能纳入 MVP。

### 3.2 Adapter 必须具备的能力

当前方案中的 `WorkerAdapter` 需要增加：

```ts
interface WorkerAdapter {
  capabilities(): Promise<WorkerCapabilities>;
  start(input: WorkerStartInput): Promise<WorkerHandle>;
  getStatus(handle: WorkerHandle): Promise<WorkerStatus>;
  readOutput(handle: WorkerHandle): Promise<WorkerOutputChunk[]>;
  send(handle: WorkerHandle, message: string, idempotencyKey: string): Promise<void>;
  pause(handle: WorkerHandle): Promise<void>;
  resume(handle: WorkerHandle): Promise<void>;
  takeover(handle: WorkerHandle): Promise<void>;
  stop(handle: WorkerHandle, reason: string): Promise<void>;
  killProcessGroup(handle: WorkerHandle, reason: string): Promise<void>;
  resumeSession(sessionId: string): Promise<WorkerHandle>;
}
```

每个事件还必须包含：

- 单调递增 `seq`；
- `taskId` 和 `workerId`；
- `idempotencyKey`；
- `timestamp`；
- 原始输出 artifact 引用；
- `exitReason`；
- `lastHeartbeat`；
- 工作目录和权限声明。

## 4. 分阶段复用策略

### Phase 0：本地源码和包审计

对每个候选项目记录：

- GitHub URL；
- npm/package 名称；
- 精确版本和 commit SHA；
- 安装命令；
- 导出的 API；
- `LICENSE` 和 SPDX；
- 传递依赖；
- 最近 release/commit；
- CI 和测试状态；
- 是否支持当前 Pi 版本；
- 是否有 Claude 真实运行样例；
- 退出码、超时、信号和恢复语义。

没有完成这些记录，不进入生产依赖。

### Phase 1：只验证 Worker transport

优先验证 `pi-interactive-shell` 的：

- spawn Claude；
- 实时读取输出；
- 输入是否丢失；
- 人工 takeover；
- SIGTERM/SIGKILL；
- 窗口尺寸和提示符变化；
- 长时间无输出；
- 孤儿进程回收；
- session resume。

如果 PTY 可靠，MVP 复用其 transport；如果 PTY 无法提供稳定、可回放的事件，则切换为 headless JSONL，不在两个 transport 之间做混合控制。

### Phase 2：自有 Supervisor 核心

以下能力建议自建，原因是它们属于本项目的控制权和审计边界：

- Goal schema；
- 状态机；
- Policy Gate；
- 预算和最大轮数；
- 重复停顿检测；
- 自动决策、重试和候选挂起；
- 事件日志；
- 证据收集；
- 独立验收；
- 回滚和 fail-closed。

这部分不应依赖某个第三方扩展的隐式行为。

### Phase 3：选择性接入 headless 扩展

只有在以下条件都满足时，才考虑接入 `pi-claude-code` 或 `pi-harness-delegate`：

- 许可证允许目标使用方式；
- 版本和 commit 已锁定；
- API 能映射到 Worker Adapter；
- 不与 Supervisor 重复管理生命周期；
- 事件和错误语义可记录；
- session resume 可回放；
- 故障注入测试通过；
- 能够随时卸载并回退到基础 Claude CLI adapter。

## 5. 生产验证路线

### 5.1 PoC 阶段

只做一条真实任务闭环：

```text
创建任务
  → 启动 Claude
  → 读取输出
  → 自动处理普通提问和决策
  → 测试 / 修复 / 重试
  → 独立验收
  → 本地提交候选
  → 独立远程/main 边界
  → 输出报告
```

必须注入：

- 普通确认；
- 架构二选一；
- 120 秒无输出；
- Worker 崩溃；
- 输入竞争；
- 重复停顿；
- 危险命令；
- 验收失败；
- Supervisor 重启。

### 5.2 MVP 阶段

MVP 必须满足：

- 单仓库、单 worktree、单 Worker；
- 本地开发动作按任务授权自动继续、修复或挂起；
- Supervisor 管理的直接 remote push 或 main/integration merge 请求必须拒绝，并由独立边界保护自定义/嵌套能力；
- 事件可以完整回放；
- 人工 takeover 后零自动发送；
- 验收失败绝不进入 `COMPLETE`；
- 重复停顿不会无限循环；
- 进程组不会泄漏；
- 日志不会泄露密钥；
- Worker 输出不能改变 Supervisor 安全规则。

### 5.3 生产候选阶段

生产候选的后续加固项包括：

- 依赖 lockfile 和 SBOM；
- 包来源校验；
- 手动/自定义集成的最小权限和 host-level sandbox；
- 手动/自定义集成的网络和 host 权限边界；自动 Claude 路径保留完整网络、工具和 MCP 能力；
- 更广泛的密钥隔离；
- 日志脱敏；
- 成本和时间告警；
- 灰度 feature flag；
- 可随时关闭自动化；
- 故障回滚、候选挂起和可选通知。

其中手动/自定义集成的 host-level 低权限和网络边界不阻塞当前生命周期验证；自动模式
允许 Agent/Task、插件、MCP 和嵌套 Claude，cgroup 只负责后代清理，已知直接
remote push/main merge 仍由策略和独立边界控制。嵌套/自定义工具若需要绝对隔离，必须
由 host/repository 边界提供。

### 5.4 建议 Go / No-Go 门槛

必须全部满足才允许生产灰度：

- P0 安全用例 100% 通过；
- 无孤儿 Worker 进程；
- 无密钥泄露；
- 人工 takeover 可重复成功；
- 所有失败场景 fail-closed；
- 关键事件可完整回放；
- 验收流水线可独立重跑；
- 依赖许可证和版本已审计；
- 通过一组固定任务的成功率、恢复率和费用门槛。

未满足生命周期、恢复、审计和独立验收门槛时只能称为 PoC 或生产候选；
候选不得进入远程或 main/integration 分支。安全加固项的完成度应单独标注，不能以本地无人值守目标替代安全证据。

## 6. 回滚方案

任何以下情况发生时，立即停止自动发送并进入 `blocked`/`candidate_failed` 或恢复检查状态：

- 状态不一致；
- 重复发送指令；
- Policy Gate 解析失败；
- 验证器不可用；
- Worker 输出协议变化；
- 第三方扩展加载失败；
- 发现权限越界或密钥风险；
- watchdog 与 Worker 状态矛盾。

上述情况应保留现场并可选发送通知，但不得把人工在线作为恢复前提，也不得因此放行远程 push 或 main/integration merge。

回滚动作：

1. 停止自动控制；
2. 保留 worktree、事件日志和原始输出；
3. 终止或交还 Worker 控制权；
4. 将任务挂起并保留候选证据；
5. 使用锁定的旧 Adapter 或直接使用 Claude CLI；
6. 生成故障报告；
7. 未完成根因分析前，不重新打开自动化开关；需要人工接管时作为可选后续操作。

第三方包升级必须通过 lockfile、独立 worktree、回放测试和 feature flag 灰度，不能直接替换生产版本。

## 7. 对现有 engineering-plan.md 的修改建议

现有方案已经具备较好的边界，但建议补充：

1. 参考源审计表和许可证门禁；
2. PTY/headless transport 的明确主备选择；
3. 唯一控制权和职责归属；
4. Adapter capability negotiation、幂等、事件序号、进程组终止和 artifact 引用；
5. 供应链和 SBOM 要求；
6. prompt injection、symlink 越界、shell escape 和外部文档注入威胁模型；
7. 输入竞争、孤儿进程、重复事件和恢复测试；
8. 量化的 Go/No-Go 指标；
9. 扩展加载失败时的回退路径；
10. 明确 Stop hook 只是 Worker 内部早停护栏，不是独立验收器。

## 8. 最终技术决策建议

### 推荐直接复用

- Pi 的 extension/package loader 和人工交互机制；
- Claude Code CLI runtime；
- 通过 Spike 验证后的 `pi-interactive-shell` PTY 层；
- Git worktree、OS 进程组控制和项目已有测试命令。

### 推荐只借鉴

- `pi-goals` 的 Goal / Evidence / Sign-off 数据模型；
- `pi-foreground-chains` 的有限循环和 reviewer 阶段；
- Claude Stop hook 的 Worker 内部护栏思路。

### 暂不作为核心依赖

- 未审计的 `pi-claude-code`；
- 未审计的 `pi-harness-delegate`；
- 同时拥有 spawn、watchdog、resume、stop 权限的多个扩展；
- Reviewer 直接修改工作树；
- 自动 merge、deploy、release。

## 9. 给 W 的一句话结论

> 不要从零重写 Claude 控制层，也不要把多个扩展直接叠加。先验证并复用一个可靠的 Worker transport，再自建最薄的 Adapter、策略、状态机和独立验收层；所有候选包经过版本、许可证、API、故障和安全验证后，才允许进入生产灰度。
