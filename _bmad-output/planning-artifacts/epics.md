---
project: claude-discord
date: 2026-05-06
author: Rong Shen
status: draft (epic + story breakdown, awaiting user review)
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
issue: jacobbubu/claude-discord (post-#5)
---

# claude-discord — Epic Breakdown

## Overview

PRD 的 §11 把 73 条 functional requirement 按**技术分层**（Daemon Lifecycle / Plugin SDK / CLI Installer 等）组织，方便规约。这份文档把同样 73 条 FR 重新按**用户价值**聚类成 6 个 epic（A 到 F），并把每个 FR 化为可领取的 story，加 Given-When-Then 验收。

两个文档的关系：

- PRD §11 是**规约视角**——FR-X.Y 是契约编号
- epics.md 是**实现视角**——Story X.Y 是开发任务编号
- 同一条 FR 可能落到一个 story（最常见）或拆成多个 story（如果颗粒度差太多）

## Epic 列表（按用户价值）

| 代号 | Epic | 用户价值（一句话） | 阶段 |
| --- | --- | --- | --- |
| **A** | First-Run Onboarding | 用户能从零装好系统、配 token、配对 Discord 身份、第一条消息打通 | Day 0-30（MVP 核心） |
| **B** | Multi-Workspace Routing | 用户能把多个 CC session 连入 Discord 多个 channel，并用 `/use` 切换 | Day 0-30（MVP 核心） |
| **C** | Conversational Tools | 用户从 Discord 发消息 → CC 回复，5 个 MCP 工具与长内容展示完整 | Day 0-60（MVP 核心） |
| **D** | Workspace Memory | 切回某 workspace 时能看到自己的最近上下文（`/recent` + 切换自动展示） | Day 30-60 |
| **E** | Lifecycle & Resilience | Daemon 7 天稳定运行；plugin 自动重连；workspace 容量管理 LRU；离线 UX | Day 30-90 |
| **F** | Discord-side Polish | 权限 Q&A 双通道；allowlist/disabled/static 模式；guild 频道 opt-in；mention 检测；installer dry-run | Day 60-90 |

## FR Coverage Map

73 条 FR 全部映射到 6 个 epic，无遗漏：

| Epic | FR ID | 数量 |
| --- | --- | --- |
| A | FR-1.1, FR-1.2, FR-1.4, FR-1.5, FR-2.1, FR-2.2, FR-3.1, FR-3.2, FR-3.4, FR-11.1, FR-11.4, FR-13.1, FR-13.2, FR-13.3 | 14 |
| B | FR-2.7, FR-2.8, FR-2.9, FR-3.3, FR-3.5, FR-3.6, FR-4.1, FR-4.2, FR-4.3, FR-4.4, FR-4.7, FR-4.8, FR-7.1, FR-7.2, FR-7.3, FR-7.4 | 16 |
| C | FR-2.5, FR-2.6, FR-5.1, FR-5.2, FR-5.3, FR-5.4, FR-5.5, FR-12.1, FR-12.2, FR-12.3, FR-12.4, FR-12.5 | 12 |
| D | FR-4.5, FR-8.1, FR-8.2, FR-8.3, FR-8.4 | 5 |
| E | FR-1.3, FR-1.6, FR-2.3, FR-2.4, FR-9.1, FR-9.2, FR-9.3, FR-9.4, FR-9.5, FR-10.1, FR-10.2, FR-10.3, FR-13.5 | 13 |
| F | FR-4.6, FR-6.1, FR-6.2, FR-6.3, FR-6.4, FR-6.5, FR-6.6, FR-11.2, FR-11.3, FR-11.5, FR-11.6, FR-11.7, FR-11.8, FR-13.4 | 14 |

总计：73 ✓

## Cross-Epic 依赖

Epic 之间的依赖关系（决定开发顺序）：

```
A (Onboarding) ───▶ B (Routing) ───▶ C (Tools) ───▶ D (Memory)
       │                  │                │
       └──────────────────┼────────────────┘
                          │
                          ▼
                   E (Resilience) ←──── F (Polish)
```

- A 是一切起点；B 依赖 A 的 daemon + plugin + access 链路
- C 依赖 B 的路由能力（消息要走对 channel）
- D 依赖 C（要先有消息流，才有 ring buffer 内容）
- E、F 可与 A-D 并行开发，但其 P0 部分（如 FR-1.6 daemon 稳定性、FR-2.4 plugin 重连）应在 MVP 发版前完成

---

## Epic A: First-Run Onboarding

**Goal**：用户从 npm install 一条命令开始，能在 30 分钟内走完"装 → 配 token → 配对 Discord → 收到 bot 第一句话"全流程。

### Story A.1 — 安装 daemon 为系统服务（macOS）

**As a** 用户，**I want** 一条命令把 daemon 注册为开机自启服务，**so that** 重启电脑后不用手动起。

**Acceptance Criteria**:

- **Given** 一台干净的 macOS 机器装了 Bun
- **When** 我跑 `claude-discord-bot install`
- **Then** plist 写到 `~/Library/LaunchAgents/com.jacobbubu.claude-discord-bot.plist`
- **And** `launchctl load` 成功
- **And** `claude-discord-bot status` 显示 daemon 在跑
- **And** 我重启机器后 daemon 自动起来

**Implements**: FR-13.2, FR-1.2

### Story A.2 — 安装 daemon 为系统服务（Linux systemd）

**As a** Linux 用户，**I want** 一条命令注册为 systemd user service，**so that** 不用手抄 unit 文件。

**Acceptance Criteria**: 同 A.1 但路径为 `~/.config/systemd/user/claude-discord-bot.service`，用 `systemctl --user enable --now`。

**Implements**: FR-13.3

### Story A.3 — 前台运行 daemon（开发态）

**As a** 开发者，**I want** 不装服务直接 `claude-discord-bot start`，**so that** 我可以快速 debug 和试 token。

**Acceptance Criteria**:

- **Given** daemon 二进制可用、`.env` 已写
- **When** 我跑 `claude-discord-bot start`
- **Then** daemon 前台运行，stderr 输出连接 Discord 的状态
- **And** Ctrl-C 干净关停（关 socket、关 Discord 连接、退出码 0）

**Implements**: FR-1.1, FR-1.5

### Story A.4 — 写 Discord token 到 .env

**As a** 用户，**I want** 通过 CLI 把 token 安全写到本地，**so that** 我不用手抄文件、不会留下 600 之外的权限。

**Acceptance Criteria**:

- **Given** 我从 Discord Developer Portal 拿到 token
- **When** 我跑 `claude-discord-bot configure MTIz...`
- **Then** `~/.claude/channels/discord/.env` 写入 `DISCORD_BOT_TOKEN=MTIz...`
- **And** 文件 mode 是 `0o600`，目录 mode 是 `0o700`
- **And** 命令输出提示需要重启 daemon

**Implements**: FR-13.1, FR-12.3

### Story A.5 — 首次 DM 触发配对码

**As a** 用户，**I want** 第一次 DM bot 时能拿到一个简短配对码，**so that** 我能在终端批准自己。

**Acceptance Criteria**:

- **Given** daemon 在跑、token 已配、access.json 是默认（`pairing` policy）
- **When** 我从 Discord DM bot 任意消息
- **Then** bot 回 `Pairing required — run in Claude Code: claude-discord-bot pair <6-hex-code>`
- **And** access.json 的 `pending` 增加一条该 senderId 的记录
- **And** 配对码 1 小时过期

**Implements**: FR-11.1

### Story A.6 — CLI 批准配对

**As a** 用户，**I want** `claude-discord-bot pair <code>` 能批准配对，**so that** bot 之后能正常处理我的 DM。

**Acceptance Criteria**:

- **Given** access.json `pending` 有未过期的码 `abc123`
- **When** 我跑 `claude-discord-bot pair abc123`
- **Then** access.json 的 `allowFrom` 加入对应 senderId
- **And** access.json 的 `pending[abc123]` 删除
- **And** `approved/<senderId>` 文件被 daemon 读到 → bot 在 DM 里发 "Paired! Say hi to Claude."
- **And** 文件被 daemon 读后删除

**Implements**: FR-11.4

### Story A.7 — Plugin 在 CC 启动时自动连 daemon

**As a** 用户，**I want** 一个 CC session 启动时 plugin 自动连接到我电脑上跑的 daemon，**so that** 不需要手工操作就能让该 workspace 出现在 Discord 一侧。

**Acceptance Criteria**:

- **Given** daemon 在跑、`.mcp.json` 注册了 plugin
- **When** 我在某项目目录跑 `claude --channels plugin:claude-discord`
- **Then** plugin 进程被 spawn
- **And** plugin 在 3 秒内连上 daemon socket
- **And** plugin 发 `register` 消息含 `agent: "claude-code"`、当前目录的 basename 作为 workspace name 候选
- **And** daemon 回 `register_ack` 含最终分配的 workspace name（撞名时加序号）
- **And** 该 workspace 在 daemon 的 `/list` 中可见

**Implements**: FR-2.1, FR-2.2, FR-3.2

### Story A.8 — Daemon 启动时初始化路由文件

**As a** daemon，**I want** 启动时确保所有状态文件存在且权限正确，**so that** 后续操作不出 ENOENT。

**Acceptance Criteria**:

- **Given** `~/.claude/channels/discord/` 不存在
- **When** daemon 启动
- **Then** 目录被创建，mode `0o700`
- **And** routing.json 不存在时按需创建（首次使用时）
- **And** access.json 不存在时按 `defaultAccess()` 行为处理（hot read fallback）
- **And** 没有 `.env` 时 daemon 退出 1 并指向文件路径

**Implements**: FR-1.4, FR-3.1, FR-12.3

### Story A.9 — 入站消息从 Discord 路由到 Plugin

**As a** 用户，**I want** 我在 Discord 上发的消息能被对应 workspace 的 CC 收到，**so that** 我能远程操作那个项目。

**Acceptance Criteria**:

- **Given** plugin 已注册成功，channel `#ai-1` 在 routing.json 中绑到 workspace `foo`
- **When** 我从 Discord DM 该 channel 发 "hello"
- **Then** daemon 收到 message → 查 routing → 查 active registry → 找到 `foo` 的 socket
- **And** daemon 通过 socket 发 `inbound` NDJSON 给 plugin
- **And** plugin 把它转为 MCP `notifications/claude/channel` 推给 CC
- **And** CC 端的 Claude 收到一个 `<channel>` 标签的消息

**Implements**: FR-3.4

### Story A.10 — Daemon `status` 命令

**As a** 用户，**I want** 查 daemon 是否健康，**so that** 在出问题时能快速诊断。

**Acceptance Criteria**:

- **When** 我跑 `claude-discord-bot status`
- **Then** 输出含：daemon PID（或"未运行"）、Discord 连接状态、active workspace 数、uptime

**Implements**: FR-1.4

---

## Epic B: Multi-Workspace Routing

**Goal**：当用户有 N 个活动 workspace 但 Discord 只有 M（< N）个 channel 槽位时，能用 `/use` 自由切换、用 `/list`/`/which`/`/last` 导航。

### Story B.1 — Slash 命令注册与 autocomplete

**As a** Discord 用户，**I want** 在 channel 里打 `/` 看到我们的 slash 命令并自动补全，**so that** 不用记命令名。

**Acceptance Criteria**:

- **Given** bot 已邀请到 server
- **When** daemon 启动
- **Then** 注册 `/use`、`/last`、`/list`、`/which`、`/recent`、`/status` 六个 application commands
- **And** `/use <workspace>` 的 workspace 参数支持 autocomplete，候选来自 active registry

**Implements**: FR-4.7

### Story B.2 — `/use <workspace>` 切换 channel 绑定

**As a** 用户，**I want** 在 channel 里发 `/use foo`，**so that** 之后这个 channel 的消息都路由给 foo。

**Acceptance Criteria**:

- **Given** workspace `foo` 在 active registry，channel `#ai-1` 当前绑定 `bar`
- **When** 我发 `/use foo`
- **Then** routing.json 的 `channels[#ai-1].workspace` 改为 `foo`
- **And** `channels[#ai-1].history` 把 `bar` 加到队首（用于 `/last`）
- **And** channel topic 改为 `[claude-discord] foo`
- **And** bot 在 channel 发 "✅ switched to foo"
- **And** 之后该 channel 的入站消息都路由给 foo

**Implements**: FR-4.1, FR-7.1, FR-7.2, FR-3.5

### Story B.3 — `/last` 切回上一个 workspace

**Acceptance Criteria**: 跟 B.2 类似，但 workspace 取自 `channels[<id>].history[0]`。

**Implements**: FR-4.2

### Story B.4 — `/list` 列活动 workspace

**Acceptance Criteria**:

- 输出按 last_activity 倒序
- 每行：`workspace name` + agent type 标签 + 在线/离线 + 上次活动相对时间（用 `<t:UNIX:R>`）

**Implements**: FR-4.3

### Story B.5 — `/which` 查当前绑定

**Acceptance Criteria**: 返回当前 channel 绑的 workspace + agent type + 上次活动 + 在线状态。

**Implements**: FR-4.4

### Story B.6 — Slash 命令鉴权

**Acceptance Criteria**:

- **Given** access.json `allowFrom` 不含 `interaction.user.id`
- **When** 该用户尝试任意 slash 命令
- **Then** bot ephemerally 回 "Not authorized."

**Implements**: FR-4.8

### Story B.7 — Channel topic 反映当前绑定

**Acceptance Criteria**: 见 B.2 的 topic 改写步骤。

**Implements**: FR-7.1

### Story B.8 — 沉默路由（没切就打字）

**Acceptance Criteria**:

- **Given** 用户在 channel 发非 slash 命令的普通消息
- **When** daemon 收到
- **Then** 直接路由给当前绑定，不弹确认、不猜测、不拒绝

**Implements**: FR-7.3

### Story B.9 — 历史交错不做隔离

**Acceptance Criteria**: channel 的历史允许混着多个 workspace 的消息；不开 thread、不 archive。

**Implements**: FR-7.4

### Story B.10 — Routing 改动热生效

**Acceptance Criteria**:

- **Given** daemon 在跑，routing.json 被外部进程修改
- **When** mtime 变化
- **Then** daemon 在 1 秒内通过 fs.watch 检测到，刷新内存视图
- **And** 下一条入站消息按新视图路由

**Implements**: FR-3.3

### Story B.11 — Plugin 干净断开标 workspace 离线

**Acceptance Criteria**:

- **Given** plugin 进程被 SIGTERM 或 stdin EOF
- **When** plugin close socket
- **Then** daemon 立刻把对应 workspace 标离线（5 秒内）
- **And** active registry 删除对应条目

**Implements**: FR-2.7

### Story B.12 — Plugin 注册时报 agent 与 capabilities

**Acceptance Criteria**:

- Plugin `register` 包含 `agent: "claude-code"`, `protocol_version: 1`, `capabilities: ["reply", "react", "edit_message", "fetch_messages", "download_attachment"]`
- daemon 据此存到 active registry 元数据
- daemon 不识别的 agent type → 拒接 + reason `"unknown_agent"`
- 协议版本不匹配 → 拒接 + reason `"protocol_mismatch"` + 期望版本

**Implements**: FR-2.8, FR-2.9, FR-3.6

---

## Epic C: Conversational Tools

**Goal**：CC 端的 Claude 能用 5 个 MCP 工具与 Discord 双向交互；长内容用合理形态展示；附件传输与防注入红线全部到位。

### Story C.1 — `reply` 工具：短消息内联

**As a** Claude（在 CC 里），**I want** 调 `reply` 工具发短文本到 Discord channel，**so that** 用户能看到我的回复。

**Acceptance Criteria**:

- **Given** plugin 已注册，CC 端 Claude 调 `reply` 工具，参数 `chat_id` + `text` < 2000 chars
- **When** plugin 收到调用
- **Then** plugin 发 `tool_call` NDJSON 给 daemon
- **And** daemon 通过 discord.js 发到对应 channel
- **And** daemon 回 `tool_result` 含 message id
- **And** plugin 把 result 通过 MCP 返给 CC

**Implements**: FR-2.5, FR-2.6, FR-5.1

### Story C.2 — `reply` 长文本分片

**Acceptance Criteria**:

- 文本超过 textChunkLimit（默认 2000，配置可调） → 按 chunkMode（length / newline）切片
- 多段消息按 `replyToMode`（off / first / all）应用 reply_to threading
- 全部成功后返回 message ids 列表

**Implements**: FR-5.1

### Story C.3 — `reply` 长内容自动选附件

**Acceptance Criteria**:

- 文本超过 4000 chars 且包含代码块 → 作为 `.md` 附件发出，主消息只放摘要
- 文本超过 25MB → 拒绝，返回错误
- 附件文件名可控制为 `result.md` / `output.md` 等

**Implements**: FR-5.2

### Story C.4 — `reply` 显式 thread 模式

**Acceptance Criteria**:

- 调用 `reply` 时 opts.kind = "trace" → 发到 message 的线程下而非主消息

**Implements**: FR-5.3

### Story C.5 — `reply` embed 模式

**Acceptance Criteria**:

- opts.kind = "summary" + 提供 title/fields → 发为 embed
- 不超过 6000 chars / 25 fields

**Implements**: FR-5.4

### Story C.6 — `edit_message` 流式进度

**Acceptance Criteria**:

- **Given** bot 之前发的某条消息 id
- **When** Claude 调 `edit_message` 多次更新进度
- **Then** Discord 端编辑同一条
- **And** 编辑不触发 push 通知（用户 Discord 文档已知）
- **And** 完成时 Claude 应另发新消息（这条 UX 由 Claude 自己掌握，不强制）

**Implements**: FR-5.5

### Story C.7 — `react` 工具

**Acceptance Criteria**: Unicode 直接传；自定义 emoji 用 `<:name:id>` 形式。

**Implements**: FR-2.5, FR-2.6

### Story C.8 — `fetch_messages` 工具

**Acceptance Criteria**:

- 默认 limit 20，max 100（Discord 硬限）
- 返回 oldest-first，每行带 message id
- 附件标 `+Natt`
- content 中的 `\r\n` 替换为 ` ⏎ ` 防伪造

**Implements**: FR-2.5, FR-2.6

### Story C.9 — `download_attachment` 工具

**Acceptance Criteria**:

- 把指定 message 的全部附件下载到 `~/.claude/channels/discord/inbox/`
- 文件名 `<ts>-<id>.<ext>`，扩展名经 `[^a-zA-Z0-9]` 清洗
- 单文件 > 25MB 时拒绝

**Implements**: FR-2.5, FR-2.6

### Story C.10 — `assertSendable` 防 STATE_DIR 文件外泄

**Acceptance Criteria**:

- **Given** Claude 调 `reply` 的 files 数组中含一个指向 STATE_DIR 内非 inbox 文件的路径（如 `~/.claude/channels/discord/access.json`）
- **When** plugin 把 tool_call 发给 daemon
- **Then** daemon 在发送前 realpath 校验，拒绝该调用
- **And** 错误返回 plugin → CC 端工具调用失败

**Implements**: FR-12.1

### Story C.11 — `safeAttName` 清洗附件名

**Acceptance Criteria**:

- 入站消息附件名替换 `[]\r\n;` 为 `_`
- 附件名只放 meta，不放 content
- 历史上传的"恶意附件名"被 fetch_messages 取回时也清洗

**Implements**: FR-12.2

### Story C.12 — Token / 文件权限不泄漏

**Acceptance Criteria**: 任何错误信息（stderr / tool_result error / Discord reply）只指向文件路径，不打印 token 内容。

**Implements**: FR-12.5

### Story C.13 — Skill 拒绝从 channel 驱动配置改动

**Acceptance Criteria**:

- CLI access 命令在文档顶部声明
- 实际代码层不接受任何"经 channel notification 转发回来"的命令调用（其实 CLI 本来就不在 daemon 进程里跑，但要确保设计里没漏洞）

**Implements**: FR-12.4

---

## Epic D: Workspace Memory

**Goal**：用户切回某 workspace 时能看到自己的最近上下文；长时间断线后切回不"上下文丢失"。

### Story D.1 — 每 workspace 50 条 ring buffer

**Acceptance Criteria**:

- daemon 内每 workspace 维护 50 条 RingEntry（ts / channelId / direction / textPreview ≤ 200 chars）
- 双向消息都进 ring buffer（user→workspace 与 workspace→user）
- 容量超出时 shift 最早的

**Implements**: FR-8.1

### Story D.2 — `/recent N` 命令

**Acceptance Criteria**:

- N 默认 3，min 1，max 5
- 输出按时间正序，每行带 `<t:UNIX:t>` 与 `<t:UNIX:R>` 时间戳
- 当前 channel 绑的 workspace 的 ring buffer 为空时，输出 "(no recent activity)"

**Implements**: FR-4.5, FR-8.2

### Story D.3 — `/use` 切换时条件性自动展示

**Acceptance Criteria**:

- 算法：buf 空 → skip；上次活动 < 15 min → skip；上次 channel == 当前 channel → skip；否则展示最近 3 条
- 自动展示与手动 `/recent` 输出格式一致

**Implements**: FR-8.3

### Story D.4 — Workspace 被驱逐时 ring buffer 清理

**Acceptance Criteria**: LRU 驱逐发生时同时清理 ring buffer，不留孤儿。

**Implements**: FR-8.4

---

## Epic E: Lifecycle & Resilience

**Goal**：daemon 7 天稳定运行；plugin 自动 reconnect；workspace 容量管理 LRU；离线 workspace UX；卸载干净。

### Story E.1 — Daemon 7 天 soak 测试

**Acceptance Criteria**:

- daemon 连续运行 7 × 24 小时无需 kill -9
- 内存占用稳定（不持续增长）
- 测试期间被注入 100 次 Discord 消息、20 次 plugin 重连、5 次 access.json 改动 → daemon 仍正常

**Implements**: FR-1.6

### Story E.2 — Plugin 心跳

**Acceptance Criteria**:

- plugin 每 10 秒发 heartbeat
- daemon 30 秒未收 heartbeat → close socket，标 workspace 离线

**Implements**: FR-2.3

### Story E.3 — Plugin 自动 reconnect

**Acceptance Criteria**:

- socket 断开 → plugin 按指数退避（300ms / 600ms / 1.2s / 2.4s / 5s 上限）重试
- 重连后重新握手注册
- 重试期间 MCP 工具调用返回错误 "daemon offline"

**Implements**: FR-2.4

### Story E.4 — Workspace 注册容量 soft cap

**Acceptance Criteria**:

- 默认 cap = 50，可由 `CLAUDE_DISCORD_WORKSPACE_CAP` 调整（10-500）
- trim target 默认 45，可由 `CLAUDE_DISCORD_WORKSPACE_TRIM_TARGET` 调整

**Implements**: FR-9.1

### Story E.5 — LRU 驱逐到 trim

**Acceptance Criteria**:

- registry size > cap → 按 last_activity_ts 升序驱逐到 trim
- 比较粒度 ms，相同 ms 用 Map 插入顺序作 tiebreaker

**Implements**: FR-9.2

### Story E.6 — 驱逐 = 清内存 + 关 socket

**Acceptance Criteria**:

- 驱逐 = 关 socket + 删 active registry 条目 + 清 ring buffer
- 不杀 CC 进程
- routing.json 不变

**Implements**: FR-9.3

### Story E.7 — 驱逐静默

**Acceptance Criteria**:

- 不发 Discord 消息
- daemon 日志（debug 级别）记录每次驱逐的 workspace name + last_activity_ts
- stderr 不出现 warn

**Implements**: FR-9.4

### Story E.8 — 驱逐后 plugin 重连无缝

**Acceptance Criteria**:

- 被驱逐 workspace 的 plugin 在收到 socket close 后按 E.3 reconnect
- 重连成功后 daemon 给它新的 active registry 条目（可能是新的 workspace name 序号）
- 用户视角：`/list` 短暂消失，再出现

**Implements**: FR-9.5

### Story E.9 — 离线 workspace 立即回执

**Acceptance Criteria**:

- **Given** channel 绑的 workspace `foo` 不在 active registry
- **When** 用户在 channel 发非 slash 消息
- **Then** bot 立即回 "foo 当前离线，请先在你的电脑上跑 CC"
- **And** 不排队、不缓存、不重试

**Implements**: FR-10.1

### Story E.10 — 在线检测 = stdio + heartbeat

**Acceptance Criteria**: 见 E.2 + B.11。

**Implements**: FR-10.2

### Story E.11 — 离线检测延迟 < 5 秒

**Acceptance Criteria**: CC 退出后，daemon 视图标离线在 5 秒内（来自 socket close 即时检测）。

**Implements**: FR-10.3

### Story E.12 — Daemon `uninstall`

**Acceptance Criteria**:

- 卸载 launchd plist / systemd unit
- 不删 state 文件（access.json / routing.json / .env），由 `reset --including-token` 单独控制
- 幂等：再跑一次不报错

**Implements**: FR-13.5, FR-1.3

---

## Epic F: Discord-side Polish

**Goal**：完整复刻上游 access 控制 + 权限 Q&A 双通道 + 高级 channel 模式（guild、static、disabled）+ installer 体感。

### Story F.1 — `dmPolicy = allowlist`

**Acceptance Criteria**: 陌生人 DM 静默丢；不回任何东西。

**Implements**: FR-11.2

### Story F.2 — `dmPolicy = disabled`

**Acceptance Criteria**: 全部丢，包括 allowFrom 与 guild 频道。

**Implements**: FR-11.3

### Story F.3 — Guild 频道 opt-in

**Acceptance Criteria**:

- `groups[<channelId>]` 控制 guild channel 是否参与
- 线程继承父 channel 的 opt-in
- 参数 `requireMention` + `allowFrom` 控制触发条件

**Implements**: FR-11.5

### Story F.4 — Mention 检测三路径

**Acceptance Criteria**:

- 结构化 @bot mention
- 回复机器人最近发的消息
- mentionPatterns 正则匹配（i 标志）

**Implements**: FR-11.6

### Story F.5 — Access.json 热加载

**Acceptance Criteria**: 每条入站消息重读 access.json；改动无需重启 daemon。

**Implements**: FR-11.7

### Story F.6 — Static mode

**Acceptance Criteria**:

- `DISCORD_ACCESS_MODE=static` → 启动时一次性快照 access.json，之后不读不写
- pairing 自动降级为 allowlist + stderr 警告

**Implements**: FR-11.8

### Story F.7 — Permission Q&A：CC → Discord 按钮

**Acceptance Criteria**:

- daemon 收到 plugin 转发的 `permission_request`
- 给所有 `allowFrom` 用户发 DM，含 "See more" / "Allow" / "Deny" 三按钮
- request_id 是 5 字母 a-km-z（手机自动纠错友好）

**Implements**: FR-6.1, FR-6.2

### Story F.8 — "See more" 展开

**Acceptance Criteria**:

- 点击 See more → 编辑消息追加 tool_name / description / pretty input_preview
- 保留 Allow / Deny 按钮，移除 See more

**Implements**: FR-6.3

### Story F.9 — 按钮回应 → permission notification

**Acceptance Criteria**:

- 校验 `interaction.user.id ∈ allowFrom`
- 通过校验后发 `permission` 通知给 plugin → CC
- 编辑消息为 "✅ Allowed" / "❌ Denied"，移除按钮

**Implements**: FR-6.4

### Story F.10 — 文本 `yes XXXXX` 回应

**Acceptance Criteria**:

- 正则 `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$` (i)
- 命中 → 不当聊天转发；对消息加 ✅/❌ react
- 发 `permission` 通知（同上）

**Implements**: FR-6.5

### Story F.11 — 仅 DM 路径参与权限请求

**Acceptance Criteria**: guild 频道明确不发权限请求 DM；该路径完全沿用上游单用户安全语义。

**Implements**: FR-6.6

### Story F.12 — `/status` 命令

**Acceptance Criteria**: 不带参数 = 当前 channel 绑的 workspace；带参数 = 指定 workspace；输出在线/离线 + 上次活动时间。

**Implements**: FR-4.6

### Story F.13 — `claude-discord-bot install --dry-run`

**Acceptance Criteria**:

- 打印将要执行的 plan（写哪些文件、跑哪些 launchctl 命令）
- 不真实写文件、不调 launchctl
- 退出码 0

**Implements**: FR-13.4

### Story F.14 — Install 失败时 atomic rollback

**Acceptance Criteria**:

- apply 步骤之一失败时，反向跑已成功步骤的 rollback
- 例：写 plist 成功 + launchctl load 失败 → 删除 plist
- 不留半态

**Implements**: FR-13.4

---

## 总结

| 项 | 数 |
| --- | --- |
| User-value epic | 6 |
| Story 总数 | 65（A:10 / B:12 / C:13 / D:4 / E:12 / F:14） |
| FR 覆盖数 | 73 / 73 ✓ |
| 平均 story 颗粒度 | 1-3 FR per story |
| MVP 必须 epic | A, B, C（核心循环） |
| MVP 应该 epic | D, E（恰到好处的体验 + 不崩） |
| MVP 优先级最低 epic | F（polish 与高级访问控制） |

下一步：sprint 规划 / 第一个开发 issue（Epic A 的 first-run 切片）。
