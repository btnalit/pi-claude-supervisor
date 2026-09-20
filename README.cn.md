# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · 简体中文

## 这是什么

pi-claude-supervisor 是一个标准的 [Pi](https://pi.dev) agent 扩展包，用于监督
Claude Code 完成无人值守的本地开发。Pi 负责任务的生命周期、状态机、策略决策、
验收检查和独立 Review；Claude Code 是负责实际编辑的 Worker。这个扩展只需要一次
`pi install`：Pi 会自行发现并加载它，没有单独的构建步骤或二进制文件,在 Pi 内部
除了环境变量之外也没有任何需要配置的地方。

有一条 Worker 永远不能越过的硬边界，无论它自己的权限设置如何：它不能 push 到
远程仓库、合并进 `main` 或 integration 分支、创建 pull request，也不能执行任何
远程 CLI 变更；`.git` 元数据写入和对受保护分支的破坏性改写一律拒绝。除此之外的
一切——编辑、测试、shell 命令、本地提交——都按你配置的策略执行。扩展本身在运行时
从不执行 merge、deploy、release 或 publish。

任务启动后,这个循环是这样运作的:

- Worker 执行一轮;一轮结束时(`turn_completed`),Pi 的 Decision Worker——一个
  持久化、只有只读工具的 Pi session——会选择继续、重定向、回答问题、验收、停止
  或挂起任务。
- `verify` 运行验收检查(默认是 `git diff --check`,或者来自 `--spec` 文件的检查)。
- 一个独立的 Reviewer——全新的只读 Pi session——返回通过、需要修改或需要人工介入。
- 需要修改时会给 Worker 发送一轮有限的修复(最多 `maxRepairRounds` 轮);通过后
  产出一个 `completed` 候选。
- 无法解决的工作会被挂起为 `blocked`(不可发布的候选,而不是崩溃);崩溃和超时
  则变为 `failed`。
- 每个终态都会发出候选通知,既在 Pi UI 中显示,也可以选择发到 webhook(企业微信
  或通用 JSON 格式,失败会重试)。

## 快速开始

需要 Pi 0.85+、Node.js 22.19+、Claude Code 2.1.270+(交互式 hooks 已在 2.1.273
上验证),cgroup 和 tmux 相关功能需要 Linux。

像安装任何其他 Pi 扩展一样安装它:

```text
pi install npm:pi-claude-supervisor
```

这就是全部安装步骤——Pi 会直接加载包中的 `./src/index.ts` 扩展并注册
`/supervise` 命令。配置只通过环境变量完成,在启动 Pi 之前设置(或写入
`~/.config/pi-claude-supervisor/env`):

```bash
export PI_CLAUDE_SUPERVISOR_MODE=auto
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
# 可选:候选/失败通知
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL='https://example.invalid/webhook'
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT=generic
```

然后在任意 Pi session 中:

```text
/supervise start implement the requested change
/supervise adopt-tmux my-tmux-session implement the requested change
```

用 `/supervise status <task-id>` 或 `/supervise sessions` 观察任务;对于 tmux
transport,可以直接用两者打印出的 `tmux -S <socket> attach -t <session>` 命令
attach。`/supervise stop <task-id>` 会关闭任务;在交互式 tmux transport 下,
完成的任务默认会保持会话开启(见下文)。

## 模式与 transport

`PI_CLAUDE_SUPERVISOR_MODE=auto`(或 `PI_CLAUDE_SUPERVISOR_AUTOMATION=1`)启用
自动监督——也就是上面的 Decision Worker/Reviewer 循环。不设置时,`/supervise`
仍然暴露所有命令,但 Worker 运行时没有这个循环。

| Transport | `TRANSPORT` | `TMUX_MODE` | Worker 以什么形式运行 | 适用场景 |
| --- | --- | --- | --- | --- |
| 交互式 tmux | `tmux` | `interactive`(默认) | 在 tmux pane 中运行真实、未经修改的 Claude Code TUI,由 Claude Code hooks 驱动 | 想要观察或偶尔亲自输入 Claude 正在使用的那个会话 |
| Headless JSONL | `jsonl`(自动模式下默认) | – | `claude -p --input-format stream-json`,没有终端界面 | 每一个与权限相关的命令都必须对 Supervisor 可见 |
| tmux bridge | `tmux` | `bridge` | Claude 的 stream-json 协议,渲染进 tmux pane | 需要一个可见的 pane,但使用较早的结构化(非 hook)transport |
| 手动(process-pipe) | `process-pipe`(`MODE` 未设置时默认) | – | Worker 的 stdin/stdout 作为纯文本 | 只暴露命令,不启用自动监督 |

## 交互式 tmux 模式(hooks)

`PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux` 默认在 tmux pane 中运行真实、未经修改的
Claude Code TUI——就是你自己运行 `claude` 时看到的那个界面——而不是下文描述的
结构化 stream-json bridge。你可以随时 attach 到打印出的 `attach=...` 命令上观察,
或者亲自输入;Pi 通过 Claude Code 自身的 hooks 上报事件,而不是抓取屏幕文字。

当扩展以交互模式(默认 `TMUX_MODE`)加载
`PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux` 时,会自动把它用到的八个 Claude Code hook
事件的小型 relay 命令安装进 `~/.claude/settings.json`(或
`$CLAUDE_CONFIG_DIR/settings.json`)——这个安装是幂等的,并且只会在 Pi UI 中
提示一次。设置 `PI_CLAUDE_SUPERVISOR_AUTO_INSTALL_HOOKS=0` 可以关闭自动安装;
`/supervise uninstall-hooks` 会移除这一条目,`/supervise install-hooks` 仍然
可以用来手动安装。在没有 Supervisor 监听的 Claude session 中,relay 本身只是
一个耗时约 1 毫秒的空操作。owned 的 `/supervise start` 完全不依赖这个机制——
它会传入自己的 `--settings` 文件——但 `/supervise adopt-tmux` 运行在你自己的
Claude Code 配置中,需要那里已经装好 relay。

```text
/supervise start <task>
/supervise adopt-tmux <tmux-session> <task>
```

Pi 会在 Claude 结束一轮对话时(`Stop`;轮中 API/模型失败会以 `StopFailure` 到达
并按"出错的一轮"交给 Decision Worker 重试;提示符空闲一分钟且没有结束信号时作为
兜底把这一轮收尾)、Claude 即将向你展示真实权限提示时(仅此时——其余每一次普通
工具调用都交给你自己的 Claude Code 权限模式处理)、Claude 询问 `AskUserQuestion`
时(Decision Worker 会选择一个答案,Claude 以普通文本形式继续,与 headless 模式
中完全一致),以及 session 退出时介入。在展示提示之前的 `PreToolUse` 否决点只会
拒绝已知的直接远程 push/merge/PR 或其他破坏性/受保护分支操作(或转发一个
`AskUserQuestion`);它从不干预普通的编辑、读取或本地命令——那些请求会直接进入
你自己的权限模式,Pi 完全不做决策。

**这对安全边界意味着什么。** 交互式模式有意跳过 headless 模式那条"拒绝设置中
预授权 `Bash` 或 `auto`/`bypassPermissions` 模式"的检查:你自己的 Claude 配置
决定 Claude 无需询问就能做什么,和你亲自运行 Claude 时完全一样。凡是你的设置
已经放行的操作都不会到达 Decision Worker;它只在 Claude 本来要问*你*的地方做
判断。硬边界(远程 push/merge/PR、远端 CLI 变更、`.git` 写入、受保护分支的
破坏性改写)由 `PreToolUse` 强制执行,与权限模式无关——已在 Claude Code 2.1.273
的 `auto` 模式下实测——这也是该模式在你自己的设置之外唯一的保证。需要让每个
`Bash` 调用都经过 Supervisor 时,请使用 headless(`bridge`)模式。

**接管空闲会话。** `adopt-tmux` 只在 Claude 空闲停在提示符时才把任务敲进去;
接管时正在跑的一轮会保留其当前工作,等它下一次 `Stop` 再判断。

**人机协同。** 如果你在已 attach 的 session 中输入内容,自动化会暂停
(`human_takeover`,以警告形式呈现),直到你执行 `/supervise resume-auto
<task-id>`;你接管期间完成的那一轮会在此时重放给 Decision Worker,因此不会
丢失已经完成的工作。

**完成后把会话交还给你。** 与其他 transport 不同,任务完成后默认只是让 Pi 与
该会话断开,而不是关闭它,方便你在同一窗口中继续工作或查看 Claude 做了什么;
`/supervise stop <task-id>` 可以显式关闭它,被阻塞或失败的候选仍会像以往一样
停止 Worker。设置 `PI_CLAUDE_SUPERVISOR_CLOSE_WORKER_ON_COMPLETION=1` 可恢复
旧的"完成即关闭"行为。这次交还是干净的,而不只是断开连接:在报告候选就绪之前,
Pi 会把每个进程从自己的私有 cgroup 移到其父进程(而不是杀掉它们)并停止 guardian
进程,tmux server 和 pane 会保持原样——会话能在 Pi 重启后继续存在,不会留下任何
未完成的清理。之后它就是一个普通的、没有 Supervisor 附着的 tmux session;
`tmux -S <socket> attach -t <session>` 可以直接连上去,`/supervise adopt-tmux`
也可以像对待其他外部创建的 session 一样重新接管它。

**成本核算的限制。** TUI 的 `Stop` hook 没有 `total_cost_usd` 或 token `usage`
(这些字段只出现在 Claude 自己的 `result` stream-json 记录中,而 TUI 不会产生
这种记录),因此交互模式下的成本统计只计算轮次,不计算费用;`--max-budget-usd`
同样不可用(Claude Code 只在 `-p` 模式下强制执行它),也不会传给交互式启动。
如果设置了 `autonomy.maxWorkerCostUsd`,请预期它在交互模式下不起作用;需要
硬性成本上限时请使用 bridge/jsonl 模式。

**信任对话框。** Claude Code 第一次在某个目录中运行时,会先弹出它自己的
一次性"是否信任该文件夹"对话框,然后 hook 才会开始生效。由 `/supervise start`
启动的会话,启动器会自动接受它——且仅当 pane 所在目录就是任务目录时;被接管的
会话是你自己启动的,你早已回答过。

## Headless 模式(JSONL)

`PI_CLAUDE_SUPERVISOR_TRANSPORT=jsonl` 以 `claude -p --input-format
stream-json` 的方式运行 Claude,完全没有终端界面;一旦设置
`PI_CLAUDE_SUPERVISOR_MODE=auto`,它就是默认 transport。Claude 发出的每一个
权限请求都由 Supervisor 回答——拒绝列表、任务目录内的常规编辑、以及只读/本地
开发类 shell 命令由策略直接回答,其余都交给 Decision Worker。`worker_usage`
事件携带来自 Claude 自身 `result` 记录的完整 token 和费用信息,因此
`--max-budget-usd` 以及下文的 token/费用统计都能按预期工作。当任何操作都不能
在 Supervisor 看不到的情况下运行,或者你不需要 attach 时,使用这个 transport。

## 安全边界

- 无论策略或权限模式如何,始终拒绝:远程 push、合并/PR 进 `main` 或 integration
  分支、其他远程 CLI 变更、`.git` 元数据写入,以及对受保护分支的破坏性改写
  (`reset`、`update-ref`、`symbolic-ref`,或带删除/移动/强制标志的 `branch`)。
  策略看不透的 shell 参数(`$VAR`、`$(…)`、通配符)只在可能触及这条边界的命令上
  被尽力拦截——git、gh、npm/pnpm/yarn、curl/wget/ssh、嵌套的 `claude`,以及
  `eval`、`sh -c`、`xargs`、`find -exec` 之类的解释器/执行器。带引号分隔符的
  heredoc 正文按其消费者判断:交给 shell 就是命令,交给 `cat > file` 或
  `git commit -m` 就是数据。除此之外的一切(`for f in …; do echo "$f"`、
  `rm -rf ./dist`、写入 Claude 自己的 scratchpad)都按配置的策略处理——由
  Claude 自己的权限模式决定,和你亲自运行 Claude 时一样。
- `autonomy.permissionAuthority`(`policy` | `hybrid` 默认 |
  `decision-worker`)决定谁来回答权限请求——headless 模式下是每一个请求,交互式
  tmux 模式下只是那些 Claude 本来会弹窗问你的请求:`hybrid` 会让策略独自回答
  任务目录内的常规编辑和本地只读/开发类 shell 命令,并把所有含糊的请求发给
  Decision Worker(策略拒绝总是直接生效)。
- **看 baseline,不看分支。** 任何分支,包括 `main`,都可以被监督;候选只需要
  从记录的 baseline commit 派生出来(`merge-base --is-ancestor`)。任务过程中
  切换分支会被记录(`worker_branch_changed`),而不是被拒绝;落在受保护分支上
  的候选会在通知中报告(`branch`、`protectedBranch`),而不是被挂起。
  `checkout`/`switch` 到 `main` 是允许的;只有对受保护分支名的破坏性改写才会
  被拒绝。Claude Code 自己"默认分支上先切分支"的建议只是提示,不会被强制执行。
- Worker 命令不经过 shell 启动。自动模式只接受裸的 `claude` 命令名,并固定
  由操作者拥有的、不可写的可执行文件路径(可用
  `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` 显式固定)。
- Linux 上,cgroup v2 边界会清理每一个后代进程,包括 `setsid()` 后代;
  `required` 模式会 fail closed,而不是回退到其他清理方式。
- 每个任务有一个总时限(默认 4 小时,可用 `--deadline 8h` 按任务指定或用
  `DEADLINE_MS` 全局设置)。到期不会直接杀掉工作:到期前
  `DEADLINE_WARNING_MS`(默认 15 分钟)会提醒 Decision Worker 引导 Worker 收尾;
  到期后进入 `DEADLINE_GRACE_MS`(默认 30 分钟)的收尾窗口,空闲的 Worker 会被直接
  验收和 review 而不是被停止,`wait` 决策不再生效,修复轮会告诉 Worker 还剩多少
  时间。只有收尾窗口也耗尽,Worker 才会被硬停(`worker_watchdog_timeout`);对
  接管的交互式会话来说这个硬停只是 release:Claude 继续运行,但不再受监督。
  收尾窗口只属于自动模式任务;手动任务仍在到期时停止,`DEADLINE_GRACE_MS=0`
  让自动任务也恢复这一行为。20 分钟无输出 watchdog(`NO_OUTPUT_TIMEOUT_MS`)
  随时会停止沉默的 Worker。
- 验收命令、证据收集和 Reviewer 共用一个 abort signal,因此 stop 或 shutdown
  不必等待完整的命令或模型超时。
- 每个任务只持有一个 cwd 租约;并发任务需要各自独立的 worktree。

## 发布已验证的候选

默认情况下任务止于**已验证的本地候选**:验收与独立 Reviewer 通过,而 Worker 全程
没有任何远程权限。设 `REMOTE_AUTHORITY=push`(或 `--remote push`)会在该判定之后
加一个**发布阶段**:Supervisor 记下已验证的 commit,发放一次性的窄授权,并让
Worker 推自己的分支;`pr` 还允许它开 PR。**push 由 Worker 自己执行**——Supervisor
从不代劳——之后 Supervisor 以只读方式核实(`git ls-remote`,`pr` 还查 `gh pr list`)
才把任务标记完成,候选通知里带上 PR 链接。核实不到则把候选标为 blocked,本地候选
依然可交付。

这个授权刻意严苛,而且两条命令都按字面匹配——没被审过的选项一律拒绝,而不是默认
无害。它只认 `git -C '<任务目录>' -c core.hooksPath=/dev/null -c push.followTags=false push <remote> <已验证 commit>:refs/heads/<branch>`,
不带其他任何选项。refspec 写的是**已验证的 commit** 而不是分支:git 只会推送这一个对象,
Worker 在发布轮里再提交的内容会留在本地("Everything up-to-date"),搭不上这次授权。
**`-C` 是必需的且必须是绝对路径**,两侧都按内核解析后比较——因为 Claude 的 Bash 工具
会在多次调用之间保留工作目录,而 `cd` 属于普通本地操作,没有 `-C` 的话授权可能被花在
任何别的克隆上;目录必须在字面上和经内核解析后都等于任务目录:`/proc/self/cwd`(或指向它的 symlink)会解析成 Supervisor 自己的进程目录,而 `<cwd>/link/..` 字面上是任务目录、git 却会走到别处。
这条命令上**钉死了 hooks 路径**,所以 Worker 通过任何途径(`git init --template=`、
解压归档、`chmod`)装进去的 `pre-push` hook 都不会在授权的 push 里以 Worker 的凭据执行;也钉死了
`push.followTags=false`,所以通过策略看不见的任何文件设的 `followTags=true` 都不能让这一次 push
顺带推上授权没点名的 tag(tag 正是发布自动化的触发点)。两者都是 ref/hook 选择而非传输层,不会
覆盖任何合理的仓库级设置。
`pr` 下另加 `gh pr create --repo <钉住的 remote URL> --head <候选分支> …`(只允许
title / body / base / draft / assignee / label):PR 只会开在授权 remote 对应的仓库里——
不带 `--repo` 的话,gh 会从 remotes 里自己挑一个 base 仓库(fork 上是 `upstream`),
那不是授权点名的仓库,核实也不会去查它。仓库取 remote URL 背后的 `host/owner/repo`
(SSH config 里的 host 别名会像 gh 那样经 `ssh -G` 翻译);URL 不是仓库的 remote(本地路径、
翻译不了的别名)不会拿到 `pr` 授权。授权提供的每个词都做了 shell 引用,分支叫 `feat/$ticket`
也能原样通过策略。

授权只会发给"就是已验证工作树"的那个 commit:工作树必须干净(含未跟踪文件——新文件也可能
是被验证行为的一部分),且 HEAD 自 Reviewer 评审的证据被读取以来没有移动过。仓库的 Git 目录必须是自己的 `.git` 或 linked worktree 的 `.git/worktrees/<name>`(不能是 `--separate-git-dir` 指针)。工作树不干净
会先花一轮修复让 Worker 把属于候选的内容提交掉;只有修复轮用尽或 HEAD 移动过,任务才以本地
候选结束并在通知里写明 `not published:` 原因,而不是发授权。核实时 remote 连不上,发布只是
"未确认"(候选仍可交付),绝不会被说成"没推上去"。

有没有授权都拒绝:任何 push 选项(`-u`、`--force`、`--force-with-lease`、`--delete`、
`--mirror`、`--all`、`--tags`、`--no-verify`、`--push-option`、`--receive-pack` 等)、
除这两个钉死项(且顺序固定)以外的任何 `-c`、以分支或 `HEAD` 作为 refspec 来源、裸 `git push`、
别的 remote、分支或 commit、保护分支、被 shell 包装(含 heredoc 管进 shell)、带动态参数、
第二条语句、不带 `-C` 的 `git push`、`-C` 指向任务目录以外或写成相对路径、不带
`--repo <钉住的 URL>` 或不带 `--head <候选分支>` 的 `gh pr create`(被别的选项当作值吞掉的
`--head` 不算)、`gh pr create --body-file/-F/--template`(会把任意本地文件内容发到 PR 上)、
`--web`、别的 `--repo`、`gh pr merge`、`gh api`、`gh release`、`npm publish`。改动仓库
remote(`git remote set-url|add|rename|…`,藏在 git 自己的 `--git-dir`/`--work-tree` 选项
或 `remote` 自己的 `-v` 后面也一样)一律拒绝;改动 push 去向或 push 期间会执行什么也一律
拒绝——`git config` 写 `remote.*`、`url.*.insteadOf`、`push.*`、`credential.*`、`http.*`、
`include.path`/`includeIf.*`、`init.*`、`core.sshCommand`、`core.hooksPath`,`git config --edit`、
`git init --template=…`、`git init|clone --separate-git-dir=…`,以及任何提到 `.git/config` 或 `.git/hooks` 的语句(除非它显然只读:
`cat`、`grep`、`ls` 等)——否则授权认的 remote 会被偷换,连 Supervisor 的核实也会被骗过;
核实同时钉住 fetch 和 push 两个 URL,并从自己的环境里剔除 `GIT_DIR`/`GIT_CONFIG_*`。这些文本规则之下还有一条不依赖它们的规则:remote 解析后的**全部** fetch/push URL(`git remote get-url --all` / `--push --all`;git 会推到每一个 `pushurl`,而不只是它打印的第一个;已应用改写)在任务**开始**、Worker 还没跑任何命令时记录,并在发放授权时和授权的 push 被批准的那一刻都要求原样不变。任务期间用任何手段(`~/.gitconfig`、脚本、策略看不见的 include)、哪怕在发布轮的第一条命令里加进来的 `pushInsteadOf`、`pushurl` 或额外目的地,都会让 push 被拒、授权作废;操作者原本就有的改写已在基线里,不受影响。恢复的任务沿用记录的基线、绝不重新采集;首次启动时解析不到的 remote 会被记录下来,永不授权。这是一层
作用于命令文本的策略:Worker 自己写一个脚本再运行,策略看不见——如
[autonomy-target.md](docs/autonomy-target.md) 对所有文本级规则所说,绝对隔离是 host 边界的事。

授权是**一次性**的:发布轮一结束就收回(不等下一个决策),并且同时绑定 remote 的 URL
而不只是名字。Worker 若在该轮里改动了工作树(未提交的修改同样算改动),授权立即作废并重新完整验收;因为授权写的是
commit,通知能说清已验证的 commit 是否在工作树变动之前就已经推上去了。验证之前
被拒的 push 会说明授权稍后会来,而不是让 Worker 去猜;没能确认发布的任务会在候选
通知里写明原因,而不是只报一句 "ready"。

## 任务 spec

`--spec file.json` 接受如下格式:

```json
{
  "goal": "Implement the requested change",
  "scope": ["src/"],
  "constraints": ["Keep the public API compatible"],
  "forbidden": ["Do not publish artifacts"],
  "acceptance": [
    { "id": "tests", "name": "tests", "command": "npm", "args": ["test"], "required": true, "timeoutMs": 120000 }
  ],
  "maxRepairRounds": 3,
  "autonomy": {
    "unattended": true,
    "requireLocalCommit": true,
    "maxDecisionRetries": 2,
    "permissionAuthority": "hybrid",
    "maxWorkerCostUsd": 20
  }
}
```

验收命令始终使用 argv 执行,不经过 shell。纯文本任务(不带 `--spec`)会变成一个
带默认 `git diff --check` 验收检查(120 秒超时)和下文环境默认值的 `goal`。

## 配置参考

环境变量(或 `~/.config/pi-claude-supervisor/env`),均以 `PI_CLAUDE_SUPERVISOR_`
为前缀;完整模板见 `.env.example`。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MODE` | 未设置(手动) | `auto` 启用自动监督(Decision Worker + Reviewer 循环) |
| `AUTOMATION` | 未设置 | `1` 等价于 `MODE=auto` |
| `TRANSPORT` | 自动模式下 `jsonl`,否则 `process-pipe` | `jsonl` \| `tmux` \| `process-pipe`(仅手动模式) |
| `TMUX_MODE` | `interactive` | `interactive`(通过 hooks 驱动真实 TUI) \| `bridge`(pane 中的 stream-json) |
| `AUTO_INSTALL_HOOKS` | `true` | 仅交互式 tmux 模式:加载时自动把 hook relay 安装进用户 Claude 配置;`0` 关闭自动安装 |
| `CLOSE_WORKER_ON_COMPLETION` | `false` | 仅交互式 tmux:完成时关闭 Worker/session,而不是保持开启 |
| `CGROUP_MODE` | `auto` | `off` \| `auto` \| `required`;自动模式在 Linux 上要求 cgroup;`required` 只在手动(非自动)tmux Worker 上会被拒绝;自动模式在 Linux 上总是使用 `required` |
| `TMUX_SOCKET` | 未设置(默认 tmux server) | 接管非默认 tmux server 时使用的 socket 路径 |
| `WORKER` | `claude` | Worker 命令;可以包含参数 |
| `NODE` | 未设置(从 `PATH` 解析) | 显式 `node` 可执行文件路径,用于 Bun 编译版 Pi |
| `TRUSTED_CLAUDE` | 未设置 | 显式固定预期的解析后 Claude 可执行文件身份 |
| `STATE_DIR` | `~/.pi/agent/claude-supervisor` | Supervisor 状态目录 |
| `CWD_LEASE_DIR` | `<state>/cwd-leases` | 共享的 cwd 租约注册目录 |
| `WORKER_ENV` | 未设置 | 传给手动 Worker 的环境变量名逗号分隔列表 |
| `HUMAN_WEBHOOK_URL` | 未设置 | 出站候选/失败通知的目标地址 |
| `HUMAN_WEBHOOK_FORMAT` | `generic` | `wecom` \| `generic` |
| `HUMAN_WEBHOOK_SECRET` | 未设置 | HMAC 签名密钥;以 `x-pi-supervisor-signature` header 发送 |
| `UNATTENDED` | `true` | 任务无需同步人工回调即可运行 |
| `REQUIRE_LOCAL_COMMIT` | `true` | 完成前要求在候选所在分支上有本地 commit |
| `MAX_DECISION_RETRIES` | `2`(0–10) | Decision Worker 调用超时或失败(429/529、网络、鉴权)时的重试次数 |
| `PERMISSION_AUTHORITY` | `hybrid` | `policy` \| `hybrid` \| `decision-worker` |
| `REMOTE_AUTHORITY` | `none` | `none` \| `push` \| `pr`;验收通过后开启发布阶段。`--remote` 可按任务覆盖 |
| `REMOTE_NAME` | `origin` | 发布授权唯一允许的 remote 名 |
| `WORKER_MAX_BUDGET_USD` | 未设置 | 作为 `--max-budget-usd` 传入的硬上限;交互式 tmux 下不可用 |
| `WORKER_MODEL` | 未设置(Claude 自身默认值) | Claude Worker 的 `--model` |
| `WORKER_AUTOCOMPACT_TOKENS` | 自动模式默认 `200000` | 每轮上下文上限;`0` 保留 Claude 自身默认值 |
| `WORKER_MCP_CONFIG` | 未设置 | 作为 `--strict-mcp-config --mcp-config` 传入的路径,限制 Worker 可用的 MCP server |
| `DECISION_MODEL` | 未设置(Pi 默认) | Pi Decision Worker 使用的 `provider/model-id`,格式与 Pi 列出的一致 |
| `REVIEWER_MODEL` | 未设置(Pi 默认) | 独立 Reviewer 使用的 `provider/model-id` |
| `DECISION_COMPACT_TOKENS` | `60000` | 持久化 Decision Worker session 超过此大小时主动 compact;`0` 关闭该功能 |
| `PROGRESS_HEARTBEAT_MS` | `60000` | 同一阶段重复进度通知之间的最小间隔 |
| `DECISION_SESSION_RETENTION_DAYS` | `30` | 启动时清理早于此天数的已关闭 Decision Worker session 记录;`0` 表示永久保留 |
| `EVIDENCE_MAX_BYTES` | `1048576`(1 MiB) | 每个任务收集的最大仓库证据字节数 |
| `EVIDENCE_MAX_UNTRACKED_FILES` | `512` | 每个任务作为证据收集的最大未跟踪文件数 |
| `REVIEW_TIMEOUT_MS` | `600000`(10 分钟) | 每轮独立 Reviewer 的总预算,含一次针对 provider 错误的重试 |
| `DEADLINE_MS` | `4h` | 每个任务的累计总时限(`8h`、`90m`、`2h30m` 或毫秒;5 分钟到 7 天);`0`(或 `0m`)关闭;`--deadline` 可按任务覆盖 |
| `DEADLINE_GRACE_MS` | `30m` | 自动任务到期后的收尾窗口:空闲的 Worker 会被验收而不是停止;`0` 恢复到期立即停止 |
| `DEADLINE_WARNING_MS` | `15m` | 到期前多久提醒并重新询问 Decision Worker;`0` 关闭提醒 |
| `NO_OUTPUT_TIMEOUT_MS` | `20m` | Worker 多久没有输出就停止;`0` 关闭该检查 |
| `EVENT_LOG_MAX_BYTES` | `67108864`(64 MiB) | `events.jsonl` 达到该大小后滚动,保留 5 份滚动文件 |

## 恢复、租约与状态

Pi 非正常重启后,`/supervise sessions` 会列出可恢复的任务;`/supervise recover
[--takeover] <task-id>` 会恢复 Decision Worker 上下文并启动一个新的 Claude
Worker,它不会静默恢复或重复执行任务。只有在租约证明旧 Worker 的进程组已经
消失、其 cgroup 是真实可读的空边界时(对 tmux 而言,还要求私有 tmux session
也已消失)才应添加 `--takeover`;缺失或无法确认的证据会被拒绝,而不是被强行
接管。`/supervise recover` 不会持久化原始任务是否为交互式;它在恢复时根据当前
的 `TRANSPORT`/`TMUX_MODE` 配置来判断,因此在启动任务和恢复任务之间请不要
改变这两个配置。

因总时限到期而停止的任务会以 `deadline=expired … ago` 列出。普通 `recover`
会拒绝它;`recover --takeover --extend <duration> <task-id>` 从现在起再给这么
多预算(恢复后的 Supervisor 会把新时限持久化),`--extend 0` 则立即进入收尾:
新 Worker 的第一个 watchdog tick 就会对仓库现状做验收和 review,修复轮会告诉
它还剩多少时间。确定不再恢复的记录用 `/supervise discard <task-id>` 丢弃
(会话文件保留到保留期清理为止)。

每个任务在 `CWD_LEASE_DIR` 下持有一个 cwd 租约;并发任务需要各自独立的
worktree。无法读取的租约记录(损坏的 JSON、异常的结构)会被隔离到 quarantine
目录,而不会阻塞其他查找;`/supervise sessions` 会列出当前被隔离的记录,方便
操作者检查和清理。

事件以 append-only 的 JSONL 形式写入 `<STATE_DIR>/events.jsonl`,其中
`worker_output` 有大小上限,日志会在超过 `EVENT_LOG_MAX_BYTES` 后滚动。每个
任务的 Decision Worker session 都持久化为状态目录下独立的 JSONL 文件,由
`DECISION_SESSION_RETENTION_DAYS` 负责清理。

## 通知

每个终态(`completed`、`blocked`、`failed`)都会在 Pi UI 中发出候选通知,如果
设置了 `HUMAN_WEBHOOK_URL`,还会以 `wecom` 或 `generic` JSON 格式发到 webhook,
设置了 `HUMAN_WEBHOOK_SECRET` 时会附带签名。被挂起并提出问题的候选会发出一条
单独的"需要你"通知;人工接管(你在会话里敲了字)只在 Pi 界面提示,因为你本来就在。当通知涉及 tmux session 时,两种通知
都会带一个 `attach` 字段,内容是可直接执行的 `tmux -S <socket> attach -t
<session>` 命令,以及一份费用摘要(`CandidateNotice.usage`:费用、Worker
轮次/token、Pi token、decision 和 reviewer 调用次数)。webhook 投递会对瞬时
错误(网络、429/5xx)重试。通知只是出站单向的:收到通知不授予任何批准权限,
webhook 也不能把命令推回 Pi——需要那样做时请使用 `/supervise
send`/`approve`/`takeover`。

## Token 消耗与成本控制

以下数据来自一次真实的无人值守 review 任务(总耗时 29 分钟):

| 组成部分 | 轮次/调用次数 | Token | 花费 |
| --- | --- | --- | --- |
| Claude Code Worker | 70 轮 | 15.5M cache-read + 370k cache-write + 100k output | $18.46 |
| Pi Decision Worker | 30 次模型调用 | 约 1.0M(91k 未缓存 + 914k cache-read) | $0.04 |

花费几乎全部来自 Worker,而不是 Supervisor 自身的 Decision Worker 或 Reviewer
调用。这次运行中 Worker 每轮平均消耗约 22 万 token 的上下文,原因是它以单个
长期 `-p` session 运行在 1M token 窗口下,从未触发过 compact;一次普通的
Claude Code 轮次仅系统提示词就要消耗约 2.4 万 prompt token,与配置了哪些 MCP
server 无关。30 次 Decision Worker 调用中有 28 次是权限请求;Decision Worker
推翻确定性 policy 的情形有 4 次(拒绝下载和任务目录之外的写入)——这正是默认
`permissionAuthority` 选择 `hybrid` 而不是 `policy` 的原因。把这 28 次请求
回放到实际发布的 `isRoutinePermission` 分类器,有 4 次可在本地直接回答;那次
任务以内联 `node -e` 脚本和 `$(...)` 替换为主,这两类永远不算例行操作。普通
实现类任务主要是 cwd 内的 `Edit`/`Write`、`npm test` 和 `git
status/diff/add/commit`,这些都是例行操作,Decision Worker 调用次数会下降
得多得多。

各项开关及其默认值和取舍:

- `PERMISSION_AUTHORITY`(`policy` | `hybrid` 默认 | `decision-worker`):
  `hybrid` 会让确定性 policy(`src/policy.ts` 的 `isRoutinePermission`)直接
  回答任务目录内的常规文件编辑和本地只读/开发类 shell 命令,其余请求以及任何
  policy 拒绝仍会发给 Decision Worker。它主要节省的是延迟和 Decision Worker
  的上下文大小,而不是费用:上面的 30 次调用本身只花了 $0.04。
- `WORKER_MODEL` / `--model`:Opus 级和 Sonnet 级模型之间大约相差 5 倍价格,
  是账单上最大的单一杠杆;这是操作者自己的选择,Supervisor 不会替你决定。
- `WORKER_AUTOCOMPACT_TOKENS`(自动模式默认 200000;`0` 保留 Claude 自身默认
  值):限制每轮 Worker 的上下文大小,避免像本例一样持续累积到约 22 万
  token/轮;能节省几十个百分点,但会牺牲一些上下文质量。
- `WORKER_MAX_BUDGET_USD` / `autonomy.maxWorkerCostUsd`:作为
  `--max-budget-usd` 传给 Claude,并由 Supervisor 根据 Worker `result` 的
  累计花费再次核对;这是一个上限而不是节省手段,达到上限的任务会连同证据一起
  被挂起。
- `WORKER_MCP_CONFIG`(`--strict-mcp-config --mcp-config`):限制 Worker 只能
  使用列出的 MCP server;它约束的是 Worker 能触达的范围,而不是普通轮次约
  2.4 万 token 的固定开销。
- `DECISION_MODEL` / `REVIEWER_MODEL`(`provider/model-id`,例如
  `anthropic/claude-haiku-4-5-20251001`):Pi Decision Worker 和 Reviewer
  使用的模型。本例中 Pi 侧花费本就只有几美分,换更便宜的模型主要是换取延迟,
  而不是显著省钱。
- `DECISION_COMPACT_TOKENS`(默认 60000;`0` 关闭):当持久化的 Decision
  Worker session 估算的上下文超过该阈值时主动 compact,并在 compact 之后的
  下一次 prompt 里重新发送一次启动指令。

Supervisor 记录的是实际花费,而不是事后估算:每条 Worker `result` 记录都会
生成一条 `worker_usage` 事件,每次 Decision Worker/Reviewer 模型调用都会生成
一条 `pi_usage` 事件,二者都会累计进 `session.usage`(`SupervisorTokenUsage`)。
`/supervise status <task-id>` 会打印一行 `cost=… workerTurns=…
workerTokens=… piTokens=… decisionCalls=… reviewerCalls=…` 摘要;进度通知
携带 `SupervisorProgress.costUsd`/`.piTokens`,候选通知则通过
`CandidateNotice.usage` 携带同样的摘要(generic webhook 以数值型 `usage`
对象输出,WeCom 格式追加两行费用/tokens)。

除了 Worker 模型和预算的选择之外,以上机制本身并不会改变任务的实际花费;
Supervisor 侧的这些改动主要是削减 Decision Worker 的 token 消耗和延迟,而
这部分原本就只有几美分。对成本敏感的无人值守场景,一个合理的起点是:
`WORKER_MODEL` 选择 Sonnet 级模型、为任务设置明确的 `WORKER_MAX_BUDGET_USD`、
保留默认的 `hybrid` permission authority,并将 `DECISION_MODEL` 设为 Haiku
级模型。

## 开发

为扩展本身贡献代码(使用这个扩展本身不需要这些步骤):

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run test:pi
npm run test:install
```

部分测试会针对真实的 checkout 校验可信可执行文件和受保护分支的边界,因此必须
从非受保护分支、且不在 group/world-writable 路径下运行。

详见 [architecture](docs/architecture.md)、[testing](docs/testing.md) 和
[releasing](docs/releasing.md);`docs/autonomy-target.md` 记录了本项目所
围绕的、已确认的无人值守开发目标。

## License

MIT。见 [LICENSE](LICENSE)。
