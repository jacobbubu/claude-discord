---
project: claude-discord
date: 2026-05-06
author: Rong Shen
status: draft (PM phase output, awaiting user review)
workflowType: prd
inputDocuments:
  - docs/research/reference-plugin-capabilities.md
  - _bmad-output/brainstorming/brainstorming-session-2026-05-06-1645.md
  - _bmad-output/planning-artifacts/product-brief.md
issue: jacobbubu/claude-discord#4
---

# Product Requirements Document — claude-discord

## 1. Executive Summary

claude-discord 是一台 machine-level 的 agent gateway daemon，把开发者电脑上同时运行的多个 Claude Code workspace 路由到 Discord 上有限的 channel 槽位，使用户能从手机或任意一台桌面以一致的体验远程操作它们。它不复制上游官方 Discord 插件那种"每个 CC session 自己 spawn 一个 MCP 子进程"的模型，而是一个 long-running daemon 多对一服务 N 个 CC，channel 数量 M < N，channel 视为槽位，`/use <workspace>` 显式切换绑定。

技术形态对标 openclaw 的 daemon + plugin-sdk + cli installer + launchd 模式，但范围严格收紧到 Discord × Claude Code 这条路径。MVP 目标是作者本人放弃 raw `claude` + 原版插件、全切到本产品做日常，并能引来第二个用户提 issue。MIT 许可证。

## 2. Problem Statement

多 workspace 是开发者的常态：一个稍微活跃的开发者电脑上会同时挂着主项目、副业、写作工程、玩具实验，每个项目对应一个 Claude Code session。"在地铁上想到某个项目应该跑个测试"是个真实日常需求。

**现有方案在多 workspace 上都失能**：

- **官方 Discord 插件**走每 session spawn 一个 MCP 子进程的 1:1 模型，N 个项目要 N 个 Discord application + N 个 token + N 次 `/discord:configure`。运维负担线性上升，5 个项目以上开始痛
- **完全转移到云端 IDE / 远程开发** 是另一条路，但代价是放弃本地工作流、本地文件系统、本地 LLM 凭证管理
- **不上 bridge 纯本地用 CC** 丢掉了"离开桌子也能继续"——而手机操作 AI agent 已经不是奢侈，是日常

具体痛点形态：你想在手机上推一句话给某个项目，但你打开 Discord 找不到对应项目的 channel；或者找到了但不知道这个 channel 现在指着哪个 workspace；想切换 workspace 没有命令；切换后想看几条上次活跃时的上下文找不到——这套体验今天不存在。

## 3. Vision

**一年**：稳定可用的 Discord × Claude Code daemon，开源，吸引到第二批主动安装的用户。

**两年**：协议层抽象到位，扩展支持 Codex 等其他 CLI agent。Plugin-sdk 公开，让 IRC、Matrix 等 channel 作为社区贡献接入。但 Discord 仍是一等公民。

**三年**：成为"个人开发者多 agent 多 workspace 远程操作"这一品类的 reference implementation——它到了那里，意味着我们没成为 openclaw 的子集，而是探出了"窄而深"的另一条路。

## 4. 成功标准

MVP（Day 90）算成功的判据，分量化与非量化两类。量化指标用于 soak / e2e 测试与回归看板；非量化判据需要事后主观回顾，但不可以省。

### 量化指标

| # | 指标 | 目标 | 测量方式 |
| --- | --- | --- | --- |
| SC-1 | Daemon 稳定性 | 连续运行 7 天无需 kill -9 | 7 天 soak test 不重启 |
| SC-2 | Workspace 注册延迟 | CC 启动到 `/list` 里出现 < 3 秒 | 端到端计时 |
| SC-3 | `/use` 切换响应 | < 1 秒收到 "✅ switched" | Discord 消息时间戳差 |
| SC-4 | 离线检测延迟 | CC 退出到 daemon 视图标离线 < 5 秒 | 日志时间戳差 |
| SC-5 | `/recent` 上下文回看体感 | 90% 场景下用户判定"恰到好处"（不冗余、不缺席） | 自用记录 |
| SC-6 | 零数据丢失 | normal ops 下不丢消息（异常下要明确告知） | 完整 e2e 回归 |

### 非量化判据

| # | 判据 | 说明 |
| --- | --- | --- |
| SC-7 | 作者自用满意度 | 作者本人放弃 raw `claude` + 原版 plugin，全切到 claude-discord 做日常 |
| SC-8 | 第二个用户出现 | 朋友 / 关注的开发者愿意自己装、用一周、提 issue——这条比所有量化指标都更重要：它是"问题真不真"的最终判据 |

NFR-1（性能） 与 §13 Roadmap 的里程碑里相同的数字会以"执行细节"形式重复出现，但 SC-1 至 SC-8 才是定义"什么算 MVP 完成"的契约。

## 5. Target Users & Personas

### 主要用户：拥有 3+ 活跃 CC 项目的资深独立开发者

- 同时持有 1-3 个 Claude 订阅 / 账号；每个项目可能用不同 credential
- 经常在地铁、咖啡馆、不同电脑之间切换工作场景
- 对开发者 CLI 工具有耐心：`launchctl`、`brew services`、命令行 install 不会劝退
- 已经在用 Discord 作为个人通讯/小组工具
- 习惯用 markdown、tmux、git 等"对终端深度依赖"的工具

### 不服务的用户

- 团队 / 企业用户（不做协作权限模型）
- 只有 1 个项目的轻度用户（上游插件已经够用）
- 不熟悉命令行 install 的纯 GUI 用户（MVP 阶段）

## 6. Differentiation

| | 上游官方插件 | openclaw | claude-discord |
| --- | --- | --- | --- |
| 进程模型 | 每 session 一个子进程 | 单 daemon 多 channel | **单 daemon 单 channel 多 workspace** |
| Channel 数量 | 1 bot 服务 N channel | 各种 channel 都接 | M < N，**channel 是槽位** |
| Workspace 切换 UX | 没这概念（1:1） | 各 channel 自有 | **`/use` + `/last` + `/recent`** |
| 容量管理 | 无 | gateway 级 | **soft cap + LRU 自愈再注册** |
| 安装 | per-session MCP | daemon-install-plan | **抄 openclaw scope 收紧** |
| 多 agent | Claude only | 多 agent | **协议留扩展点，day 1 Claude only** |

护城河是"聚焦"：openclaw 因为接得多，每个 channel 都只能做到中位；我们因为只接 Discord，能把 Discord 的 slash 命令、按钮、react、thread、embed 这些原生能力榨干到 openclaw 没空做的程度。

## 7. User Journeys

### J1：典型一天

- **8:50 出门**：手机 Discord 打开 channel `#ai-1`，topic 写着 `claude_discord`（昨晚最后绑定）。`/list` 看到当前 6 个活动 workspace（按注册时间倒序）。`/use myproject` → topic 改写，bot 回 "✅ switched to myproject"。系统判定上次活动 > 15 分钟前 → 自动展示 myproject 的最近 3 条交互（带原始时间戳）
- **9:05 地铁里**："帮我看下 server.ts 里那个超时逻辑"。消息走给 myproject CC session，Claude 处理。输出走线程回复（详细推理）+ 一条主消息（结论）
- **12:00 公司桌面继续**：daemon 没动，所有 workspace 仍在线。打开 Discord channel `#ai-1`，topic 仍是 myproject，直接继续打字
- **14:00 切到副业**：`/use sideproject` → topic 改、状态消息发出。channel 历史里现在混着 myproject 和 sideproject 的对话——这是 feature，不做隔离。`/recent 3` 一眼就能找到 sideproject 自己的最近上下文
- **17:00 回到 myproject**：`/last` 一键切回上一个 workspace（即 myproject）

### J2：截图调试

- 在公司发现某个网页布局错位 → 手机截图 → 在 channel 里发图片附件
- bot 接到入站 → 把消息（带 attachment 元信息）转发给当前绑定的 workspace
- Claude 调 `download_attachment` 工具下载到本地 inbox → 接着分析 → 回复修复方案

### J3：长任务交互

- "帮我把 X 模块按 Y 重构一下"——长任务
- bot 在你发完后立刻回一条 "Working..." 消息，并 edit 这条消息更新进度（手机不会被反复推送）
- 任务完成时 bot **新发一条** 消息（让手机震一下），主消息是结论 + 关键改动列表（embed 格式），思考过程作为线程回复挂在主消息下，超长 diff 作为 `.md` 附件挂在主消息里

### J4：离线 workspace

- 周末打开手机想 `/use mytoyproject`，但你电脑关机了
- bot 立刻回 "mytoyproject 当前离线，请先在你的电脑上启动 CC"
- 不排队、不缓存、不假装等会儿——你立即知道现状

### J5：Discord 权限问答

- Claude 在 myproject 里要执行一个高权限工具（如 Bash），要求用户授权
- bot 给你的 DM 发一条带 "Allow / Deny / See more" 三按钮的消息
- 你点击，决策回流给 CC，工具继续执行（或被拒）
- 也可以用文本 `yes ABCDE`（5 字母 request_id）来回应

### J6：首次安装

- `npm install -g claude-discord-bot`
- `claude-discord-bot configure` 引导：输入 Discord token → 写入 `~/.claude/channels/discord/.env`
- `claude-discord-bot install` → 探测 OS → 在 `~/Library/LaunchAgents/` 写 plist → `launchctl load` → 验证状态
- `claude --channels plugin:claude-discord` 启动 CC 时 plugin 自动连 daemon 注册
- 手机 DM bot → 上游 pairing 流程 → `claude-discord-bot pair <code>` 批准 → 进入许可
- 至此从手机能 `/use <workspace>` 操作

## 8. Domain Model & Glossary

| 术语 | 定义 |
| --- | --- |
| **Daemon** | 本机长驻 singleton 进程；维持 Discord 网关 + 监听本地 socket 接 plugin |
| **Plugin** | 跑在 agent 进程（CC / Codex 等）里的 SDK 模块；agent 启动时自动连 daemon 握手注册 |
| **Agent type** | Workspace 的来源标识，如 `claude-code`、`codex`；plugin 握手时上报，daemon 据此选用相应消息协议、工具集、权限 Q&A 通道 |
| **Workspace** | 一个 agent session 的逻辑标识；标识符默认为工作目录 basename + 撞名时 daemon 自增序号；同一 workspace name 仅由单个 agent type 持有 |
| **Channel slot** | Discord 上的一个 channel 视为一个绑定槽位，当前绑定的 workspace 由 channel topic 写明 |
| **Routing table** | `routing.json`：channel ID → workspace name 的持久化映射 |
| **Active registry** | Daemon 内存中的 workspace ↔ socket 连接表，soft cap 50 |
| **Ring buffer** | 每 workspace 保留最近 50 条交互（原始 timestamp + 方向 + channel id）；内存的，daemon 重启即丢 |
| **LRU eviction** | active registry 满时按 `last_activity_ts` 升序驱逐到 45；丢 ring buffer + 关 socket，让 plugin 自动 reconnect |
| **Allowlist** | Discord user ID 白名单，沿用上游 `access.json` 设计；DM 路径必经 |
| **Pairing** | 首次未知 user DM bot → 回 6 hex 配对码 → 用户在终端 `claude-discord-bot pair <code>` 批准 |

## 9. Project Type & Constraints

- **Greenfield**：从零重写，不 fork 上游
- **License**：MIT
- **Repo**：`github.com/jacobbubu/claude-discord`，初始 private，公开化为 day-2 操作
- **方法论**：BMAD-METHOD 完整流（analyst → PM → architect → dev → QA）
- **首发平台**：macOS（launchd），Linux 紧随（systemd）；Windows MVP 范围外
- **运行时**：Node 或 Bun（架构阶段决定）
- **协议透明度**：plugin↔daemon 协议 day 1 引入 version + capabilities + agent 字段，预留 Codex / 其他 agent 接入

## 10. Scope

### In Scope（MVP，Day 90 必须有）

- Daemon 进程 + plugin-sdk + CLI installer
- 单 bot 多 channel × N workspace 路由（routing.json + active registry）
- Channel-as-slot UX（topic + 切换状态消息 + 沉默路由）
- Slash 命令套件：`/use` `/last` `/list` `/which` `/status` `/recent`
- Soft cap 50 + LRU 自愈再注册
- Ring buffer 50/workspace + `/use` 条件性自动展示
- 上游 5 个 MCP 工具的等价实现
- 长内容展示规约（线程 / `.md` 附件 / embed / edit + 完成新消息）
- Discord 权限问答（按钮 + `yes XXXXX` 双通道）
- 沿用上游 access.json 鉴权（pairing / allowlist / disabled，guild 频道 opt-in，mention 检测）
- launchd（macOS）+ systemd（Linux）安装脚本
- `claude-discord-bot` CLI 子命令：`start` `install` `uninstall` `status` `configure` `pair` `deny` `policy` `allow` `remove` `group add/rm` `set`

### Out of Scope（明确不做）

- 计费 / 配额 / 账户管理
- 远程拉起 CC（用户自己启动）
- Slash 命令直通 workspace shell
- 消息队列 / 离线缓冲
- Discord-as-DB（不把 pinned message 当配置存储）
- 多用户协作权限模型
- 跨 channel hub（不再做 telegram / slack / signal）
- 远程 daemon（daemon 必须与 CC 同机）
- 外部存储集成（飞书 Drive / Google Drive）——day-2 候选
- thread 隔离 / 自动 archive（历史交错是 feature）
- Windows 平台 MVP 支持

## 11. Functional Requirements

下表中 **P0** = MVP 必须；**P1** = MVP 应当（90% 完成度即可发）；**P2** = post-MVP。**作者建议优先级，待你调整**。

### Epic 1: Daemon Process & Lifecycle

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-1.1 | 通过 `claude-discord-bot start` 前台运行 daemon | 进程起来后接受本地 socket 连接、连上 Discord 网关；stdin EOF / SIGTERM / SIGINT 触发优雅关停 | P0 |
| FR-1.2 | 通过 `claude-discord-bot install` 注册为 launchd / systemd 服务 | 写入 plist / unit；服务能 enable + start；重启机器后自启 | P0 |
| FR-1.3 | 通过 `claude-discord-bot uninstall` 卸载服务 | 反向操作，删除 plist / unit，可被 install 幂等覆盖 | P0 |
| FR-1.4 | 通过 `claude-discord-bot status` 查健康状态 | 返回：daemon 是否在跑 / Discord 连接状态 / active workspace 数 / uptime | P1 |
| FR-1.5 | 全局兜底 unhandled rejection / uncaught exception | 不让单条异步消息打死整个 daemon；记 stderr | P0 |
| FR-1.6 | 连续运行 7 天不需要 kill -9 | 通过为期 7 天的 soak test；无内存泄漏到危险水位 | P0 |

### Epic 2: Plugin SDK（CC-side）

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-2.1 | CC 启动时 plugin 自动连接 daemon | 默认连接路径在状态目录下；具体 transport 类型由架构阶段决定；连接失败时退化为有限重试，不阻塞 CC 启动 | P0 |
| FR-2.2 | 握手时报 workspace 标识 | 取 `cwd` 的 basename；daemon 端撞名时返回追加序号的 final name；plugin 接受并 cache | P0 |
| FR-2.3 | 心跳 | 每 N 秒（如 10s）发一次心跳；超时由 daemon 端判定 | P0 |
| FR-2.4 | 自动 reconnect | socket 断开（含被驱逐）时，按指数退避重连（含上限）；重连后重新握手 | P0 |
| FR-2.5 | Plugin 接收 daemon 路由的入站消息 | 把消息以 `notifications/claude/channel` 形式投递给 CC | P0 |
| FR-2.6 | Plugin 转发 CC 端的工具调用结果回 daemon | reply / react / edit / fetch / download 五个工具的入参从 CC 端转给 daemon 执行 | P0 |
| FR-2.7 | Plugin 在 CC 退出时干净断开 | stdin EOF 触发 close socket；daemon 立刻看到离线信号 | P0 |
| FR-2.8 | 握手 payload 携带 `agent` 标识 | 字段如 `agent: "claude-code"`（v1）；daemon 持久化到 active registry 与 ring buffer 元数据；后续可扩展 `codex` 等取值不需要协议升级 | P0 |
| FR-2.9 | Plugin 在握手时声明 `protocol_version` 与 `capabilities` | 用于 daemon 与 plugin 之间能力协商；不匹配时 daemon 拒接并打印兼容提示 | P0 |

### Epic 3: Discord Channel Routing

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-3.1 | `routing.json` 维护 channel → workspace 的持久化映射 | 文件位于 `~/.claude/channels/discord/routing.json`，权限 0o600，原子写（写 .tmp 再 rename） | P0 |
| FR-3.2 | Daemon 内存维护 active registry：workspace name → plugin socket | 用于将 Discord 入站消息路由到正确 plugin | P0 |
| FR-3.3 | Routing 改动热生效 | 不需要重启 daemon；内存视图实时更新 | P0 |
| FR-3.4 | 入站消息按 channel 路由 | 收到 Discord 消息 → 查 routing.json → 查 active registry → 转发给对应 plugin；找不到时按 Q5 离线流程回复 | P0 |
| FR-3.5 | 出站消息按 workspace 路由 | plugin 发的输出按当前绑定的 channel 出去；如果绑定变了，按当前 channel | P0 |
| FR-3.6 | Daemon 按 agent type 选用相应消息协议 / 工具集 / 权限 Q&A 通道 | day 1 仅 `claude-code` 实现完整路径；其他 agent type 注册时若 daemon 不识别，拒接并提示 plugin 升级 daemon 或 plugin | P0 |

### Epic 4: Slash Commands

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-4.1 | `/use <workspace>` 切换当前 channel 绑定 | 修改 routing.json + 改 channel topic + 发 "✅ switched to X" 状态消息 + 触发条件性 `/recent` 显示 | P0 |
| FR-4.2 | `/last` 切回上一个 workspace | 按当前 channel 的 routing 历史回退一步 | P0 |
| FR-4.3 | `/list` 列出所有活动 workspace（时间倒序） | 每行：workspace name、agent type 标签、状态（在线/离线）、上次活动相对时间 | P0 |
| FR-4.4 | `/which` 查当前 channel 的绑定 | 返回 workspace name + agent type + 上次活动时间 + 在线状态 | P0 |
| FR-4.5 | `/recent [N]` 列当前 workspace 最近 N 条 | N 默认 3，max 5；展示原始 timestamp（用 Discord `<t:UNIX:R>` 格式）+ 方向 + 内容摘要 | P0 |
| FR-4.6 | `/status [workspace]` 查在线状态 | 不带参数 = 当前 channel 绑定的 workspace；带参数 = 指定 workspace | P1 |
| FR-4.7 | Slash 命令自动补全 | 注册 Discord application command，参数类型由 Discord 客户端校验 | P0 |
| FR-4.8 | Slash 命令鉴权 | 仅 `access.allowFrom` 中的 Discord user ID 可调用；其他人尝试时静默拒绝 | P0 |

### Epic 5: Long Content Display

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-5.1 | 短消息（≤ 2000 字符）直接 inline | 按 `chunkMode` 切片（length / newline），`replyToMode` 控制 thread 行为 | P0 |
| FR-5.2 | 长单体内容（如 diff、log）作为 `.md` 附件 | 触发条件：内容超过某阈值（如 4000 字符）或显式标记；优先 `.md` over `.txt` | P0 |
| FR-5.3 | 思考过程 / tool trace 走线程回复 | 主消息是结论；推理过程作为 thread 挂在主消息下；移动端点开即看 | P1 |
| FR-5.4 | 结构化总结走 embed | 含 title / description / fields；总字符 ≤ 6000 | P1 |
| FR-5.5 | 流式进度 edit 同一消息 | edit 不触发推送；任务完成时 send 一条新消息让设备震一下 | P0 |

### Epic 6: Discord Permission Q&A Relay

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-6.1 | 接收 CC 的 `permission_request` 通知 | 协议字段：request_id（5 字母 a-km-z）/ tool_name / description / input_preview | P0 |
| FR-6.2 | 给 `allowFrom` 用户发带按钮的 DM | "See more" / "Allow" / "Deny" 三按钮 | P0 |
| FR-6.3 | "See more" 展开完整 input_preview | 用 JSON pretty-print；保留 Allow/Deny 按钮，隐藏 See more | P1 |
| FR-6.4 | 按钮回应 → 发 `permission` 通知给 CC | 验证按钮点击者在 `allowFrom`；改写消息显示结果（"✅ Allowed" / "❌ Denied"），消除按钮 | P0 |
| FR-6.5 | 文本回应 `yes XXXXX` / `no XXXXX` | 正则匹配；命中后不当聊天转发；对消息加 ✅/❌ react | P1 |
| FR-6.6 | 仅 DM 路径参与权限请求 | guild 频道明确不发权限请求（沿用上游单用户安全语义） | P0 |

### Epic 7: Channel UX

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-7.1 | Channel topic 永远写当前 workspace | `/use` 切换时 daemon 调 Discord API 改 topic；格式约定（如 `[claude-discord] foo`） | P0 |
| FR-7.2 | 切换时发 "✅ switched to X" 消息 | 一条简短消息，可被进一步流跟进 | P0 |
| FR-7.3 | 没切就打字 = 沉默路由 | 不弹确认、不猜测、不拒绝 | P0 |
| FR-7.4 | 历史交错不做隔离 | 不开新 thread、不 archive；channel 是物理时间线 | P0 |

### Epic 8: Message Recall Ring Buffer

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-8.1 | Daemon 维护 per-workspace 50 条 ring buffer | 含原始 timestamp / 方向 / channel id / 内容（截断到合理长度） | P0 |
| FR-8.2 | `/recent N` 读 buffer 展示 | 按时间正序；用 `<t:UNIX:R>` 渲染相对时间 | P0 |
| FR-8.3 | `/use` 切换时按必要性算法决定是否自动展示 | 算法：buf 空 → skip；上次活动 < 15 min → skip；上次 channel == 当前 channel → skip；否则展示最近 3 条 | P0 |
| FR-8.4 | Workspace 被 LRU 驱逐时 ring buffer 同步清理 | 不留孤儿 | P0 |

### Epic 9: Workspace Registry Capacity

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-9.1 | Soft cap 50（可由 `CLAUDE_DISCORD_WORKSPACE_CAP` 调整） | 范围 10-500 | P0 |
| FR-9.2 | 注册数超 cap 时按 LRU 驱逐到 45 | 比较粒度秒级；trim target 由 `CLAUDE_DISCORD_WORKSPACE_TRIM_TARGET` 调整 | P0 |
| FR-9.3 | 驱逐 = 关闭 plugin socket + 丢 ring buffer + 删 active registry 条目 | 不杀 CC 进程；routing.json 不变 | P0 |
| FR-9.4 | 驱逐完全静默 | 无 Discord 消息；仅 daemon 日志（debug 级别）记录 | P0 |
| FR-9.5 | Plugin reconnect 时无缝重新出现 | reconnect 后正常注册，重新加入 active registry | P0 |

### Epic 10: Offline Workspace UX

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-10.1 | 入站消息发往离线 workspace 时 bot 立即回执 | "X 当前离线，请先在你的电脑上跑 CC"；bot 仍 ack 入站（typing / react） | P0 |
| FR-10.2 | 在线检测 = socket 状态 + 心跳兜底 | socket 断离线立判；心跳超时（如 30 秒）也算离线 | P0 |
| FR-10.3 | 离线检测延迟 < 5 秒 | 从 plugin 实际断开到 daemon 视图标离线 | P0 |

### Epic 11: Sender-side Access Control（沿用上游）

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-11.1 | `dmPolicy = pairing`：陌生人 DM 回 6 hex 配对码，丢消息 | 配对码过期 1h；pending 容量 3；同 sender 24h 内最多回 2 次 | P0 |
| FR-11.2 | `dmPolicy = allowlist`：陌生人静默丢 | 不回任何东西 | P0 |
| FR-11.3 | `dmPolicy = disabled`：全丢（含 allowFrom 与 guild 频道） | 维护"完全噤声"语义 | P0 |
| FR-11.4 | `claude-discord-bot pair <code>` 批准 | 加入 allowFrom + 删 pending + 写 `approved/<senderId>` 文件触发 daemon 发 "Paired!" 确认 | P0 |
| FR-11.5 | Guild 频道按 channel ID opt-in | `groups[<channelId>].requireMention` + `allowFrom` 控制；线程继承父 channel | P0 |
| FR-11.6 | Mention 检测三路径 | 结构化 @mention / 回复机器人最近发的消息 / `mentionPatterns` 正则匹配 | P0 |
| FR-11.7 | `access.json` 热加载 | 每条入站消息重读，policy 改动无需重启 | P0 |
| FR-11.8 | Static mode（`DISCORD_ACCESS_MODE=static`） | 启动时一次性快照，不写文件；pairing 自动降级为 allowlist | P1 |

### Epic 12: Safety & Data Hygiene（沿用上游）

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-12.1 | `assertSendable` 阻止 STATE_DIR 文件外发 | reply 的 files 数组里不能塞 STATE_DIR 内非 inbox/ 文件 | P0 |
| FR-12.2 | `safeAttName` 清洗附件名 | 替换 `[]\\r\\n;` 为 `_`，防 in-content 注解伪造 | P0 |
| FR-12.3 | 文件权限收紧 | `.env` / `access.json` / `routing.json` 写入时 0o600；STATE_DIR 0o700 | P0 |
| FR-12.4 | Skill 拒绝从 channel 驱动配置改动 | 在 `claude-discord-bot` 子命令的 SKILL.md 里明示并代码层不允许 | P0 |
| FR-12.5 | 错误信息不泄漏 token | 仅指向文件路径，不打印 token | P0 |

### Epic 13: CLI Installer

| ID | Story | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| FR-13.1 | `claude-discord-bot configure <token>` 写 token | mkdir + 写 `.env` + chmod 600；幂等 | P0 |
| FR-13.2 | `claude-discord-bot install` 写 launchd plist (macOS) | 探测 OS → 生成 plist 模板 → 写 `~/Library/LaunchAgents/` → `launchctl load` → 验证 | P0 |
| FR-13.3 | `claude-discord-bot install` 写 systemd unit (Linux) | 写 `~/.config/systemd/user/` → `systemctl --user enable --now` → 验证 | P0 |
| FR-13.4 | 安装脚本支持预演与原子失败 | `--dry-run` 选项打印将执行的操作但不写文件 / 不调 launchctl；apply 失败时回滚已做改动，不留半态（实现路径可参考 openclaw `daemon-install-plan`） | P1 |
| FR-13.5 | `claude-discord-bot uninstall` 反向 | 移除 plist / unit；停服务；幂等 | P0 |

## 12. Non-functional Requirements

### NFR-1 性能

| 指标 | 目标 | 来源 |
| --- | --- | --- |
| `/use` 切换响应 | < 1s 收到状态消息 | 成功标准 #3 |
| Workspace 注册延迟 | < 3s 出现在 `/list` | 成功标准 #2 |
| 离线检测延迟 | < 5s | 成功标准 #4 / NFR-2 |
| Daemon idle CPU | < 1% | 经验值 |
| Daemon idle 内存 | 50 workspace 满载 < 100MB | 经验值，含 ring buffer |

### NFR-2 可靠性

| 项 | 目标 |
| --- | --- |
| Daemon 连续运行 | 7 天无 kill -9 重启需求 |
| Discord 网关断 | 自动重连，含指数退避 + 抖动 |
| Discord rate limit | daemon 内部统一队列，命中限流时排队，不丢请求 |
| Plugin 断 | 自动重连含上限；上限内成功率 > 99% |
| 数据完整性 | normal ops 零消息丢失；异常时明确告知（不静默丢） |

### NFR-3 安全

- 文件权限：`.env`/`access.json`/`routing.json` 0o600；STATE_DIR 0o700
- assertSendable 防 STATE_DIR 内文件外泄
- safeAttName 防附件名注入
- access.json 热加载且配对码有 1h 过期
- 仅 `allowFrom` 中的 Discord user ID 能触发权限请求回应
- daemon 仅监听本地 socket（不开 TCP 公网端口）
- token 信息不进入 stderr / 错误消息

### NFR-4 可观测性

- Stderr 结构化日志（最低限度）：启动 / 连接 / 路由决策 / 异常 / 限流 / LRU 驱逐
- 日志级别可配（`CLAUDE_DISCORD_LOG_LEVEL=info|debug`）
- `status` 子命令暴露关键运行时指标
- Day-2 候选：JSONL 审计流（持久化 ring buffer 升级版）

### NFR-5 兼容性

| 平台 | 支持级别 |
| --- | --- |
| macOS（launchd） | 一等公民，MVP 必须 |
| Linux（systemd） | 二等公民，MVP 必须 |
| Windows | 不支持，post-MVP 候选 |
| Discord API | 当前主流（v10+） |
| Discord.js | 14.x |
| Claude Code | 当前主流版本（架构阶段确认 `--channels` 协议是否稳定） |

### NFR-6 资源边界

- Active workspace 软上限 50（可调，10-500）
- Ring buffer 50/workspace
- 单 Discord bot 连接（不开多 token）
- Pending pairing 上限 3
- 单 reply 最多 10 个附件，每个 25MB
- 文本 chunk 上限 2000（Discord 硬限）

### NFR-7 可测试性

- Unit：daemon 路由表、ring buffer、LRU、access policy 状态机、chunk 算法
- Integration：plugin↔daemon 协议握手、断连、重连、心跳
- E2E：从 CC 启动到手机 DM 路由到回复的完整链路（参考 openclaw 的 launchd integration test 思路）
- Live：用真实 Discord bot + 真实 CC 跑端到端

## 13. Open Questions / 留给架构阶段

1. **CC `--channels` 协议下能否拿到自启时机让 plugin 主动连 daemon？** 架构阶段必须验证；若不行，需要替代方案（如 `--mcp-config` 走自定义 MCP server，或者 fallback 到 spawn 子进程）
2. **Plugin↔Daemon 传输协议**：Unix domain socket / TCP localhost / MCP-over-socket？倾向 Unix socket（无端口冲突、本地 only）
3. **Workspace 标识 day-2 增强**：何时引入 CLAUDE.md project_name fallback / 用户级 alias 文件
4. **多设备 Discord**：手机 + 桌面同时打开同一账号在同一 channel 时会不会出现状态错乱？已知 Discord 不广播打字状态分设备，但 reaction / button 点击的双发可能性
5. **异常自愈具体策略**：CC 进程崩 / daemon 崩 / Discord 网关断 / plugin 心跳超时 → 各自的恢复路径
6. **Discord rate limit 命中时的退化策略**：纯排队 vs 排队 + 提示用户 vs ?
7. **运行时**：Node 18+ vs Bun？取决于 plugin SDK 在 CC 那侧能跑哪个

## 14. Roadmap / Milestones

### Day 30：骨架可跑

- Daemon 起得来；plugin 能 connect；routing.json 读写通；Discord 网关连得上
- 单条入站消息能从 Discord 路由到 plugin 再回到 Discord（hard-coded routing 也行）
- 日 P0 项：FR-1.1、FR-2.1、FR-2.2、FR-3.1、FR-3.4、FR-3.5
- 输出：alpha demo（不可发布）

### Day 60：MVP 体感

- Slash 命令全部可用（`/use` / `/last` / `/list` / `/which` / `/recent` / `/status`）
- Channel topic 切换 + 状态消息
- Ring buffer + 条件性自动展示
- LRU 容量管理
- 离线 UX
- 上游 5 个 MCP 工具等价
- 长内容展示规约（线程 + 附件 + edit）
- 沿用上游 access.json 鉴权 + pairing
- macOS launchd 安装脚本
- 输出：自用版本上线，作者本人切到 claude-discord 做日常

### Day 90：MVP 发布

- Linux systemd 支持
- Discord 权限问答双通道
- safety & 数据完整性 NFR 全过
- 7 天 soak test 通过
- 安装文档 + 快速上手
- 输出：开源公开（仓库 public），README 可读，能提 issue
