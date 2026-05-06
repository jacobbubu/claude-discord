---
stepsCompleted: [1]
inputDocuments:
  - docs/research/reference-plugin-capabilities.md
session_topic: '为单人开发者设计的 Claude Code Discord 插件相对参考实现的差异化候选清单'
session_goals: '产出 30–100 条发散候选，作为后续 product brief 的收敛输入'
selected_approach: ''
techniques_used: []
ideas_generated: []
context_file: 'docs/research/reference-plugin-capabilities.md'
---

# 头脑风暴会话记录

**主持人：** Rong Shen
**日期：** 2026-05-06
**项目：** claude-discord（从零重写的 Claude Code Discord 插件）
**上下文输入：** `docs/research/reference-plugin-capabilities.md`（参考插件能力盘点，已合并到 main）

## 会话总览

**主题：** 为单人开发者设计的 Claude Code Discord 插件相对参考实现的差异化候选清单
**目标：** 产出 30–100 条发散候选，作为后续 product brief 的收敛输入
**定位（用户选择 A）：** 单人开发者——与上游相同的目标人群，但要做得更顺手。这个定位锁住了几条边界：不优先做团队/企业语义、不做多用户审计、不做合规化部署。
**期望产出（用户选择 G）：** 一份足够发散的候选清单——量优先于质，重点是把"独特性可能藏在哪里"摸清，让后续 brief 有选择空间。

### 上下文要点（来自能力盘点）

- 5 个 MCP 工具（reply / react / edit_message / fetch_messages / download_attachment）已经是事实接口，不动名字
- 防注入红线（附件名不入正文 / 状态文件不外发 / skill 拒绝从渠道驱动配置改动）保留
- 待改造方向草稿：可观测性、配对 IPC 替代方案、chunk 策略、ack/typing 粒度
- 不做：本地全文索引（除非作为审计副产品）、跨平台 hub、图形化访问控制 UI
- "单人开发者"定位下，"多用户/多空间语义"从待改造草稿降级为不优先

---

## 用户自由输入（按时间顺序，未筛选）

### 概念 #1 — Channel 池 ↔ Bot ↔ Workspace 三层路由（2026-05-06 用户原话）

> "我想在 discord 上建立一个 channel 池，每个 channel 对应一个 bot。然后我们有多个 claude code（cc）workspace。这些 cc 项目可能由不同的订阅（不同的 claude code 配置）来支持。我需要在 discord 上设置哪些 channel 可以接入哪些 cc workspace。也就是说可以远程操作 cc workspace。"

**我（facilitator）的理解**：

- **三层结构**：Discord channel ↔ Discord bot（1:1）↔ CC workspace（N:M 待澄清）
- 多 workspace 同时存在，可能跑在不同 Claude 订阅 / 配置下
- "在 Discord 上设置哪些 channel 可以接入哪些 cc workspace" = 路由策略**写在 Discord 一侧**（待澄清是 Discord 上的某个配置消息/命令，还是另一种存储）
- "远程操作 cc workspace" = 完整的双向消息循环（不只是单向通知）

**与上游模型的差异**：上游是 1 bot × 1 user × N channel；这里是 N bot × N channel × M workspace 的路由网络。

**待澄清的关键设计点**（暂列，不一次性问完）：

- A. Bot ↔ channel 是否真的严格 1:1？还是 1 bot 可以服务多个 channel？
- B. Workspace 生命周期：DM 进来时如果对应 workspace 没在跑，是自动唤起 CC，还是只路由给已经在跑的？
- C. Channel→Workspace 映射的"权威源"在哪：Discord 一侧（bot 启动时声明）/ CC 一侧（CC 启动时认领 channel）/ 第三方注册中心？
- D. 多订阅意味着什么：多个登录态（不同 API key / Claude 账号）同时跑，还是 CC 进程隔离即可？
- E. 同一个 Discord 用户同时能看几个 channel？工作 / 业余 / 玩具项目分开吗？

### 用户已确认的设计选择（2026-05-06）

- **C → Discord 一侧**：channel↔workspace 映射的权威源在 Discord，不在 CC，也不在第三方协调器。设计后果：CC 启动时不"声明自己拥有哪个 channel"；它要么从 Discord 读取分配，要么被动等被 Discord 通知。
- **B → 已经跑着的**：bot 不远程唤起 CC。DM 进来时若对应 workspace 没在跑，bot 不能临时拉起来。设计后果：需要"workspace 在线状态"概念 + 离线时的 UX 规约（待澄清）。不需要做"workspace 守护进程"或"远程冷启动"。
- **A → 严格 1:1（已修订）→ 单 bot 多路复用**：原本计划"每 channel 配一个 bot"，但用户在 Q4 反问"既然人格不在 bot 上，能不能就一个 bot"——答案是肯定的。最终设计：**单 bot 多路复用 m 个 channel，路由 n 个 workspace（m < n 是常态）**。运维成本从 O(n) 降到 O(1)。
- **N : M 关系**：n 个 workspace > m 个 channel，所以 channel 是稀缺槽位，多个 workspace 共享/轮换占用。

### 浮现出的大致形态（待 Q1.1 / Q1.2 / 离线 UX / 切换可见性等澄清）

- Discord 是命令中枢与移动端 UI；
- **1 个 bot 进程**对外承担所有 channel 的收发，内部维护 "channel id → workspace" 路由表；
- m 个 channel 是稀缺资源池，n 个 workspace 共享/竞争；具体的"哪些 workspace 在哪些 channel 上"由 Discord 一侧的配置决定（Q1）；
- **Addressing 模型：channel-as-slot + 显式 `/use <workspace>` 切换**——用户进 channel #ai-1，看到当前绑了 `bar`，发 `/use foo`，channel 切到 `foo`，之后这个 channel 里所有消息都路由给 `foo`，直到下一次 `/use`；
- workspace 是用户自己启动的 CC session（Q2: 不远程唤起），bot 只在其在线时路由消息；
- 用户感知到的"项目人格"等于"当前绑定到该 channel 的 workspace 的人格"。

### 由 channel-as-slot 模型引出的新待澄清问题

- **F. 当前绑定的可见性**：用户怎么知道当前 channel 绑的是哪个 workspace？候选载体：channel topic / 某条 pinned message / bot 的 nickname 随绑定变 / 必须 `/which` 主动查 / bot 自动在每次切换时发一条状态消息。
- **G. 没切就直接打字会怎样**：用户进了 channel 没看清当前绑定就开始说话——bot 应该**沉默路由**给当前绑定？还是**先回执确认**当前绑定再处理？还是**完全拒绝**直到显式 `/use`？
- **H. 历史交错**：channel #ai-1 上午 9 点绑 `foo`，10 点切 `bar`，11 点切回 `foo`——同一 channel 历史里交错着 `foo` 和 `bar` 的对话，这是 bug 还是 feature？要不要做 thread 级隔离/切换时自动 archive？
- **I. 槽位耗尽**：m=2 但今天要碰 5 个 workspace——是手动反复 `/use`，还是 bot 提供"最近用的 workspace"快捷栏？

---

### 概念 #2 — 订阅与计费（2026-05-06 用户原话）

> "不同的订阅制的是不同 Claude subscription，和我们自己的计费没有关系，我们不计费"

**理解**：

- 多 Claude 订阅 = 用户自己同时持有的 Claude 账号 / 订阅（个人 / 工作 / 不同 plan），CC 进程各自跑在不同 Claude 凭证下。
- 我们这个插件**不做计费、不做配额管理**——纯透明路由。订阅这件事从产品逻辑里彻底消失，只在"workspace 之间互相隔离 Claude credential"这件运维事上存在。

**设计后果**：

- 不需要任何"账户/计费/配额"子系统。简化巨大。
- 多 Claude subscription 的影响只剩一条：每个 CC workspace 启动时用各自的 Claude 登录态（API key / OAuth token / `~/.claude/credentials`）；bot 端一律不感知。

---

### 概念 #3 — 远程操作 CC workspace 的能力范围（2026-05-06 用户原话）

> "远程操作可以发文件（例如截图），触发命令，收文件（markdown 文件观看），上传到飞书某个文件夹（larkdrive）返回链接（markdown，图片），也支持 discord 的权限问答（例子里有）"

**拆开理解**：

1. **发文件（Discord → CC）**：例如截图。上游已部分支持（`download_attachment`），但是被动调用——assistant 看到 `<channel>` 标签里的 attachment_count 才主动下载。我们要不要做"自动下载"？或维持被动？待澄清。
2. **触发命令**：含义模糊。可能是"用户在 Discord 上自然语言要 Claude 做事，Claude 在 CC 内执行命令"（=上游模型，无新东西）；也可能是"用户在 Discord 上发 slash command 直接让 bot 执行某些预定义动作"（=新能力）。**待澄清是哪一种**。
3. **收文件（CC → Discord）**：例如 markdown 给手机看。上游 `reply` 工具的 `files` 数组已支持。
4. **飞书 Drive 集成 ⭐**：CC 产生的文件**自动上传到 Lark Drive 某个文件夹**，返回链接，以 markdown 图片/文件链接的形式回到 Discord 消息里。这是**全新外部集成**，参考实现完全没有。待澄清：
   - 触发条件（永远走 Lark / 大文件走 / 特定类型走 / 用户标记走）
   - Lark 的认证方式（API key、tenant token、用户 OAuth）和文件夹定位（按 workspace 路由到不同文件夹？）
5. **Discord 权限问答**：保留上游 `claude/channel/permission` 协议（按钮 + `yes XXXXX` 文本双通道）。

---

### 概念 #4 — 长任务的 Discord 展示（2026-05-06 用户原话）

> "长任务，在 cc workspace 下如何表现，就如何表现，具体的折叠内容以一种附件方式打开（txt？），我不知道 discord 自己有什么好的展示方式"

**理解**：

- CC 终端怎么渲染就怎么渲染——渲染样式由 CC 自己决定，bot 不重新设计。
- 折叠/可展开内容（thinking、tool trace、长 diff）→ 作为附件（.txt 之类）发出，用户点开看。
- 用户对 Discord 的原生长内容展示不熟，问 facilitator 给建议。
- 未涉及："是否需要 streaming 进度"、"长任务期间是否 typing indicator / progress 编辑"等——后续可深入。

---

### 设计选择确认（2026-05-06，用户已回）

**长内容展示（接受 facilitator 建议组合）**：

- 思考过程 / tool trace → **线程回复**（点开即看，比附件友好）
- 超长代码 / diff / 日志 → **附件**（优先 `.md` 而非 `.txt`，下载后编辑器有高亮）
- 结构化总结 → **embed**
- 流式进度 → **edit 同一条 + 完成时新发一条让手机推送**

**Q6 触发命令 = C（A + B 都要，但 B 限于 bot 内部命令）**：

- A 路径（自然语言 → Claude 在 CC 内执行）：保留上游模型，无新基础设施
- B 路径（slash 命令）：**主要用于 bot 内部状态操作与查询**——`/use <workspace>`、`/which`（查当前绑定）、`/list`（列所有 workspace + 在线状态）等。**不包含** "/run npm test" 类**远程 shell**。安全模型大大简化：slash 命令只改 bot 状态，不直达 workspace shell。
- 技术可行性：Discord slash 命令是一等公民，`discord.js` 全套支持，参数类型由客户端校验。

**Q7 飞书 Drive 触发 = 用户每次显式指定**：

- 默认走 Discord 附件
- 用户每次"标记/挑选"具体哪些文件去 Lark
- **UX 方式待澄清**：是 bot 在文件附件下加 "Upload to Lark" 按钮 / 用户对消息 react 一个特定 emoji / 用户回复一句"上传 Lark" / 还是别的？这条会决定我们要不要做 button 组件、react 监听器、还是简单的 message-content 解析。

**Q5 离线 workspace UX = A 立即回执**：

- bot 立刻回一句 "foo 当前离线，请先在你的电脑上跑 CC"
- **不做消息队列子系统**——零持久化基础设施，零工作量
- 用户体感：手机端能立刻看到状态，决定是去开电脑还是放弃

**Q1.1 配置存储 = 画面 1（bot 本地文件）**：

- 操作入口在 Discord（slash 命令、消息）
- 存储在 bot 本机的 `routing.json`（或类似），跟随 bot 进程
- Bot 重启从本地文件恢复
- 换机器跑 bot 时手动迁配置文件——这是用户自己的运维事
- **不做 Discord-as-DB**——避免把 Discord pinned message / channel topic 当配置数据库的工程别扭

**F 当前绑定可见性 = channel topic + 切换状态消息**：

- Channel topic 永远写当前 workspace 名，bot 在切换时自动改写 topic（"始终可见"）
- Bot 在 `/use` 切换瞬间发一条 "✅ switched to foo" 消息（"切换瞬间确认"）
- 不用 pinned message、不用 nickname-per-channel（Discord 协议层不支持）、不用 `/which-only` 仪式

**G 没切就打字 = 沉默路由**：

- bot 直接把消息转给当前绑定的 workspace
- 视 channel topic 为"用户已知当前绑定"的契约——topic 强可见时，用户没注意是自己的问题
- 不做"先确认/猜测/拒绝"

**Q1.2 谁能改路由 = 只有用户本人**：

- 单人开发者定位下不引入协作权限模型
- 鉴权复用上游 `allowFrom` 机制（Discord user ID 白名单）

**H 历史交错 = feature，不动**：

- Channel 视作"槽位"，历史就是该槽位上发生过的所有事
- 不做 thread 隔离 / 自动 archive
- 后果：用户看 channel 历史时混着多个 workspace 的对话，但内容差异自然区分；零工程成本

**I 槽位耗尽 = 手动 `/use` + `/last` 兜底**：

- 默认手动 `/use <workspace>`
- `/last` 命令切回上一个 workspace（覆盖"两个 workspace 反复切"场景）
- 不做"最近用 button 快捷栏"——后续可加

**Lark UX = React emoji 触发（B）** ~~（brief 终审被推翻，见下方"决策反转"）~~：

- 用户对包含文件的 bot 消息 react 一个特定 emoji（如 📤）
- bot 监听 react 触发上传
- 优势：事后操作（消息已发出也能用）；上行成本低；不污染消息 UI
- 待澄清子问题：Lark 上传成功后，bot 怎么把链接送回？编辑原消息追加？回复原消息？另发新消息？

**决策反转：Lark Drive 集成移出 MVP（2026-05-06 brief 终审）**：

- 用户在 brief 终审时决定 "lark drive 的支持应该拿掉"
- 移出 In scope，移入 Out of scope（标 day-2 扩展可考虑）
- 上面 Lark UX / Lark 触发条件等讨论留作历史记录，但不影响 MVP 范围
- 服务的人画像同步移除 "用飞书做团队协作"
- 成功标准里"Lark 上传成功率"指标替换为"`/recent` 上下文回看体感恰到好处"
- 差异化表格里 "Lark 集成"行替换为 "Workspace 容量管理"

---

### 概念 #5 ⭐⭐⭐ — Bot 是独立的 Gateway Daemon（架构级转向，2026-05-06 用户原话）

> "bot 进程独立于 CC，但是第一个 CC 启动时，主要装了我们的 plugin，就会尝试连接 bot 进程，建立双向通道，进行注册。然后用户在 discord 就可以 list 出来（时间倒序），主动 /use。bot 进程是 singleton 的，可以是一个系统服务（直接启动命令行，或者安装为 launctl，类似 openclaw 的 gateway）。今后也可以服务于 codex。"

> "（关于在线检测）A+B（stdio 状态 + 心跳），是否用 MCP stdio，还需要进一步分析"

> "（关于多订阅运行）A（同时跑多个 CC，能同时和多个 CC stdio 通信）。bot 有总的限流和队列"

**这是与上游模型的根本性偏离**。上游：每个 CC session 用 `--channels plugin:discord` 各自 spawn 一个 MCP server 子进程，1:1 短生命周期。我们的：**1 个 long-running gateway daemon 多对一服务 N 个 CC**。

**Daemon 模型的关键属性**：

1. **Singleton 进程**，机器上一份，pip/brew/cargo 装包后通过命令行手动启动，或注册为 launchd / systemd 服务自启
2. **Discord 一侧**：维持单条网关连接，承担收发 Discord 流量
3. **CC 一侧**：监听本地端点（Unix socket / TCP localhost / 待定），接受 CC 内 plugin 的连接
4. **路由表**：维护 channel↔workspace 绑定表（即 Q1.1 的 `routing.json`），以及 workspace↔CC 进程的活动连接表
5. **限流与队列** ⭐：daemon 内部统一处理 Discord rate limits 和并发请求排队（多 CC 同时 flush 输出时不能各打各的 Discord API）
6. **Agent-agnostic**：今后可服务 Codex 等其他 CLI agent，不锁死 Claude

**注册流程**：

1. 用户启动 daemon（`claude-discord-bot start` 或 launchd 自启）
2. 用户在某 workspace 下跑 `claude` + 我们的 plugin
3. Plugin 启动时**自动尝试连接 daemon**（默认 socket 路径 / 环境变量约定），握手报上 workspace 标识
4. Daemon 把这个 workspace 加进活动表
5. 用户在 Discord 上 `/list` 看到（按注册时间倒序）
6. `/use foo` 切到对应 workspace
7. CC 退出 → plugin 端的 socket 断开 → daemon 立刻标该 workspace 离线（K → A: stdio/socket 断开是最准的离线信号）
8. 心跳兜底（K → B）：plugin 端定期 ping daemon，超时无 ping 也算离线

**待 architect 阶段决定**：

- **CC↔daemon 的传输协议**：Unix domain socket / TCP localhost / 别的；用 MCP 协议跑在新 transport 上 vs 自己设计 RPC——用户明确说"是否用 MCP stdio 还需要进一步分析"
- **Workspace 标识**：plugin 注册时报什么名字？目录 basename / `claude` 启动时的 `--name` 参数 / CLAUDE.md 里的 project_name / 还是用户在 plugin 配置里手填？
- **Daemon 的安装与启动 UX**：MVP 是手动命令行启动够用，还是 day 1 就出 launchd plist？
- **多用户同机器**：如果一台 Mac 两个 user 各跑自己的 daemon——daemon 的 socket 命名空间隔离怎么做？（很可能 out-of-scope，但要标记）
- **Agent-agnostic 的边界**：day 1 是 Claude-only 还是协议层就抽象掉？

**这条决定了产品的差异化定位**。上游是"per-session 桥接"，我们是"machine-level gateway"——这是产品级的不同物种，不是 incremental improvement。

### M / N / O 设计选择确认（2026-05-06）

**M Workspace 标识 = 工作目录 basename + 自增序号防撞名**：

- 注册时 plugin 默认上报 CC 启动目录的 basename（如 `claude_discord`）
- Daemon 内部维护全局唯一性，重名时追加自增序号（`claude_discord`、`claude_discord-2`、`claude_discord-3`）
- 用户在 Discord 上 `/list` 时间倒序看到所有活动 workspace；`/use claude_discord-2` 显式选择
- 零配置覆盖最常见场景；CLAUDE.md / package.json 命名权可作为 day-2 增强

**N Daemon 启动 UX = A + B + 自动安装脚本**：

- **MVP**：`claude-discord-bot start` 直接前台跑（开发期友好）
- **生产**：装完后 `claude-discord-bot install` 自动生成并安装 launchd plist（macOS）/ systemd unit（Linux），把它注册成系统服务，开机自启
- **范例**：参考 openclaw 已实现的 daemon install plan 流程：探测 OS → 定位 `~/Library/LaunchAgents/` → 生成 plist 模板（指向我们的 entry script）→ `launchctl load` → 验证状态。openclaw 已踩过的坑（`daemon-install-plan.shared`、`daemon-install-helpers`、`gateway-install-token`）值得直接抄路线
- **路径**：`claude-discord-bot uninstall` 用于卸载；`claude-discord-bot status` 查健康
- 这套 install 脚本本身就是产品差异化能力之一（参考插件完全没有这层）

**O Codex / agent-agnostic = C（扩展点 day 1，实现 day 1 仅 Claude）**：

- Plugin↔Daemon 协议设计时引入 version + capabilities 协商（如 plugin 上报 `agent: "claude-code"`、daemon 路由时按 agent 维度区分），但 day 1 只实现 Claude 路径
- 不在 day 1 增加 Codex 依赖，但协议层不会因为 Codex 加入而需要 v2
- 协议本身复用通用术语（不叫 "claude_workspace" 而叫 "agent_workspace"；不叫 "claude_response" 而叫 "agent_message"）

### 与 openclaw 的关系定位

- **openclaw**：多 channel × 多 agent 的全能 gateway（discord/telegram/slack/signal/imessage/whatsapp/matrix/msteams/feishu/line/voice-call/...，外加 pi-agent / acp 等多 agent 路径）
- **我们（claude-discord）**：聚焦 Discord × Claude Code 的**深度场景**——把 Discord 这一个 channel 的多 workspace 路由 / Lark 集成 / `/use`-`/last` UX / Discord 权限问答做到比 openclaw 的 channel 之一更精致
- **架构形态对齐**：daemon + plugin-sdk + cli installer + launchd 整套模式直接对标 openclaw，install 脚本、launchd plist 模板、状态命令的实现都可以参考 openclaw 现成路线
- **不与 openclaw 直接竞争**：openclaw 是"我啥都接"，我们是"Discord 接 Claude 接到极致"。两者用户重叠但定位互补

---

### 概念 #6 — 切回 workspace 的上下文回看 ⭐（2026-05-06 用户原话）

> "切换 workspace 的时候，如何以合理的方式，显示之前的一小段消息？例如增加一个指令显示 /last 5？而且带上每一条消息当时的时间"

**问题本质**：channel-as-slot 模型下，`/use foo` 切回去时，**channel 历史是其他 workspace 的对话**——用户最需要的是 foo 自己的最近上下文。

**决定**：

- **新增 `/recent N`** slash 命令——和 `/last`（切回上一个 workspace）解耦，避免重载
- **N max = 5**，默认 3
- **持久化策略 A：内存环形缓冲（不落盘）**——daemon 内每个 workspace 留 50 条最近交互（含 user→workspace 与 workspace→user 双向、原始 timestamp、原始 channel id），daemon 重启即丢
- **`/use` 切换时 C：条件性主动展示**——按必要性算法决定要不要自动给上下文，避免噪声

**必要性算法**：

```
on /use foo:
    buf = ring_buffer[foo]
    if buf is empty:                                  → skip + "(no recent activity)"
    if now - last_activity < 15min (THRESHOLD_RECENT) → skip
    if last_channel == current_channel                → skip（向上滚就能看到）
    else                                              → 展示最近 3 条，带原始时间戳
```

**展示格式**：使用 Discord 原生 `<t:UNIX:R>` 渲染相对时间 + 绝对时间，不重新发明时间戳格式。

**对早期"不做 audit / log 子系统"决定的影响**：

- 这是**软化**而非推翻：本质是 in-memory ring buffer，不持久化、不查询接口、无审计语义
- 但它给"日后扩展为持久化 audit log"留了清晰路径（环形缓冲 → 滚动 JSONL → 查询接口）
- MVP 阶段定位为"切换体验组件"，不是"审计组件"

**与 H 决定（历史交错 = feature）的关系**：

- H 仍然成立——channel 历史是混的，是个槽位的物理事实
- `/recent` 引入了**第二个时间维度**——基于 workspace 的逻辑历史
- 用户体感：channel 是物理时间线（混着），`/recent` 是 workspace 视角的逻辑时间线（自己的）
- 两条时间线互不干扰；用户需要哪种就用哪种

**slash 命令清单更新**：

- `/use <workspace>` — 切换
- `/last` — 切回上一个 workspace（**保持**原义，不重载成 `/last N`）
- `/list` — 列出所有活动 workspace（时间倒序）
- `/which` — 查当前 channel 的绑定
- `/recent [N]` — **新增**，默认 3，N max = 5，列当前 workspace 的最近 N 条消息
- `/status [workspace]` — 在线/离线状态

---

### 概念 #7 — Daemon 注册表容量与 LRU 驱逐（2026-05-06 用户原话）

> "还需要一个 deamon 自动清理机制，就是其维护的 workspace 是有上限的，例如 50，超过了就会自动挤出最长不活跃的 workspace，但是这就需要当这个 workspace 重新活跃时，自动重新注册。"

**问题本质**：daemon 不能无界增长——开发者偶尔会 spawn 一堆短命 CC 进程做实验，daemon 内存里挂 500 条注册表 + 500 个 ring buffer 就失控了。

**决定**：

- **Soft cap = 50**：触发 trim 时降到 45，留 5 个缓冲位避免每次注册都 LRU 比较的开销
- **LRU 驱逐策略**：每个 workspace 维护 `last_activity_ts`（任意方向消息都触发更新），cap 触发时按 ts 升序驱逐到 45
- **驱逐 = 内存清理**：丢注册表条目 + 丢 ring buffer + **关闭 socket**（让 plugin 立刻看到 disconnect）
- **不杀 CC 进程**：daemon 只管自己的 view，不影响用户机器上的 CC 生命周期
- **完全静默**：不发 Discord 消息，stderr 不警告，仅在 daemon 日志里记录
- **routing.json 不受影响**：channel→workspace 名字的绑定持久化，被驱逐 workspace 仍然能在 routing.json 里找到自己的 channel 绑定，等 plugin 重连后无缝恢复

**自愈再注册路径**：

- Plugin 看到 socket disconnect → 触发内置 reconnect 逻辑（指数退避或下次有输出时）
- 重连后重新握手报上 workspace 标识 → daemon 加回注册表
- 用户视角：被驱逐 workspace 短暂从 `/list` 消失，下次活动时自动回来
- 用户在已绑该 workspace 的 channel 里发消息时如果 plugin 还没重连：bot 走 Q5 离线逻辑回 "foo 当前离线"，与"CC 真的退出了"无差别

**配置**：

- `CLAUDE_DISCORD_WORKSPACE_CAP` 环境变量可调整 soft cap（默认 50，下界 10，上界 500）
- `CLAUDE_DISCORD_WORKSPACE_TRIM_TARGET` 调整 trim 目标（默认 45）
- 不暴露给 Discord slash 命令（这是运维而非用户命令）

**对早先决定的影响**：

- 与 K（在线检测 = stdio + 心跳）一致——心跳的"活跃信号"同时刷新 LRU
- 与 ring buffer（concept #6）一致——驱逐时一并清理
- 不与任何已有决策冲突

