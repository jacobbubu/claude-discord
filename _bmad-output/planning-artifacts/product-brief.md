---
project: claude-discord
date: 2026-05-06
author: Rong Shen
status: draft (analyst phase output)
inputs:
  - docs/research/reference-plugin-capabilities.md
  - _bmad-output/brainstorming/brainstorming-session-2026-05-06-1645.md
issue: jacobbubu/claude-discord#3
---

# Product Brief: claude-discord

## 摘要

**claude-discord 是一个本机长驻的 agent gateway daemon，把开发者电脑上同时运行的多个 Claude Code workspace 路由到 Discord 上的少量 channel，让你从手机或桌面以一致的体验远程操作它们。** 它不是另一个 "Claude Code 的 Discord 插件"——上游官方插件已经做了"单 session × 单用户"的桥接；我们要解决的是另一类需求：**当你电脑上同时挂着 6 个项目的 CC，但 Discord 上只有 2 条 channel 槽位可用时，怎么把"切换工作环境"做得像 tmux 切 pane 一样自然**。

技术上，我们走 openclaw 那一脉——**daemon + plugin-sdk + cli installer + launchd**——但只聚焦 Discord × Claude Code 这一条路径，把 channel-as-slot 路由、`/use` UX、Lark Drive 集成、Discord 权限问答这些细节做到上游和 openclaw 同名 channel 里都没有的精致度。MIT 许可证，私有起步，公开后做 OSS。

## 问题

**多 workspace 是开发者的常态，不是边缘场景。** 一个稍微活跃的开发者电脑上同时挂着主项目、副业、写作工程、玩具实验，每个项目一个 Claude Code session，每个 session 都希望能"在通勤路上手机上推一句话就跑起来"。

**现有方案在多 workspace 上失能**：

- **官方 Discord 插件**走"每个 CC session 自己 spawn 一个 MCP 子进程"。N 个项目要 N 个 Discord application、N 个 token、N 次 `/discord:configure`。运维负担线性增长到 5 个项目以上就开始痛。
- **完全转移到云端 IDE / 远程开发**是另一个方向，但代价是放弃本地工作流（CLAUDE.md、文件系统、本机命令、LLM 调用账号绑定）。
- **不上 bridge，纯本地用 CC**则丢掉了"离开桌子也能继续"这件事——而手机操作 AI agent 已经不是奢侈，是日常。

**痛点的具体形态**：你在地铁上突然想到某个项目应该跑个测试，或者跑个 PRD 草稿，或者把昨晚遗留的 bug 让 Claude 接着分析。打开 Discord，找不到对应那个项目的 channel；找到了不知道这个 channel 现在指着哪个 workspace；想切个 workspace 没有命令——这套体验今天不存在。

## 解决方案

**核心动作**：你电脑上跑一个 daemon（开机自启），任何 Claude Code session 启动时通过我们的 plugin **自动连接到 daemon**，daemon 把这个 workspace 加进活动列表。Discord 上你有 M（通常 2-3）个 channel，每个 channel 是一个**槽位**，当前绑着哪个 workspace 由 channel topic 写明。

**典型一天**：

- 8:50 走出家门，打开 Discord 手机端，channel `#ai-1` 的 topic 写着 `claude_discord`（昨晚最后用的那个）。
- 你打 `/list` 看到当前在线的 6 个 workspace（按注册时间倒序），找到 `myproject`。
- `/use myproject` → channel topic 改写，bot 回 "✅ switched to myproject"。
- "帮我看下 server.ts 里的那个超时逻辑"——消息走到 myproject 这个 CC session，Claude 处理，输出走线程回复（细节）+ 一条主消息（结论）。
- 想把生成的设计文档发给同事？对那条消息 react 一个 📤，bot 上传到飞书 Drive，把链接编辑回原消息。
- 中午到公司换桌面继续，Discord 状态完全延续——daemon 没动过，workspace 全都还在线。
- 切到另一个项目：`/use bar`，topic 变了，从此这个 channel 上全发给 `bar`，直到下一次 `/use`。
- 晚上想接着上午的 myproject 思路继续？`/use myproject`，bot 自动展示 myproject 自己的最近 3 条消息（带原始时间戳），上下文一眼回笼——不用去翻 channel 历史里其他 workspace 的对话杂音。

**长任务、流式进度、Discord 权限问答（"yes XXXXX" 文本回复 + 按钮双通道）、附件回传**——这些上游已经有的，我们继承，不重新发明。

## 与现有方案的差异

| | 上游官方插件 | openclaw | claude-discord |
| --- | --- | --- | --- |
| 进程模型 | 每 session 一个子进程 | 单 daemon 多 channel | **单 daemon 单 channel 多 workspace** |
| Channel 数量 | 1 bot 服务 N channel | 各种 channel 都接 | M < N，**channel 是槽位** |
| 切换 workspace UX | 没这概念（1:1） | 多种 channel 各自有 | **`/use` + `/last` 显式切换** |
| Lark 集成 | 无 | 通用 Lark plugin | **Discord ⇄ Lark 深度路径**（react 触发） |
| 安装 | per-session MCP | daemon-install-plan | **抄 openclaw 套路，scope 收紧** |
| 多 agent 支持 | Claude only | 多 agent | **协议留扩展点，day 1 Claude only** |

**真正的护城河是"聚焦"**：openclaw 因为接得多，每个 channel 都只能做到中位；我们因为只接 Discord，能把 Discord 的 slash 命令、按钮、react、thread、embed 这些**原生能力榨干**到 openclaw 没空做的程度。

## 服务的人

**主要用户**：拥有 3 个以上活跃 Claude Code 项目的资深独立开发者——

- 自己一个人持有 1-3 个 Claude 订阅 / 账号；
- 经常在地铁、咖啡馆、不同电脑之间切换工作场景；
- 对开发者 CLI 工具有耐心（`launchctl`、`brew services`、命令行 install 不会劝退）；
- 已经在用 Discord 作为个人通讯/小组工具；
- 用飞书做团队协作（Lark Drive 集成对他们是真需求）。

**不服务的人**：

- 团队/企业用户（不做协作权限模型）；
- 只有 1 个项目的轻度用户（上游插件已经够用）；
- 不熟悉命令行 install 的纯 GUI 用户（MVP 阶段）。

## 技术路径（高层）

- **Daemon**：Node + TypeScript，singleton 进程，单 Discord 连接，本机 socket 接受 plugin 连接，内部维护 routing/活动表。
- **Plugin**：CC plugin 用我们的 plugin-sdk，CC 启动自动连接 daemon、握手、注册 workspace。
- **CLI**：`claude-discord-bot start | install | uninstall | status`。`install` 写 launchd plist（macOS）或 systemd unit（Linux），开机自启。参考 openclaw `dist/daemon-install-plan.shared`、`daemon-install-helpers`、`gateway-install-token` 的现成路线。
- **协议**：Plugin↔Daemon 协议层 day 1 引入 `agent: "claude-code"` 字段和 capability 协商，留好 Codex/其他 agent 接入的扩展点；day 1 实现仅 Claude。
- **状态文件**：`~/.claude/channels/discord/routing.json`（路由）+ `access.json`（许可，沿用上游设计）+ `.env`（token），权限 `0o600`。
- **限流**：daemon 内部对 Discord API 调用做集中排队，避免多 CC 同时输出时打爆 Discord rate limits。
- **消息回看（per-workspace 环形缓冲）**：daemon 内每个 workspace 留 50 条最近交互的内存 ring buffer（含原始 timestamp、channel id、方向），daemon 重启即丢，不持久化。`/recent N` 命令读取展示，`/use` 切换时按必要性算法（时间阈值 15 分钟、同 channel 跳过、空 buffer 跳过）条件性自动展示。这条同时为日后扩展成持久化 audit log 留了路径。
- **Daemon 注册表容量**：soft cap 50 个活动 workspace（可由 `CLAUDE_DISCORD_WORKSPACE_CAP` 调整）。超出时按 LRU 驱逐到 45，被驱逐 workspace 的 socket 关闭，plugin 自动 reconnect 重新注册。完全静默（无 Discord 噪声、仅 daemon 日志记录）。routing.json 不受影响——驱逐只清内存 view，不动持久化绑定。

## 成功标准

**首版（MVP，Day 90）算成功的判据**：

1. **Daemon 稳定性**：连续运行 7 天不需要 kill -9。
2. **Workspace 注册延迟**：CC 启动到 `/list` 里出现 < 3 秒。
3. **`/use` 切换响应**：< 1 秒收到 "✅ switched"。
4. **离线检测**：CC 退出到 daemon 标离线 < 5 秒。
5. **Lark 上传成功率**：在网络正常时 > 95%。
6. **零数据丢失**：normal ops 下不丢消息（异常下要明确告知）。
7. **作者自用满意度**：作者本人放弃 raw `claude` + 原版 plugin，全切到 claude-discord 做日常。

**比指标更重要的判据**：是否有第二个用户（朋友 / 关注的开发者）愿意自己装、用一周、提 issue。如果有，说明产品形态对路；没有，说明问题虚构。

## 范围

**In scope（MVP 必须有）**：

- Daemon + plugin-sdk + CLI installer
- Discord 单 bot 多 channel × N workspace 路由
- `/use`, `/last`, `/list`, `/which`, `/status`, `/recent` 等 slash 命令（`/recent N` 默认 3，max 5）
- Channel topic + 切换状态消息
- 上游 5 个 MCP 工具的等价实现（reply / react / edit_message / fetch_messages / download_attachment）
- 长内容展示规约（线程/附件/embed/edit）
- Lark Drive 集成（react 触发，opt-in）
- Discord 权限问答（按钮 + `yes XXXXX` 文本）
- 沿用上游的 pairing/allowlist 鉴权
- launchd / systemd 安装脚本

**Out of scope（明确不做）**：

- 计费 / 配额 / 账户管理
- 远程拉起 CC（用户自己启动）
- Slash 命令直通 workspace shell
- 消息队列 / 离线缓冲（离线立即回执）
- Discord-as-DB（不把 pinned message 当配置存储）
- 多用户协作权限模型
- 跨平台 hub（不再做 telegram / slack / signal 那些）
- 远程 daemon（daemon 必须和 CC 在同一台机器）

## 关键假设与待回答

1. **CC 端是否能稳定写 plugin**：`claude --channels` 协议下能否拿到自启时机让 plugin 主动连 daemon？需要 architect 阶段验证。
2. **Plugin↔Daemon 传输**：Unix socket / TCP localhost / MCP-over-socket 哪个最干净？BMAD 架构师阶段的事。
3. **Workspace 标识的 day-2 增强**：basename + 自增能撑多久？什么时候需要 CLAUDE.md project_name fallback？
4. **多设备 Discord**：手机 + 桌面同时打开，state 会不会冲突？
5. **Audit / 日志**：要不要做本机 JSONL 审计流？brainstorming 时未深入。
6. **BMAD 联动**：研究文档候选过"BMAD 工作流挂钩"——保留可能性，但 MVP 不实现。
7. **异常自愈**：CC 崩、daemon 崩、网络断时的具体策略——PRD/架构阶段细化。
8. **Lark 深度**：auth 方式、文件夹路由、命名约定——MVP 取最简（一个 token、一个 folder），后续再丰富。

## 三年愿景

- **Year 1**：稳定可用的 Discord × Claude Code daemon，开源，有第二批用户。
- **Year 2**：协议扩展到 Codex 等其他 CLI agent，Discord 仍是首要 UI。Plugin-sdk 公开，让其他 channel（IRC、Matrix）作为社区贡献接入。
- **Year 3**：成为"个人开发者多 agent 多 workspace 远程操作"这一品类的 reference implementation——它到了那里，意味着我们没成为 openclaw 的子集，而是探出了"窄而深"的另一条路。
