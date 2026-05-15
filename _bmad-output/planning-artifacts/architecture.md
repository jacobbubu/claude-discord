---
project: claude-discord
date: 2026-05-06
author: Rong Shen
status: draft (architect phase output, awaiting user review)
workflowType: architecture
inputDocuments:
  - docs/research/reference-plugin-capabilities.md
  - _bmad-output/brainstorming/brainstorming-session-2026-05-06-1645.md
  - _bmad-output/planning-artifacts/product-brief.md
  - _bmad-output/planning-artifacts/prd.md
issue: jacobbubu/claude-discord#5
---

# Technical Architecture — claude-discord

## 1. Executive Summary

claude-discord 的架构由三种进程构成：**Daemon**（singleton 长驻进程，机器一份），**Plugin**（CC 进程内的子进程，每个 CC session 一份），以及 **CLI**（启动 / 安装 / 卸载 / 状态查看的命令行入口）。Plugin 同时承担两个角色：对 CC 走 MCP stdio 协议（实现 reply/react/edit/fetch/download 五个工具的 server side），对 daemon 走 Unix domain socket + NDJSON（转发工具调用与入站消息）。Daemon 是真正的"业务大脑"——维护 Discord 网关连接、路由表、活动注册表、ring buffer、限流队列、安装管理。

整个架构本质是 openclaw 同名模块的"聚焦子集"：只接 Discord、只服务 Claude Code（day 1）、协议层留 agent 字段以备 Codex 接入。运行时 **Bun 1.x**（与上游官方插件一致）+ TypeScript；零编译开发流，`bun build` 出 dist；vitest 跑测试；oxlint / oxfmt 走开发工具链；installer 抄 openclaw daemon-install-plan + gateway 启动控制脚本路线。

本文档是开发阶段的蓝图——所有 PRD 的 73 条 FR 在这里都能映射到具体模块、协议消息、文件位置或测试策略。

## 2. Inputs & Source Traceability

| 输入 | 用途 |
| --- | --- |
| `_bmad-output/planning-artifacts/prd.md` | 73 FR + 7 NFR 的根本来源；每个架构模块都对应一组 FR |
| `_bmad-output/planning-artifacts/product-brief.md` | 产品定位、差异化、scope 边界（架构不能擅越） |
| `_bmad-output/brainstorming/brainstorming-session-2026-05-06-1645.md` | 设计选择 A-O 的决策原因；遇到歧义时回这里查 |
| `docs/research/reference-plugin-capabilities.md` | 上游 5 工具协议、access 控制、防注入红线——架构层必须沿用 |
| `/Users/rongshen/github/openclaw/` | 实现路线参考：daemon-install-plan / launchd integration / keyed-async-queue / gateway 心跳 |

## 3. High-level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  USER MACHINE                                                        │
│                                                                      │
│  ┌────────────────────┐                                              │
│  │  Claude Code       │                                              │
│  │  (workspace foo)   │                                              │
│  │                    │                                              │
│  │  ┌──────────────┐  │   MCP stdio   ┌────────────────────┐         │
│  │  │  CC core    ◀┼──┼───────────────▶ Plugin (subprocess)│         │
│  │  └──────────────┘  │   (tool calls)│  (claude-discord-  │         │
│  │                    │               │   plugin)          │         │
│  └────────────────────┘               │                    │         │
│                                       │  Unix domain socket│         │
│  ┌────────────────────┐               │  + NDJSON          │         │
│  │  Claude Code       │               │   ▲                │         │
│  │  (workspace bar)   │               │   │                │         │
│  │  + Plugin          ├───── socket ──┼───┘                │         │
│  └────────────────────┘               │                    │         │
│                                       └─────────┬──────────┘         │
│                                                 │                    │
│                                                 ▼                    │
│                       ┌────────────────────────────────────────┐     │
│                       │  Daemon (singleton, launchd / systemd) │     │
│                       │  ┌─────────────────────────────────┐   │     │
│                       │  │ socket server (NDJSON)          │   │     │
│                       │  │ active registry (≤50 ws, LRU)   │   │     │
│                       │  │ ring buffer (50/ws)             │   │     │
│                       │  │ routing table (in-memory)       │   │     │
│                       │  │ outbound queue (Discord limits) │   │     │
│                       │  └─────────────────────────────────┘   │     │
│                       │              ▲                         │     │
│                       │              │                         │     │
│                       │  state files (routing.json /           │     │
│                       │   access.json / .env, 0o600)           │     │
│                       └──────────────┼─────────────────────────┘     │
│                                      │                               │
│                                      │ discord.js                    │
└──────────────────────────────────────┼───────────────────────────────┘
                                       │
                                       ▼ Discord Gateway (single bot)
                                  ┌────────────┐
                                  │  Discord   │
                                  │  channels  │
                                  └────────────┘
```

**信息流**：

- **Discord → CC**：Discord 消息 → daemon 网关 → 查 routing → 查 active registry → 经 socket 发 plugin → plugin 通过 MCP `notifications/claude/channel` 推给 CC
- **CC → Discord**：CC 调工具（reply 等） → plugin 通过 MCP 收到 → 经 socket 发 daemon → daemon 入限流队列 → 调 Discord API → 完成回 plugin → plugin 通过 MCP 返工具结果给 CC

**plugin 是 thin proxy**——除了 MCP↔socket 的双向桥接，不在自己进程里实现路由、限流、ring buffer 之类的"daemon 业务"。这条原则保证 plugin 升级与 daemon 升级解耦。

### 3.1 ADR — 为什么不沿用上游 1:1 模型

**Context**：上游 `claude-plugins-official/discord` 是 1 个 MCP server 进程对应 1 个 CC session（spawn from `claude --channels plugin:discord`），整个文件 ~900 行做完了 Discord 客户端 / 访问控制 / 配对 / 消息桥 / MCP 工具五件事。

**Decision**：我们引入 daemon + plugin 两进程拆分（CLI 第三类无状态进程不计），plugin 作为 thin proxy。

**Rationale**：

- 多 workspace 场景下（N 个 CC project），1:1 模型意味着 N 个 token / N 个 Discord application / N 套独立访问控制。运维成本随项目数线性上升，5+ 项目就开始痛
- daemon 作为本机单例长驻进程，可以多路复用 1 个 Discord bot 跨 N workspace，配合 channel-as-slot + `/use` 切换 UX
- daemon 集中持有 active registry / ring buffer / 限流队列，这些不能做成 per-CC-session（重启 CC 不应丢上下文）
- agent-extensibility（codex 等）需要协议层抽象，plugin↔daemon 之间的 NDJSON 协议是这个抽象的承载

**Consequences**：

- 引入新基础设施：NDJSON 协议、Unix socket、plugin reconnect、LRU、launchd/systemd installer
- 上游的"密度的胜利"（一个文件可读完所有逻辑）不再，需要靠模块化 + 类型 + 注释保持可读性
- plugin 升级需独立于 daemon 兼容（见 §19）

参见 `docs/research/upstream-architecture-deep-dive.md` §4.1。

## 4. Process & Lifecycle Model

### 4.1 Daemon

| 阶段 | 行为 |
| --- | --- |
| 启动 | 读 `~/.claude/channels/discord/{.env, access.json, routing.json}`；token 缺失即 `exit 1` 与 stderr 提示文件路径；Discord client 登录；监听 Unix socket（默认 `~/.claude/channels/discord/daemon.sock`） |
| 运行 | 接 plugin 连接、维持心跳、接 Discord 网关、跑限流队列；`unhandledRejection`/`uncaughtException` 全局兜底打 stderr 不退出 |
| 关停 | 接 SIGTERM / SIGINT / stdin EOF（被 launchctl unload 时） → 关 socket server → 拒绝新 plugin 连接 → 现有 plugin 收到 `bye` 后自行 reconnect 退避 → `client.destroy()` Discord → 2s 兜底 hard exit |

### 4.2 Plugin（CC 子进程）

| 阶段 | 行为 |
| --- | --- |
| 启动 | CC spawn，读 stdio MCP，连 daemon socket；连接失败按指数退避重试（300ms / 600ms / 1.2s / 2.4s / 5s 上限），重试期间 MCP 工具返回 `daemon offline` 错误 |
| 握手 | 发 `register` 含 `agent: "claude-code"`, `protocol_version`, `capabilities`, `cwd`, `pid`；daemon 回 `register_ack` 含 `workspace_name`（可能是 cwd basename + 序号） |
| 运行 | MCP server 暴露 5 个工具；socket 收到 `inbound` 转换为 MCP `notifications/claude/channel`；socket 收到 `tool_result` 解 unblock 之前的工具调用；每 10s 心跳 |
| 关停 | CC stdin EOF → close socket → exit；socket 提前断 → 重连，重连失败超 N 次后 plugin 自行退出（CC 看到 MCP 关闭也会响应处理） |

### 4.3 CLI（claude-discord-bot）

无状态命令行工具，子命令分四组（详细 UX 见 §10.4 / §10.5）：

**运行控制**：
- `start` — 前台运行 daemon
- `dev` — 前台 + 文件监听自动重启（开发态）
- `reset [--routing|--inbox|--pending|--all|--including-token]` — 清状态后重启
- `restart` — stop + start
- `stop` — 停服务（不 uninstall）
- `logs [-f]` — tail daemon 日志

**生命周期管理**：
- `install [--platform=auto|launchd|systemd] [--dry-run]` — 注册系统服务
- `uninstall` — 反向卸载
- `status` — 查 daemon 健康

**配置**：
- `configure <token>` — 写 `.env`

**Access 控制（沿用上游 access skill）**：
- `pair <code>` / `deny <code>` / `allow <id>` / `remove <id>` / `policy <mode>` / `group add/rm <channelId>` / `set <key> <value>`

## 5. Transport Decision — Unix Domain Socket + NDJSON

**选择**：Unix domain socket（macOS / Linux）+ JSON line-delimited (NDJSON) wire format。

### 5.1 候选与权衡

| 候选 | 优点 | 缺点 | 决策 |
| --- | --- | --- | --- |
| **Unix domain socket** | 无端口冲突；本机 only（隐含安全）；性能好；可拿 peer credentials；POSIX 标准 | Windows 不支持（用 Named Pipe 替代）——但 MVP 不做 Windows | ✅ **选用** |
| TCP localhost | 跨平台一致；调试方便（telnet） | 端口冲突；本机其他用户能访问；防火墙复杂 | ❌ |
| MCP-over-socket（用 MCP SDK 但走 socket transport） | 协议复用；plugin 端代码可少写一些 | MCP transport 抽象绑死了 stdio 模型，扩展非平凡；引入 MCP SDK 依赖到 daemon 是不必要的耦合 | ❌ |
| HTTP / Hono | 已熟工具链；可远程；中间件丰富 | 远程不在 scope；增加 framework 依赖；本地通信用 HTTP 是 overkill | ❌ |

### 5.2 NDJSON wire format

**NDJSON = Newline Delimited JSON**：每条消息是一行完整 JSON，以 `\n` 分隔。读端按 `\n` 切分逐行 parse。无需消息长度前缀、无需 framing 协议、无需任何 framework。`nc -U daemon.sock` 直接收发肉眼可读。

```
{"type":"register","v":1,"agent":"claude-code"}\n
{"type":"register_ack","v":1,"workspace":"foo"}\n
{"type":"inbound","v":1,"chat_id":"123","content":"hello"}\n
```

**为什么 UDS + 自定义 NDJSON，而不是 MCP-over-socket**：

| 维度 | UDS + NDJSON | MCP-over-socket |
| --- | --- | --- |
| 协议自由度 | 自定义 schema，`register` / `evicted` / `permission_request` 等 daemon 主动通知都自然 | MCP 是 server↔client 请求/响应模型，硬塞 daemon 主动通知是 hack |
| 依赖耦合 | daemon 不依赖 `@modelcontextprotocol/sdk` | daemon 必须装 MCP SDK，仅为复用 transport |
| 调试 | `nc -U socket.sock` 直接看 NDJSON | 需要 MCP 解码 |
| Plugin 端代码量 | 一份 socket client + 一份 MCP server，互转 | 看似复用 SDK，但要写 SocketTransport adapter，差不多 |
| 升级与扩展 | NDJSON 第一条 register 携带 v + capabilities，自然演化 | 受 MCP SDK 升级节奏约束 |

比 framed binary 简单，比纯 binary 易调试，比 SSE/HTTP 轻。Hono / Express 等 framework 全部不需要。

```jsonc
// register
{"type":"register","v":1,"agent":"claude-code","cwd":"/Users/x/proj/foo","pid":12345,"capabilities":["reply","react","edit_message","fetch_messages","download_attachment"]}

// register_ack
{"type":"register_ack","v":1,"workspace":"foo","server_capabilities":["reply","react","edit_message","fetch_messages","download_attachment","permission_request"]}

// heartbeat
{"type":"heartbeat","v":1}

// inbound (daemon→plugin)
{"type":"inbound","v":1,"chat_id":"123","message_id":"456","user":"someone","user_id":"789","ts":"2026-05-06T08:50:00Z","content":"...","attachments":[...]}

// tool_call (plugin→daemon)
{"type":"tool_call","v":1,"id":"tc-001","tool":"reply","args":{"chat_id":"123","text":"ok","reply_to":"456"}}

// tool_result (daemon→plugin)
{"type":"tool_result","v":1,"id":"tc-001","ok":true,"result":"sent (id: 789)"}
```

**Wire format 规则**：

- 每条消息必须含 `type` 与 `v`（schema version）
- `v: 1` 是首版；`v: 2` 引入时新旧 daemon/plugin 都拒接对方非匹配版本（详见 §19）
- 长度限制：单行 ≤ 1MB（attachment 不走这条通道，走 Discord 上传/下载）
- 编码：UTF-8

## 6. Protocol Schema

### 6.1 消息类型表

| 方向 | type | 关键字段 | 用途 |
| --- | --- | --- | --- |
| P→D | `register` | agent, v, cwd, pid, capabilities | 握手注册 |
| D→P | `register_ack` | workspace, server_capabilities, v | 握手确认 |
| D→P | `register_reject` | reason | 拒绝（capacity 满 / 协议版本不兼容 / agent 不识别） |
| P↔D | `heartbeat` | — | 心跳（每 10s） |
| D→P | `inbound` | chat_id, message_id, user, content, attachments | Discord 入站消息 |
| P→D | `tool_call` | id, tool, args | CC 调工具 |
| D→P | `tool_result` | id, ok, result/error | 工具返回 |
| D→P | `permission_request` | request_id, tool_name, description, input_preview | Claude 权限请求中继 |
| P→D | `permission` | request_id, behavior | 权限响应（允许/拒绝） |
| D→P | `evicted` | reason | LRU 通知（plugin 收到立刻 close socket，进入 reconnect） |
| D→P | `bye` | reason | daemon 关停时通知 |

### 6.2 握手序列

```
plugin → daemon : register
                  ↓
                  daemon 检查：
                    - protocol version 兼容？否则 register_reject reason="protocol_mismatch"
                    - agent 已知？否则 register_reject reason="unknown_agent"
                    - active registry 容量？满则触发 LRU 驱逐到 45（§13）
                  ↓
                  分配 workspace name（cwd basename，撞名 +序号）
                  ↓
daemon → plugin : register_ack {workspace, server_capabilities}
                  ↓
                  plugin cache 这个名字，从此用它
```

### 6.3 心跳

- Plugin 每 10s 发 `heartbeat`；daemon 不必回（被动监听）
- Daemon 每 30s 扫所有连接，最近 30s 没收到 heartbeat 的视为 stale → close socket → 标离线
- 心跳 same-line 与业务消息共享 socket，daemon 任何收到的消息都刷新 last_activity

### 6.4 错误传播

- 所有 `tool_call` 必有对应 `tool_result`；超时 60s 由 plugin 端兜底返回 `error: "timeout"`
- `tool_result.error` 是字符串描述；plugin 不分类，直接转给 CC 作为 MCP tool error
- Plugin 收到无法解析的消息（非 JSON / 缺 type / v 不匹配） → 记 stderr，不 crash

## 7. Plugin ↔ CC Integration（via MCP）

### 7.1 上游 `.mcp.json` 模式

参考 `external_plugins/discord/.mcp.json`：

```json
{
  "mcpServers": {
    "discord": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

CC 启动时按这个声明 spawn 子进程；子进程的 stdin/stdout 是 MCP 协议通道。

### 7.2 我们的 `.mcp.json`

```json
{
  "mcpServers": {
    "claude-discord": {
      "command": "bun",
      "args": ["run", "${CLAUDE_PLUGIN_ROOT}/dist/plugin.js"]
    }
  }
}
```

`plugin.js`（编译后产物）启动后：

1. 创建 `Server` from `@modelcontextprotocol/sdk`，注册 5 个工具的 `setRequestHandler`
2. 每个工具的 handler 实现：发 `tool_call` 到 daemon socket，等 `tool_result`，把 result 作为 MCP tool 响应返回
3. 同时维持一个独立的"socket inbound 监听 loop"：daemon 推 `inbound` 时，调用 `mcp.notification({method:"notifications/claude/channel", params:...})`
4. plugin 与 daemon 的 socket 在 plugin 启动时连接、断开时按指数退避重连

**这一步的关键论证**：plugin 是 CC 的子进程，CC 控制 plugin 的 stdin/stdout（MCP 协议层）。plugin 自己控制 outbound socket（向 daemon）。这是两个独立 IO 流，互不阻塞。Bun 事件循环可以同时处理。验证不需要新协议——上游已经证明 MCP-as-subprocess 工作。

### 7.3 Spike 验证（开发阶段第一周）

写一个 50 行原型 plugin：spawn 一个能响应 `reply` 工具调用的 plugin，转发到一个 echo 服务（不是真 daemon），看 CC 能不能正常调用并收到结果。这个 spike 同时验证 `.mcp.json` 在我们插件包结构下是否生效。开发阶段 issue 单开（详见 §20）。

## 8. Runtime & Tooling

| 选项 | 选用 | 备注 |
| --- | --- | --- |
| 语言 | TypeScript 5.9+ | 类型安全 |
| 运行时 | **Bun 1.x** | 与上游一致；内置 TS 解析（不需要 tsx）；内置 bundler（不需要 tsdown）；fetch / fs / crypto 都是 Web 标准 |
| 包管理 | Bun 内置（兼容 npm 包） | 不需要单独装 pnpm |
| 开发态 | `bun run src/daemon/index.ts` | 直接跑 .ts，零编译 |
| 监听重启 | `bun --watch src/daemon/index.ts` | 内置 watch |
| 生产打包 | `bun build src/daemon/index.ts --target=bun --outdir=dist` | 单文件或多文件输出 |
| 测试 | vitest（首选）或 `bun test` | vitest 兼容 Bun；`bun test` 更快但生态小 |
| 格式化 | oxfmt 或 prettier | 任选 |
| Lint | oxlint | 与 openclaw 一致 |
| Discord client | discord.js 14.x | 与上游一致 |
| MCP SDK（plugin 端） | `@modelcontextprotocol/sdk` ≥ 1.0 | 仅 plugin 用，daemon 不需要 |
| 配置 schema | zod | 与上游一致 |
| 日志 | tslog 或 pino | 结构化 stderr |

**为什么 Bun 而不是 Node**：

- 上游官方 Discord 插件就是 Bun，开发者已经装过；plugin 端可继承
- 零编译开发流：改 .ts 直接 `bun run` / `bun --watch`
- `bun build` 替代 tsdown / esbuild，一行命令产 dist
- 与 openclaw 选 Node 不同——但 openclaw 选 Node 主要是因为它的 plugin SDK 要给海量第三方 channel 用，需要最大兼容性。我们 scope 收紧到单 channel，可以拥抱 Bun
- launchd / systemd 启动 Bun 进程没有任何已知障碍，与 Node 等价处理

**tsdown 是什么**：tsdown 是基于 Rolldown（Rust）的 TypeScript bundler，用于将 src/*.ts 打成 dist/*.js。我们用 Bun 后**不需要 tsdown**——`bun build` 已经覆盖。

**测试 runner 的取舍**：vitest 在 BMAD 生态、CI 工具链、coverage 报告上更成熟；`bun test` 在执行速度上有优势但 ecosystem 小。MVP 先用 vitest（与 openclaw 一致便于参考），后续若需要可切到 `bun test`。

## 9. Module Structure & Repo Layout

### 9.1 目录树（MVP）

```
claude-discord/
├── .claude-plugin/
│   └── plugin.json                # CC plugin metadata
├── .mcp.json                       # CC MCP server declaration
├── package.json                    # type:module, scripts, deps
├── tsconfig.json
├── tsdown.config.ts
├── vitest.config.ts
├── README.md
├── LICENSE                         # MIT
│
├── src/
│   ├── daemon/
│   │   ├── index.ts                # daemon entry point
│   │   ├── socket-server.ts        # Unix socket listener
│   │   ├── connection.ts           # one connection = one plugin
│   │   ├── registry.ts             # active workspace table + LRU
│   │   ├── ring-buffer.ts          # per-workspace 50-entry ring
│   │   ├── routing.ts              # routing.json read/write/watch
│   │   ├── discord-gateway.ts      # discord.js wrap
│   │   ├── outbound-queue.ts       # rate-limited Discord call queue
│   │   ├── access-control.ts       # access.json policy gate (sender side)
│   │   ├── permission-relay.ts     # claude/channel/permission protocol
│   │   ├── slash-commands.ts       # /use /list /which /last /recent /status
│   │   ├── content-display.ts      # chunk / thread / embed / attachment 决策
│   │   ├── safety.ts               # assertSendable / safeAttName
│   │   └── shutdown.ts             # graceful shutdown
│   │
│   ├── plugin/
│   │   ├── index.ts                # plugin entry (run by CC as subprocess)
│   │   ├── mcp-server.ts           # @modelcontextprotocol/sdk wrapping
│   │   ├── socket-client.ts        # Unix socket connection to daemon
│   │   ├── tool-handlers.ts        # 5 tools' MCP handlers
│   │   ├── inbound-relay.ts        # daemon push → MCP notification
│   │   └── reconnect.ts            # exponential backoff
│   │
│   ├── cli/
│   │   ├── index.ts                # claude-discord-bot CLI entry (commander)
│   │   ├── start.ts                # foreground daemon
│   │   ├── dev.ts                  # foreground + bun --watch
│   │   ├── reset.ts                # clear state files (--routing / --inbox / --all)
│   │   ├── stop.ts                 # launchctl unload / systemctl stop
│   │   ├── restart.ts              # stop + start
│   │   ├── logs.ts                 # tail daemon.{out,err}.log
│   │   ├── install.ts              # install-plan / apply / verify
│   │   ├── uninstall.ts
│   │   ├── status.ts
│   │   ├── configure.ts            # write .env
│   │   ├── pair.ts                 # access.json mutation skills
│   │   ├── policy.ts
│   │   └── group.ts
│   │
│   ├── protocol/
│   │   ├── schema.ts               # zod schemas for all wire messages
│   │   ├── version.ts              # protocol version constant + matrix
│   │   └── ndjson.ts               # framing helpers
│   │
│   ├── shared/
│   │   ├── paths.ts                # STATE_DIR resolution, env override
│   │   ├── logger.ts               # tslog config
│   │   └── error.ts                # typed errors
│   │
│   └── installer/
│       ├── plan.ts                 # platform-aware install plan generation
│       ├── apply-launchd.ts        # macOS specific
│       ├── apply-systemd.ts        # Linux specific
│       └── plist-template.ts
│
├── test/
│   ├── unit/                       # 每个模块对应 unit test
│   ├── integration/                # plugin↔daemon socket 协议
│   ├── e2e/                        # 实际 spawn 完整 daemon + plugin + mock CC
│   └── live/                       # 真实 Discord bot + 真实 CC（手动跑）
│
└── scripts/
    ├── build.mjs                   # tsdown
    └── test-parallel.mjs           # 测试 runner
```

### 9.2 13 epic → 模块映射

| Epic | 主要模块 |
| --- | --- |
| Epic 1 Daemon Lifecycle | `src/daemon/index.ts`, `shutdown.ts` |
| Epic 2 Plugin SDK | `src/plugin/`（全部） |
| Epic 3 Discord Routing | `src/daemon/routing.ts`, `discord-gateway.ts` |
| Epic 4 Slash Commands | `src/daemon/slash-commands.ts` |
| Epic 5 Long Content Display | `src/daemon/content-display.ts` |
| Epic 6 Permission Relay | `src/daemon/permission-relay.ts` |
| Epic 7 Channel UX | `src/daemon/discord-gateway.ts`（topic 改写）+ `slash-commands.ts`（切换状态消息） |
| Epic 8 Ring Buffer | `src/daemon/ring-buffer.ts` |
| Epic 9 Capacity LRU | `src/daemon/registry.ts` |
| Epic 10 Offline UX | `src/daemon/registry.ts`（在线判断）+ `discord-gateway.ts`（回执） |
| Epic 11 Sender-side Access | `src/daemon/access-control.ts` |
| Epic 12 Safety | `src/daemon/safety.ts` |
| Epic 13 CLI Installer | `src/cli/`, `src/installer/` |

## 10. Daemon Installer

### 10.1 路线对标 openclaw

`openclaw/dist/daemon-install-plan.shared-*.js` 抽象出"plan → apply → verify"三阶段，每阶段产出可序列化的中间结构，方便 dry-run 与 rollback。我们抄这条路线但 scope 收紧：

```
plan(): {
  platform: "macos" | "linux" | "unsupported",
  artifacts: [
    { kind: "plist" | "unit", path: "/Users/x/Library/LaunchAgents/...plist", content: "..." },
    { kind: "ensure-dir", path: "/Users/x/.claude/channels/discord/" },
  ],
  service_actions: ["launchctl load", "launchctl start"],
  rollback: [
    { kind: "delete-file", path: "..." },
    { kind: "service-action", action: "launchctl unload" },
  ]
}
```

`apply(plan)` 顺序执行 artifacts 与 service_actions，每步成功后把对应 rollback 步骤入 stack；任何一步失败 → 反向跑 rollback stack → 抛错。

`verify(plan)` 跑 `launchctl list | grep claude-discord-bot` / `systemctl --user status` 等，确认服务已运行。

### 10.2 macOS plist 模板

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jacobbubu.claude-discord-bot</string>
    <key>ProgramArguments</key>
    <array>
        <string>{BUN_PATH}</string>
        <string>run</string>
        <string>{INSTALL_DIR}/dist/daemon.js</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{HOME}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>{HOME}/.claude/channels/discord/daemon.err.log</string>
    <key>StandardOutPath</key>
    <string>{HOME}/.claude/channels/discord/daemon.out.log</string>
</dict>
</plist>
```

### 10.3 Linux systemd unit 模板

```ini
[Unit]
Description=claude-discord-bot daemon
After=network.target

[Service]
Type=simple
ExecStart={BUN_PATH} run {INSTALL_DIR}/dist/daemon.js start
Restart=always
RestartSec=5
StandardOutput=append:%h/.claude/channels/discord/daemon.out.log
StandardError=append:%h/.claude/channels/discord/daemon.err.log

[Install]
WantedBy=default.target
```

### 10.4 install 子命令 UX

```
$ claude-discord-bot install
[1/4] 检测平台 ......................... macOS (Darwin)
[2/4] 生成安装计划 ..................... 3 artifacts, 2 actions
[3/4] 应用计划 .......................... ✓
        - 写入 ~/Library/LaunchAgents/com.jacobbubu.claude-discord-bot.plist
        - mkdir ~/.claude/channels/discord/
        - launchctl load ~/Library/LaunchAgents/com.jacobbubu.claude-discord-bot.plist
[4/4] 验证 .............................. ✓ 服务在跑（PID 12345）

Daemon 已安装并启动。下一步：
  - claude-discord-bot configure <token>  # 写 Discord token
  - 在 CC 中安装 plugin                    # 见 README

$ claude-discord-bot install --dry-run
[1/4] 检测平台 ......................... macOS (Darwin)
[2/4] 生成安装计划 ..................... 3 artifacts, 2 actions
[3/4] 模拟应用 .......................... DRY RUN（未真实执行）
        - 将写入 ~/Library/LaunchAgents/...plist
        - 将 mkdir ~/.claude/channels/discord/
        - 将 launchctl load ...
[4/4] 验证 .............................. SKIPPED（dry-run）
```

### 10.5 启动控制脚本套件（参考 openclaw `gateway:dev` / `gateway:dev:reset`）

CLI 子命令对照与用途：

| 命令 | 用途 | 典型场景 |
| --- | --- | --- |
| `claude-discord-bot start` | 前台运行 daemon（不 install） | 临时跑一下、测试 token、debug；CTRL-C 关 |
| `claude-discord-bot dev` | 前台 + 文件监听重启 | 开发态：改 src/ 自动重启 daemon，等同 `bun --watch dist/daemon.js start` |
| `claude-discord-bot reset` | 清状态后再启动 | 清掉 routing.json / approved/ / inbox/ 后前台启动；用于"想从干净状态开始" |
| `claude-discord-bot install` | 注册 launchd / systemd 服务 | 生产部署 |
| `claude-discord-bot uninstall` | 反向卸载 | |
| `claude-discord-bot status` | 查 daemon 健康 | install 之后或正常运行期 |
| `claude-discord-bot stop` | 停服务（launchctl unload / systemctl stop） | 临时停而不 uninstall |
| `claude-discord-bot restart` | 等价 stop + start | 升级后用 |
| `claude-discord-bot logs [-f]` | tail daemon.{out,err}.log | 排障 |

**`reset` 子命令的语义**（细化 openclaw `gateway:dev:reset` 风格）：

```bash
# 清理范围（按 flag 控制）
$ claude-discord-bot reset --routing       # 仅清 routing.json
$ claude-discord-bot reset --inbox         # 仅清 inbox/ 已下载附件
$ claude-discord-bot reset --pending       # 仅清 access.json 中 pending 配对
$ claude-discord-bot reset --all           # 全清（不动 .env / allowFrom）
$ claude-discord-bot reset --all --including-token  # 真的全清（连 token 也走）
```

reset 永远不会动用户主动设置的 `allowFrom`、`groups`、`mentionPatterns` 等长期配置，除非显式 `--including-acl`。这是"开发期重启"和"卸载重装"的边界。

**package.json scripts**（开发者工作流入口）：

```json
{
  "scripts": {
    "dev": "claude-discord-bot dev",
    "dev:reset": "claude-discord-bot reset --routing --inbox && claude-discord-bot dev",
    "build": "bun build src/daemon/index.ts --target=bun --outdir=dist && bun build src/plugin/index.ts --target=bun --outdir=dist && bun build src/cli/index.ts --target=bun --outdir=dist",
    "test": "vitest",
    "test:integration": "vitest --config vitest.integration.config.ts",
    "test:e2e": "vitest --config vitest.e2e.config.ts",
    "test:live": "OPENCLAW_LIVE_TEST=1 vitest --config vitest.live.config.ts",
    "lint": "oxlint",
    "format": "oxfmt --write",
    "format:check": "oxfmt --check",
    "typecheck": "tsc --noEmit",
    "check": "pnpm format:check && pnpm typecheck && pnpm lint && pnpm test"
  }
}
```

`dev` / `dev:reset` 是开发态最常用的两条；`install` 通过 CLI（不进 npm scripts，因为需要 install 全局二进制后才能用，npm run 阶段还没装）。

## 11. Rate Limiting & Outbound Queue

### 11.1 Discord 限流模型

Discord API 三层限流：
- **Per-route**（如 `POST /channels/{id}/messages`）：5 req/5s
- **Global**：50 req/s
- **Per-resource**（如 channel）：1 typing/5s

discord.js 14 内建队列（`REST` manager），但当多 CC 同时输出时（concept #5/L 决定），daemon 仍需要**统一外层队列**避免：

- discord.js 内部队列被 50 个并发 send 撑爆
- 长内容分片时，第 N 片排队过久导致前后乱序

### 11.2 keyed-async-queue 实现（参考 openclaw `plugin-sdk/keyed-async-queue`）

```ts
class KeyedAsyncQueue {
  private queues = new Map<string, Promise<unknown>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(() => fn(), () => fn())  // 失败也继续
    this.queues.set(key, next.catch(() => {}))
    try {
      return await next
    } finally {
      // 清理已完成的最后一个，避免无限增长
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
  }
}
```

每个 channel id 一条 queue，保证同 channel 的发送顺序。chunk 切片的多条消息按入队顺序发出，不会被别的 workspace 插队。Discord 的 per-route rate limit 由 discord.js 内建处理；我们外层只解决 channel 内顺序与 plugin 间公平。

### 11.3 命中限流时的退化

discord.js 触发 429 时已有指数退避；daemon 端仅打 warn 日志、不阻塞 plugin 端的 tool_call 队列（plugin 会等 tool_result，但 plugin 也有自己的超时兜底见 §6.4）。

## 12. State Files & Atomic Writes

### 12.1 文件清单

| 路径 | 内容 | 权限 | 谁写 |
| --- | --- | --- | --- |
| `~/.claude/channels/discord/.env` | DISCORD_BOT_TOKEN | 0o600 | CLI configure 子命令；启动时 chmod 强制 |
| `~/.claude/channels/discord/access.json` | 沿用上游 schema | 0o600 | CLI access 子命令；daemon 写 pending 与 reply 计数 |
| `~/.claude/channels/discord/routing.json` | channel→workspace map + last_active | 0o600 | daemon（slash 命令触发） |
| `~/.claude/channels/discord/approved/<senderId>` | DM channel ID（一次性 IPC） | 0o600 | CLI pair 子命令；daemon 读后删 |
| `~/.claude/channels/discord/inbox/<ts>-<id>.<ext>` | 下载的附件 | 0o644 | daemon |
| `~/.claude/channels/discord/daemon.sock` | Unix domain socket | 0o600 | daemon 创建 |
| `~/.claude/channels/discord/daemon.{out,err}.log` | 日志 | 0o600 | launchd / systemd |

### 12.2 routing.json schema

```jsonc
{
  // 最后一次切换的时间用于 /list 排序与 last_active 计算
  "channels": {
    "<channel_id>": {
      "workspace": "foo",
      "history": ["bar", "baz"],   // 最近 N 个曾绑定的 workspace（用于 /last）
      "switched_at": 1714983000000
    }
  },
  "version": 1
}
```

### 12.3 原子写

所有状态文件用 `write tmp + rename` 原子模式：

```ts
async function atomicWrite(path: string, content: string, mode: number) {
  const tmp = `${path}.tmp.${process.pid}`
  await fs.writeFile(tmp, content, { mode })
  await fs.rename(tmp, path)
}
```

### 12.4 access.json 热加载

沿用上游设计：每条入站消息重读。文件 ENOENT → 默认 pairing；JSON parse 失败 → rename 到 `access.json.corrupt-<ts>` + 默认值。

routing.json 不每条消息重读（性能），而是 `fs.watch` 监听 mtime 变化时刷新内存视图。

## 13. LRU Capacity Manager

### 13.1 数据结构

```ts
class WorkspaceRegistry {
  private map = new Map<string, RegEntry>()  // workspace name → entry
  private cap = 50
  private trim = 45

  register(entry: RegEntry): void {
    this.map.set(entry.name, entry)
    if (this.map.size > this.cap) this.evictTo(this.trim)
  }

  touch(name: string): void {
    const e = this.map.get(name)
    if (e) e.lastActivityTs = Date.now()
  }

  private evictTo(target: number): void {
    const entries = [...this.map.values()].sort((a, b) => a.lastActivityTs - b.lastActivityTs)
    const toEvict = entries.slice(0, this.map.size - target)
    for (const e of toEvict) {
      e.connection.close()  // 触发 plugin reconnect
      this.map.delete(e.name)
      // ring buffer 同时清理（在 connection.close 的 cleanup 里做）
    }
  }
}
```

### 13.2 LRU 比较粒度

毫秒级，但相同 ms 下用插入顺序作 tiebreaker。`Map` 在 JS 中保持插入顺序，正好用上。

### 13.3 配置覆盖

环境变量优先：`CLAUDE_DISCORD_WORKSPACE_CAP`、`CLAUDE_DISCORD_WORKSPACE_TRIM_TARGET`。范围校验在 daemon 启动时一次性做，超出范围 → 警告 + 用默认。

## 14. Ring Buffer Implementation

### 14.1 数据结构

```ts
type RingEntry = {
  ts: number          // unix ms
  channelId: string
  direction: "in" | "out"
  textPreview: string  // 截断到 200 char
}

class RingBuffer {
  private buf: RingEntry[] = []
  private cap = 50

  push(e: RingEntry): void {
    this.buf.push(e)
    if (this.buf.length > this.cap) this.buf.shift()
  }

  recent(n: number): RingEntry[] {
    return this.buf.slice(-n)
  }

  isEmpty(): boolean { return this.buf.length === 0 }
  lastActivity(): number { return this.buf.at(-1)?.ts ?? 0 }
  lastChannel(): string | null { return this.buf.at(-1)?.channelId ?? null }
}
```

### 14.2 必要性算法（FR-8.3）

```ts
function shouldAutoDisplay(buf: RingBuffer, currentChannel: string, now: number): boolean {
  if (buf.isEmpty()) return false
  if (now - buf.lastActivity() < 15 * 60 * 1000) return false
  if (buf.lastChannel() === currentChannel) return false
  return true
}
```

### 14.3 时间戳渲染

用 Discord 原生 `<t:UNIX:R>`：

```
[<t:1714983000:t> · <t:1714983000:R>] me: 帮我看下 server.ts...
```

`<t:UNIX:t>` = 14:30，`<t:UNIX:R>` = 2 hours ago，客户端按时区与语言自动渲染。

## 15. Exception Handling & Self-Healing

| 异常 | 检测 | 恢复 |
| --- | --- | --- |
| Discord 网关断 | `client.on('error')` + `client.on('shardDisconnect')` | discord.js 内建 reconnect；外层不干预；超 5 分钟仍未连上则打 stderr warn |
| Discord rate limit | discord.js `rateLimited` event | 仅日志；队列自然排队 |
| Plugin socket 断 | socket `'close'` event | 标 workspace 离线；plugin 端 reconnect |
| Plugin 心跳超时 | daemon 30s 扫描 | close socket（同上） |
| Plugin 收到无法解析消息 | JSON parse fail | stderr warn，不 crash |
| daemon 进程崩 | unhandled rejection / exception 全局 catcher | stderr warn 不退出；KeepAlive=true 让 launchd / systemd 重启 |
| access.json 损坏 | JSON parse fail | rename 到 .corrupt + 默认值 + stderr warn |
| Token 缺失 | 启动时检测 | exit 1 + stderr 提示路径 |
| Workspace cap 满 | register 时 size > cap | LRU 驱逐 |

## 16. Discord-side Patterns

### 16.1 Sender Access Control（沿用上游）

策略状态机：`pairing` / `allowlist` / `disabled`。Pairing 流程：

```
unknown DM → check pending[senderId]
              ├─ exists, replies < 2: send reminder, replies++
              ├─ exists, replies ≥ 2: drop silently
              └─ not exists:
                   ├─ pending size ≥ 3: drop
                   └─ generate code, store, reply with code

CLI: claude-discord-bot pair <code>
   → mutate access.json (add to allowFrom, delete pending)
   → write approved/<senderId> with chatId
   → daemon polls approved/, sends "Paired! Say hi" to chatId, deletes file
```

完全沿用上游 `server.ts:236-365` 与 `skills/access/SKILL.md` 的逻辑，迁移到 `src/daemon/access-control.ts` 与 `src/cli/pair.ts`。

### 16.2 Slash Commands（discord.js application commands）

启动时注册：

```ts
const commands = [
  new SlashCommandBuilder().setName('use').setDescription('Switch this channel to a workspace')
    .addStringOption(o => o.setName('workspace').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('last').setDescription('Switch back to previous workspace'),
  new SlashCommandBuilder().setName('list').setDescription('List active workspaces (most recent first)'),
  new SlashCommandBuilder().setName('which').setDescription('Show this channel current binding'),
  new SlashCommandBuilder().setName('recent').setDescription('Show last N messages of current workspace')
    .addIntegerOption(o => o.setName('n').setMinValue(1).setMaxValue(5)),
  new SlashCommandBuilder().setName('status').setDescription('Show status of a workspace')
    .addStringOption(o => o.setName('workspace').setAutocomplete(true)),
]
```

Autocomplete handler 查 `WorkspaceRegistry` 列出活动 workspace 名。

每个 slash 命令的鉴权：在 handler 入口检查 `interaction.user.id ∈ access.allowFrom`，否则 `interaction.reply({content: 'Not authorized.', ephemeral: true})`。

### 16.3 Long Content Display Decision Tree

```ts
async function deliverContent(text: string, opts: SendOpts) {
  const limit = opts.chunkLimit ?? 2000
  if (text.length <= limit) {
    return sendInline(text, opts)
  }
  if (text.length > 4000 && hasCodeBlocks(text)) {
    return sendAsAttachment(text, "result.md", opts)
  }
  if (opts.kind === "trace") {
    return sendAsThread(text, opts)
  }
  return chunkAndSend(text, limit, opts)
}
```

更复杂的 routing（embed for structured / edit-then-new for streaming）由调用方传入 `opts.kind` 决定。

### 16.4 Channel Topic 改写

`/use foo` 触发：

```ts
async function applyUse(channelId: string, workspace: string) {
  await routing.set(channelId, workspace)
  await discordGateway.setChannelTopic(channelId, `[claude-discord] ${workspace}`)
  await discordGateway.send(channelId, `✅ switched to ${workspace}`)
  if (shouldAutoDisplay(ringBuffer.get(workspace), channelId, Date.now())) {
    const recent = ringBuffer.get(workspace).recent(3)
    await discordGateway.send(channelId, formatRecent(recent))
  }
}
```

## 17. Security Model

### 17.1 沿用上游红线

- **assertSendable**：reply 工具调用前校验 files 数组里没有 STATE_DIR 内非 inbox 的文件
- **safeAttName**：附件名清洗 `[]\r\n;` 等定界字符
- **prompt-injection 防御**：CLI access 子命令拒绝从 channel 通知里来的请求
- **0o600 权限**：所有 state 文件
- **access.json 热加载** + 配对码 1h 过期 + pending cap 3

### 17.2 Daemon 多 connection 的隔离

每个 plugin 连接是独立的 socket fd。Daemon 路由 inbound 给目标 workspace 时按 active registry 查目标连接，绝不跨连接广播。一个 plugin 收到的消息永远是属于它 workspace 的。

每个 socket 连接的入站消息按各自 fd 单线程消费（Bun 事件循环顺序），不会混。

### 17.3 Socket 权限

- 路径：`~/.claude/channels/discord/daemon.sock`
- mode: `0o600`（仅 owner 读写）
- 父目录 `~/.claude/channels/discord/` mode: `0o700`

仅本机当前用户能连上，杜绝同机器其他用户偷 IPC。

### 17.4 Plugin 端 capability 协商

Plugin 在 `register` 报上自己支持的工具列表；daemon 据此构造响应工具集合（`server_capabilities` 在 `register_ack` 返回）。Plugin 不应该假装支持自己不支持的工具。Daemon 不应该在 ack 后才发现 plugin 不支持某能力。

## 18. Test Strategy

### 18.1 单元（vitest）

- `registry.ts`: cap、LRU 排序、touch 更新、容量边界、并发 register
- `ring-buffer.ts`: push、shift、recent、空 buffer、容量边界
- `routing.ts`: 读写、原子写、watcher、history queue
- `outbound-queue.ts`: 同 key 顺序、不同 key 并发、错误传播
- `access-control.ts`: pairing 状态机、allowlist 切换、static mode 降级
- `protocol/schema.ts`: zod 解析所有 wire 类型
- `content-display.ts`: chunk 算法、附件触发阈值

### 18.2 集成（vitest + 真实 socket）

- Plugin 连 daemon → register → register_ack → 心跳 → 优雅关闭
- Plugin 断线重连
- Daemon 驱逐 plugin → plugin 自动重连重新注册
- 多 plugin 并发连接 + 消息互不串

### 18.3 E2E（vitest + spawn 完整 daemon + plugin + mock CC）

- 模拟 CC 调 reply → daemon 收到 tool_call → 发 mock Discord → 返 tool_result
- 模拟 Discord 入 inbound → daemon 路由到 plugin → plugin 推 MCP notification → mock CC 收到
- 长任务 streaming：plugin → daemon 多次调 reply 与 edit_message
- /use 切换 → routing.json 更新 + topic 改 + 状态消息

### 18.4 Live（手动跑，不进 CI）

- 真实 Discord bot + 真实 CC + 我们的 plugin + daemon
- 手机 DM bot → 收到回复
- 多 workspace `/use` 切换
- /recent 显示

### 18.5 launchd integration（参考 openclaw `daemon/launchd.integration.test.ts`）

- 写测试用 plist 到临时路径
- `launchctl load` → 验证服务起来
- 修改 plist → reload → 验证生效
- `launchctl unload` → 验证清理
- 仅 macOS CI runner 跑

### 18.6 半自动 e2e — Mock Claude Code 驱动真 plugin

**目标**：在 CI 里**不依赖真实 LLM、不依赖真实 Discord**，验证 plugin↔daemon 协议端到端正确性。每个测试 < 1 秒，可大量跑、必入 CI gate。

**架构**：

```
┌──────────────────┐    MCP stdio    ┌──────────┐  Unix socket  ┌──────────────┐
│ MockClaudeCode   │  ───────────▶   │  Plugin  │  ─────────▶   │ MockDaemon   │
│ (MCP client)     │                 │  (real)  │               │ (test fake)  │
│ - scripted MCP   │  ◀───────────   │          │  ◀─────────   │ - scripted   │
│   requests       │                 │          │               │   NDJSON     │
│ - assertions     │                 │          │               │   responses  │
└──────────────────┘                 └──────────┘               └──────────────┘
```

**`MockClaudeCode` 实现**：

- 使用 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport`
- `spawn` 真实 plugin 进程：`bun run dist/plugin.js`（命令行参数与 `.mcp.json` 完全一致）
- 暴露脚本化 API：`callTool('reply', {chat_id, text})` / `expectNotification('notifications/claude/channel', matcher)` / `assertNoNotificationFor(timeout)`
- 不跑 LLM，不调 Anthropic API；纯协议驱动

**`MockDaemon` 实现**：

- Unix socket server 启动在临时路径（避开 `~/.claude/...`）
- 通过环境变量 `CLAUDE_DISCORD_DAEMON_SOCKET=/tmp/test-XXX.sock` 让 plugin 连到 mock
- 接受 NDJSON 入站（register / heartbeat / tool_call），按测试脚本回 NDJSON（register_ack / inbound / tool_result）
- 暴露脚本化 API：`expectRegister()` / `pushInbound({chat_id, content})` / `expectToolCall('reply', matcher)` / `replyToolResult(id, ok, data)`

**测试样例**（伪代码）：

```ts
test('inbound message routed to CC as MCP notification', async () => {
  const daemon = await MockDaemon.start()
  const cc = await MockClaudeCode.spawn({ daemonSocket: daemon.path })

  await daemon.expectRegister({ agent: 'claude-code' })
  daemon.replyRegisterAck({ workspace: 'test' })

  daemon.pushInbound({ chat_id: '1', message_id: '2', user: 'alice', content: 'hi' })
  const note = await cc.expectNotification('notifications/claude/channel')
  expect(note.params.content).toBe('hi')
  expect(note.params.meta.chat_id).toBe('1')

  await cc.shutdown()
  await daemon.stop()
})

test('CC tool call routed to daemon as tool_call', async () => {
  const daemon = await MockDaemon.start()
  const cc = await MockClaudeCode.spawn({ daemonSocket: daemon.path })
  await daemon.expectRegister(); daemon.replyRegisterAck()

  const callPromise = cc.callTool('reply', { chat_id: '1', text: 'ok' })
  const tc = await daemon.expectToolCall('reply')
  expect(tc.args.text).toBe('ok')
  daemon.replyToolResult(tc.id, { ok: true, result: 'sent (id: 99)' })

  const result = await callPromise
  expect(result.content[0].text).toBe('sent (id: 99)')
})
```

**覆盖矩阵**（必入 CI 的最小集）：

- 握手成功 + agent 字段正确传递
- 握手失败（version mismatch / unknown agent）→ plugin 重试 / 退出
- 5 个 MCP 工具的入参→tool_call→tool_result→MCP 响应链路各一条
- inbound notification 包含附件元信息时正确转换
- daemon 主动 close socket（模拟 LRU 驱逐）→ plugin 自动 reconnect
- 心跳超时检测
- permission_request 中继：daemon 推 → plugin 转 MCP → CC 回 → plugin 转 daemon

**约定**：

- 测试文件命名 `*.semi-e2e.test.ts`
- vitest config: `vitest.semi-e2e.config.ts`，超时 5 秒，并行
- 每个测试自带 `MockDaemon.start()` + `MockClaudeCode.spawn()` 的临时实例，避免互相干扰

### 18.7 全自动 e2e — 真 Claude Code 驱动真 plugin + 真 daemon

**目标**：在 release 前验证整条链路（包括真 Anthropic API 调用、真 Discord）的端到端行为。不入 PR CI，作为 manual 或 release-gate 跑。

**架构**：

```
┌────────────────────┐               ┌──────────┐               ┌─────────────┐
│ E2E driver         │               │  Plugin  │  Unix socket  │   Daemon    │
│  - spawn `claude`  │  MCP stdio    │  (real)  │  ─────────▶   │   (real)    │
│    via SDK or tmux │  ───────────▶ │          │               │             │
│  - feed prompts    │                └──────────┘                └─────┬─────┘
│  - assert Discord  │                                                  │
│    side state      │                                                  ▼
└────────────────────┘                                            Test Discord
                                                                  Bot + Guild
                                                                       ▲
                                                                       │
                                              ┌────────────────────────┘
                                              │
                                       ┌────────────────────┐
                                       │ Observer bot       │
                                       │ (separate token)   │
                                       │ - reads channel    │
                                       │ - posts to driver  │
                                       └────────────────────┘
```

**两种驱动模式**：

| 模式 | 适用 | 工作量 |
| --- | --- | --- |
| **A. `claude` non-interactive** | 单轮提示 → 期望工具调用 → 期望 Discord 状态变化 | 小：调用 `claude --print "prompt" --channels plugin:claude-discord`，等结束 |
| **B. tmux 自动化**（参考 oh-my-claudecode `qa-tester`） | 多轮对话、长任务、工具中流断与重试 | 大：开 tmux session、键盘注入、screen scrape、脚本化等待 |

A 是 MVP 必须；B 是 day-2 可选。

**Test Discord 资源**：

- 一个独立的测试 Discord application（test bot token）
- 一个独立的测试 guild（仅项目维护者在）
- 一个固定的测试 channel
- **observer bot**：第二个独立 token + 第二个 client，订阅同一 guild，把测试 channel 的消息流通过 IPC 推给 driver。这样 driver 不用直接 poll discord.js（避免和 daemon client 撞 token）

**判定方式**：

```ts
test('user message via real CC produces assistant reply on Discord', async () => {
  const daemon = await Daemon.spawn()  // 真 daemon
  const observer = await ObserverBot.connect()
  await observer.clearChannel(TEST_CHANNEL)

  // 模拟用户在 Discord 上发消息
  await observer.sendAs('test-user', 'what is 2+2?')

  // 真 claude 进程通过 plugin 收到，调 reply 工具，发回 Discord
  const reply = await observer.waitForBotMessage(TEST_CHANNEL, { timeout: 30_000 })
  expect(reply.content).toMatch(/4|four/)

  await daemon.stop()
})
```

**约束**：

- 真 LLM 输出不确定，断言必须用 fuzzy matcher（matches、contains、长度阈值）
- Discord rate limit 实存在；E2E 跑慢是正常的
- 每次跑前 `daemon reset --routing --inbox`，避免上次状态污染
- 仅在 ENV 满足 `CLAUDE_DISCORD_E2E_LIVE=1 ANTHROPIC_API_KEY=... DISCORD_TEST_BOT_TOKEN=... DISCORD_TEST_OBSERVER_TOKEN=... DISCORD_TEST_CHANNEL_ID=...` 时跑，否则 skip

**Mock Discord 选项**（中间档）：

- 介于半自动和全自动之间：真 plugin + 真 daemon + 真 CC，但**用 nock / msw 拦截 discord.js HTTP 请求**，回放预录的响应
- 优点：跳过 Discord rate limit 与网络抖动，仍能验证 daemon→Discord 一侧的协议正确性
- 缺点：维护回放数据集；和 discord.js 升级耦合
- MVP 不必做；day-2 候选

**测试约定**：

- 文件命名 `*.live-e2e.test.ts`
- vitest config: `vitest.live-e2e.config.ts`，超时 60 秒，**串行**（避免 Discord rate limit 互相打架）
- CI: 仅在 `release/*` 分支或手动触发跑；PR CI 不跑

### 18.8 测试金字塔总结

```
        ┌─────────────────┐
        │ live-e2e (18.7) │  ← 真 CC + 真 Discord，pre-release 手动
        │   N=10 左右     │
        ├─────────────────┤
        │ launchd (18.5)  │  ← 真服务安装；macOS-only CI runner
        │   N=10 左右     │
        ├─────────────────┤
        │ semi-e2e (18.6) │  ← Mock CC + 真 plugin + Mock daemon，CI gate
        │   N=50-100      │
        ├─────────────────┤
        │ integration     │  ← plugin↔daemon 协议；CI gate
        │   N=30-50       │
        ├─────────────────┤
        │ unit            │  ← 模块隔离；CI gate
        │   N=200+        │
        └─────────────────┘
```

PR 入 main 必跑：unit + integration + semi-e2e（base）；可选跑：launchd（macOS runner）。Live-e2e 不进 PR gate，仅 release 前。

## 19. Deployment & Version Compatibility

### 19.1 协议版本矩阵

```
plugin v1 ↔ daemon v1 : ✓
plugin v1 ↔ daemon v2 : daemon 检查 register.v=1 → 若仍兼容则 ack v1，否则 reject "protocol_mismatch"
plugin v2 ↔ daemon v1 : daemon 不识别 v=2 → reject; plugin reconnect 失败提示 "升级 daemon"
```

每次协议层 breaking change → bump major version。daemon 始终向后兼容到 N-1 版本（保 6 个月）。

### 19.2 plugin 与 daemon 版本不一致的诊断

- daemon `register_reject` reason 为 `"protocol_mismatch"` + 期望版本号
- plugin 收到后写 stderr，CC 端 MCP 工具调用全部返回错误 `"daemon protocol mismatch, expected vX got vY"`
- 用户在 CC 里看到错误 → 知道升级 daemon

### 19.3 升级路径

- `npm install -g claude-discord-bot@latest` → 重启 daemon（launchd KeepAlive 自然会拉起）
- plugin 通常随 CC plugin 包升级；如果 daemon 比 plugin 新，向后兼容保证短时间不中断

### 19.4 ADR — 为什么协议层带版本 + capability 协商

**Context**：上游 plugin↔CC 走 MCP（已是协议），plugin 与"daemon"不存在（无 daemon），所以上游不需要自定义协议版本。我们引入了 plugin↔daemon 的自定义 NDJSON 协议。

**Decision**：每条 wire 消息携带 `v: 1` 协议版本字段；register 握手携带 `agent`、`capabilities`、`protocol_version`；daemon 在 `register_reject` 中可指定 `expected_version` 与 `reason`。

**Rationale**：

- plugin 与 daemon 的发版节奏未来会脱钩——plugin 跟随 CC plugin 系统升级，daemon 跟随系统服务包升级。版本错配是常态而非异常
- agent-extensibility 需要 capability 协商（同一个 daemon 既要服务 claude-code 也要服务 codex），单纯版本号不够，要 capability set
- 协议演化时（比如 v2 改了 inbound 字段命名），daemon 应能识别旧 v1 plugin 并 graceful degrade 或拒接，而不是直接打挂
- 显式协议字段是"你以为以后不会需要但实际很贵"的反例——加在 v1 就 1 字段成本，等到 v2 才加要做 schema migration

**Consequences**：

- 每条 NDJSON 多 4 字节（`"v":1,`）开销——可忽略
- `WireSchema` 用 zod discriminated union 在两端各做一次校验，runtime cost 微小
- 测试增加一类 case：跨版本拒接（`register_reject reason=protocol_mismatch`）

参见 `docs/research/upstream-architecture-deep-dive.md` §4.2。

## 20. Spike Issues / 验证任务

架构落地前需要写代码验证的不确定项，作为开发阶段第一周的 spike issue：

| Spike | 验证目标 | 工作量 |
| --- | --- | --- |
| `[research] CC plugin spike: MCP-as-thin-proxy` | 50 行原型证明 plugin 可以同时 (a) 跑 MCP server stdio (b) 维持 outbound socket 连接 (c) 路由两边消息 | 半天 |
| `[research] Unix socket on macOS / Linux launchd` | daemon 装 launchd 服务后 socket 路径权限是否符合预期；多用户场景 | 半天 |
| `[research] discord.js application command auto-complete` | 在 daemon 端注册 slash 命令并响应 autocomplete 请求 | 1 天 |
| `[research] plist signed installer` | plist 是否需要签名才能 launchd load（macOS 安全策略） | 半天 |

这四个 spike 跑完后，开发阶段所有"不确定到底能不能这样"的问题都消除。

## 21. Open Questions for Dev Phase

1. **Plugin 二进制分发**：是 npm 包（`@jacobbubu/claude-discord-plugin`）还是随 daemon 同包（`claude-discord-bot` 自带 plugin）？倾向同包：减少版本错配；plugin 只是 daemon 的一部分
2. **Signal 处理**：launchd / systemd 发 SIGTERM 时的 grace period 默认是 20s，足够 daemon 干净关 socket + Discord 连接？需 e2e 测
3. **Logs rotation**：daemon.{out,err}.log 由谁 rotate（`logrotate` 配 / 应用内 rotation）？倾向应用内 size 限制
4. **macOS code signing**：plist 是否需要 ad-hoc 签名才能 launchd load？开源版可能不签
5. **Linux 没 systemd（Alpine、嵌入式）**：is-systemd 探测失败时如何 graceful degrade？
6. **Plugin 自检**：plugin 启动时连不上 daemon，是 silent 重试还是 stderr 喊？倾向 stderr 第一次失败后喊一次，之后静默重试
7. **daemon 升级时的连接迁移**：如果 daemon 进程换新版本，所有 plugin 连接断开重连——这个间隙的 Discord 消息怎么办？倾向放弃（不做消息缓冲），plugin reconnect 后正常路由

这 7 项是开发阶段第一个 PR 之前需要定下来的细节，但不影响整体架构判断。

---

## Implementation deltas（stage 2 之后）

> 截至 0.0.3 (2026-05-09)。stage 2 e2e 框架与真 Discord 实测暴露出原架构没覆盖或留白的细节，这里**追加**而非改写主文档，让 commit 历史和决策追溯保持线性。

### 1. Plugin 自身就是 marketplace（self-host）

原架构假设 plugin 通过 `.mcp.json` + CC 自动 spawn 即可工作。实测发现 CC v2.1.138 的 channel mode 只接受**已注册到 marketplace 的 plugin**——`plugin:<name>@<marketplace>` 引用模式，server 模式 + `--mcp-config` 不被认作 channel-eligible。

落地（PR #27）：本仓库自身就是 marketplace。在 repo 根加 `.claude-plugin/{plugin.json, marketplace.json}`，user 端 `/plugin marketplace add <git-url>` + `/plugin install` 后即可 `--channels plugin:claude-discord@jacobbubu`。

### 2. Channel mode 还需 macOS managed-settings 配置

CC v2.1.138 进一步要求第三方 marketplace plugin 必须在 **macOS 系统级 managed-settings** (`/Library/Application Support/ClaudeCode/managed-settings.json`，root 写入) 的 `allowedChannelPlugins` 数组列出，否则 dev flag 也救不了。

落地：README "Channel mode" 章节写明三段配置（marketplace add → managed-settings → `--channels` 启动）。这是 anthropic CLI 设计决定，不是协议 gap。

### 3. Workspace name 撞名自增的具体行为

§4.2 / L127 / L244 写"cwd basename，撞名 +序号"。stage 2 第一版只用 basename 没自增，导致两个 CC 同 cwd 跑时 daemon 互相 boot，触发 reconnect/re-register thrash。

落地（PR #34）：`socket-server.ts handleRegister` 加循环 `<basename>-2`、`-3`、…，1000 次后 `register_reject` 关连接。`log.info` 标 `auto-suffixed`。

### 4. Plugin 在 parent CC 退出时立即退出

原 §4.2 没说 plugin 该如何响应 parent CC 退出。stage 2 实测发现 plugin 不会跟随退出，daemon 也死时进入 ~98% CPU loop、SIGTERM 不响应。

落地（PR #31）：`StdioServerTransport.onclose` + `process.stdin.on('end'/'close')` 双层兜底 → `process.exit(0)`。

### 5. Slash 命令支持 DM context

原架构 §4.3 / Epic 4 假设 slash 命令在 guild channel 用。实测 user 想在 DM 里 `/list` 等，但 per-guild 注册的命令在 DM 里不出现。

落地（PR #35）：每个 SlashCommandBuilder 加 `.setContexts(Guild, BotDM, PrivateChannel)`；`registerSlashCommands` 增加 `Routes.applicationCommands` 全局注册（DM 路径）。Per-guild 注册保留供 instant；global ~1h 传播到 DM。

### 6. Permission DM 主消息折叠 request_id

原 Epic 5 没规定主消息长什么样。stage 2 第一版直接展示 5 字符 `request_id`（"reply with `yes XXXXX`"），UX 反馈过度泄漏内部 token。

落地（PR #30）：主消息只显 `🔐 Permission: <tool>` + description 首行；`request_id` 与 `yes/no XXXXX` 文字回退说明折叠到 "See more" 展开内容里，仅按钮失效场景作兜底。

### 7. Discord rate limit 委托给 SDK

原 NFR-2 写 "daemon 内部统一队列，命中限流时排队，不丢请求"。落地：discord.js v14 REST 自带 429 retry + queue（`retries=3`，`RateLimitData filter`），SDK 直接满足 spec。daemon 加了 `client.rest.on('rateLimited', ...)` 监听日志（NFR-4 可观测性，PR #37），未做 daemon-level 队列。

### 8. 测试架构

原 §10 写 Unit / Integration / E2E / Live，stage 2 落地为 4 档：

| 档 | 工具 | 默认 |
|---|---|---|
| Unit + Integration | vitest，184 tests | ✅ |
| Controlled e2e（mock-plugin 真 socket） | 9 文件 / 18 用例 | ✅ |
| Live e2e #1（真插件 + MCP SDK + mock client） | 1 用例 | ✅ |
| Live e2e #2（真 `claude --print` + mock client） | 1 用例 | gated `CLAUDE_DISCORD_LIVE=1` |

总覆盖率 77.08%（CHANGELOG 0.0.3）。真 Discord 一次性走完 LIVE_TEST.md 全套人工 walk-through。

### 9. 仍未实施的欠账

- **SC-1 7 天 soak**：`scripts/perf-sample.sh` 已写，daemon 还没挂 7 天采样
- **FR-5.4 embed 总结**：PRD 自标 P2 day-2，跟踪 #38
- **rate limit daemon-level retry queue**：当前完全委托 discord.js
- **NFR-1 idle CPU/内存压测**：未量化

详见 `_bmad-output/verification-matrix.md` + `_bmad-output/fr-audit-reviewed.md`。

### 10. Plugin 按 parent CC channel-mode 条件连接 daemon

原 §4.2 / FR-2.1 写 "CC 启动时 plugin 自动连接 daemon"——隐含 always-connect。实测发现：

- 用户机器上同时跑多个 claude TUI（不同项目、cmux session 等）每个都自动加载本 plugin 并 register 到 daemon
- daemon registry 充斥"客串"workspace（不真为 Discord 服务的 console-only CC）
- inbound fallback 路由可能落到这些"客串"workspace，那边的 CC 不在 channel mode、无法响应
- 用户体验：在 Discord 发消息没反应，daemon log 看到路由到的 workspace 名跟期望不符

**修订（codex/conditional-connect 在做）**：plugin 启动时通过 parent cmdline 探测当前 CC 是否在 channel mode 引用了**本 plugin**，是才连 daemon，否则保持 MCP server 起着但跳过 socket connect。

判定：

1. **plugin 标识权威源**：从 `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` 读 `name` 字段（不在 plugin code 里写死，重命名 plugin 自动跟随）
2. **parent cmdline 探测**：`ps -p ${process.ppid} -o command=` 拿到 CC 完整启动命令，含 `plugin:<myName>@*` 字符串则视为对本 plugin 的 channel 引用（同时覆盖 `--channels` 与 `--dangerously-load-development-channels` 两路径）
3. **降级保守 connect**：`CLAUDE_PLUGIN_ROOT` 缺失（dev/manual 启动）、`plugin.json` 不可读、`ps` 拿不到 cmdline，一律保守 `connect`（兼容当前行为）
4. **override**：`CLAUDE_DISCORD_FORCE_CONNECT=1` 强制 connect（debug / 特殊部署）

**outbound 影响**：console-mode CC 仍能 spawn plugin、看到 reply 等 5 个 MCP tool，但调用时拿到 `daemon offline / not connected` 错误（沿用现有 `disconnectedResult()`）。等价于不带 channel mode 的 CC 不该用 reply tool。

**对 spec 的关系**：FR-2.1 接收标准里"CC 启动时 plugin 自动连接 daemon"语义保留——plugin 仍在 spawn 时启动且**有意图为 channel mode 服务**就连。条件触发是细化，非反转（spec 隐含的初始假设是"会的 CC 都是 channel mode"，实测发现不是）。

跟踪 PR + tests：实施时一并补 controlled e2e 用例覆盖（mock parent cmdline 路径）。

### 11. `whoami` MCP tool — plugin 自我披露 workspace 身份

PRD §11 Epic 6 列了 5 个 MCP tool（reply / react / edit_message / fetch_messages / download_attachment）。stage 2 真 Discord 实测发现一个 UX 缺口：**user 想知道当前 plugin 注册到 daemon 的 workspace name 是什么**——尤其在 #34（撞名自增）后 workspace 名可能被改成 `<basename>-2` / `-3`，user 在 cc pane 不容易看出来。

plugin 已经在 stderr 写了 `plugin: registered as workspace=<name>`（`src/plugin/index.ts:105`），但 CC TUI 把 MCP server stderr 收走默认不显示，user 要 `claude --debug=mcp` 启动才能看见。

**新增工具** `whoami` — 无参，返回当前 plugin 的运行时身份：

```jsonc
// tool_call
{ "tool": "whoami", "args": {} }

// tool_result
{
  "ok": true,
  "result": {
    "workspace": "claude_discord-2",
    "daemon_socket": "/Users/x/.claude/channels/discord/daemon.sock",
    "agent": "claude-code",
    "plugin_version": "0.0.4",
    "connected": true
  }
}
```

**用法：**

- User prompt: "what workspace am I bound to?" → Claude 调 `whoami` → 回答
- Claude self-introspection: tool 调用后能确认"我现在是 foo-2 而不是 foo"，避免假设错误
- Debug 时 `claude --print "use whoami"` 可一行确认环境

**实施位置：**

- `src/plugin/mcp-server.ts buildMcpServer`：tools list 加一条 `whoami`
- `src/plugin/tool-handlers.ts`：dispatch 路径加 case `whoami` 直接读 plugin 的 `state` 而不是过 daemon（daemon 不知道某个 plugin connection 自报身份是什么——daemon 只知道 conn → workspace 映射）
- 不需要 daemon 端任何改动（whoami 是 plugin-local 信息）

**对 spec 的关系：** Epic 6 工具集从 5 → 6。这是非破坏性扩展，新工具与既有 5 个独立。FR-6.1..6.5 不变；新 FR-6.6 待补（如果走主文档修订路线；当前用 deltas §11 兜底）。

跟踪 PR：实施 + 加 unit test 验证（同样的"日内可被 mock 调用"模式）。

### 12. Bot custom status — 全局可见的 active workspace 指示

PRD §11 FR-7.2 提到 `/use` 切换时发"✅ switched to X"消息（inline 一次性），但消息很快被后续聊天推走，user 在多个 DM / channel 之间切换时**没办法常驻看到"当前 bot 路由到哪个 workspace"**。Discord DM 没有 channel topic 这种 UI 元素，所以 §4.2 / FR-7.1 的 "topic 写当前 workspace" 在 DM 路径下 silently no-op（`slash-commands.ts applyTopic` 检查 `ch instanceof TextChannel` 跳过 DMChannel）。

**新增：每次 `/use` / `/last` 切换时，daemon 同时刷新 bot 的 Discord custom status (presence activity)**，让 bot 头像旁的 `Active: free-research-2` 全局可见——guild member 列表、DM 头像 hover 卡片都能看到。

实施位置：

- `src/daemon/slash-commands.ts handleUse / handleLast`：在 `applyTopic` 之后调用 `gateway.client.user?.setPresence({ activities: [{ name: <workspace>, type: ActivityType.Custom, state: <workspace> }], status: 'online' })`
- 不在 daemon startup 设置初始值——保持 default `online` 让 user 知道 bot 活着，没绑定就没 activity 文字
- guild channel + DM 路径都触发（applyTopic 的 DM no-op 不影响 setPresence）

**已知 trade-off：**

- presence 是全局而非 per-channel/DM —— 一个 bot 只能展示一个 activity 文字
- 多 channel 绑不同 workspace 时，custom status 只反映**最后一次 `/use` 的那个**——足够给 user 一个"我现在主路由到哪儿"的提示，但不是完美的 per-DM 指示
- 不替代 #11 `whoami`（per-plugin 可查询）；两者互补：custom status 给 user 看眼一瞥，whoami 给 Claude / 用户精确询问

**对 spec 的关系：** FR-7.2 "✅ switched to X" 消息保留不变；新增 presence 同步是 UX 增强，**不修改既有验收标准**，纯加项。

跟踪 PR：mock `client.user.setPresence` 验证调用参数；bump 0.0.5 → 0.0.6。

### 13. 取消 inbound 沉默路由 fallback，改为显式提示

PRD §11 FR-7.3 明确把 "没切就打字 = 沉默路由" 当作 feature——channel 没绑定时 daemon 自动 fallback 到 `registry.list().at(-1)`（most-recent registered workspace）并 silent 路由。spec 的假设是"启发式选 most-recent active 比强迫 user 总是 /use 体验更好"。

**stage 2 实测发现这个 feature 不对：**

- pre-#45 时代 console-only CC 会自动连 daemon、污染 registry——fallback 命中"上次启动的"那个 CC，但 user 心里期望的是另一个
- 即使 #45（conditional connect）只让 channel-mode CC 连 daemon，fallback 目标仍随启停顺序漂移；user 无 UI 反馈，体验是"消息发出去石沉大海或被路由到没看到的 CC"
- 跟"channel as slot"的产品理念矛盾——slot 应该 explicit 绑定才有意义，implicit 猜不是 slot

**改动（PR codex/explicit-binding）：** 删 fallback 整段，inbound 没绑定时 daemon 主动回提示：

```
no binding + 0 workspace 在线
  → "no workspace online — start one with `claude --channels plugin:claude-discord@<mp>` ..."

no binding + ≥1 workspace 在线
  → "this channel has no workspace bound. run `/use <workspace>` to bind.
      active workspaces: foo, bar, free-research-2"
```

**对 spec 的关系：** **反转 FR-7.3**——"沉默路由"被取代为"显式提示"。是有意偏离，原 spec 的假设没经实战验证就把 fallback 当 feature；deltas 章节作为修订入口记下来，主文档 FR-7.3 暂不动（reviewer 可看到原意图 + 改回的理由）。

**测试影响：** controlled-e2e #3 / #5 / 09 / 10 等用例之前依赖 fallback 路由，现在需要 user 显式 `routing.set(...)` 后再 inject inbound。已逐个更新断言。

跟踪 PR：bump 0.0.6 → 0.0.7。

### 14. `groupPolicy` — guild channel 默认 open，不再强制 opt-in

PRD §11 / Epic 5 把 guild channel 设计成"必须先 `claude-discord-bot group add <id>` opt-in 才能路由"。这是 spec 的双重 gate（Discord channel 权限 + access.json `groups`），假设 server admin 可能跟 bot operator 不是同一人。

**stage 2 实测发现：**

- 单用户场景（你 = server admin = bot operator = 终端持有人）：双重 gate 是冗余摩擦
- 用户在新频道 @ bot 没反应 → 不知道为什么 → 翻文档发现要 `group add` → 多余步骤
- Discord channel 权限本身就是 access boundary（user 显式邀请 bot 进 channel 才能看消息）

**改动：access.json 新增 `groupPolicy` 字段**

```jsonc
{
  "dmPolicy": "pairing|allowlist|disabled",
  "groupPolicy": "open|opt-in|disabled"
}
```

| `groupPolicy` | 行为 | 不在 `groups` 的 channel |
|---|---|---|
| `open` (新默认) | bot 看到的 guild channel 都路由 | 安全默认（`requireMention: true, allowFrom: []`） |
| `opt-in` (legacy) | 必须显式 `group add` | drop |
| `disabled` | 全部 guild 消息 drop | drop |

`groups` 里显式条目继续起 per-channel override（可设 `requireMention: false` / `allowFrom: [...]`）。

**对 spec 的关系：** 反转默认行为——spec 假设 opt-in 是默认，新默认 open 偏向单用户便利。多人 server 上需要严格的可改回 `opt-in`。`writeAccessFile` 同步改成 `Partial<Access>` 接口（fill 默认值），避免 callers 每次都得指定全部字段。

**测试影响：** `inbound.test.ts` 的 "guild channel without opt-in drops" 测试现在固定 `groupPolicy: 'opt-in'` 验证 legacy 路径。default open 路径在其他用例覆盖。

跟踪 PR：bump 0.0.7 → 0.0.8。

### 15. CC 内置工具的权限请求重定向到 Discord（`PermissionRequest` hook）

PRD §11 Epic 5 设计了 plugin tool 权限的 Q&A 通道（`permission_request` NDJSON + button DM + `yes XXXXX` 文字回退）。但**CC 的内置工具**（Read / Bash / Glob / Edit / Write / Grep 等）权限不走这条 plugin 路径——CC 自己的 tool gate 在 TUI 弹"Do you want to proceed?"，user 在 Discord 端看不到、没法选。

实测痛点：channel-mode CC 收到 Discord 用户发的图片 → 调 `download_attachment`（已 allow）→ 然后调 `Read`（CC 内置）查看文件内容 → CC TUI 弹权限请求，Discord 那头沉默。整个"Discord 自动响应"链路被打破。

**CC 已有 hook 机制**：`~/.claude/settings.json` 的 `hooks.PermissionRequest` 可以挂一个外部命令——CC 触发权限请求时把请求 JSON 通过 stdin 喂给该命令，命令负责"询问用户 + 返回结果"。退出码 0 = allow / 1 = deny / 2 = timeout 或类似（具体 schema 走 CC 协议）。

cmux 已经在用这个 hook（user 当前 settings.json 里能看到）转给 cmux 自家 UI。我们可以在 CC settings 上**并列**挂一个 hook 转给 daemon，让权限请求 fan-out 到 Discord DM。

**设计：**

```
CC 调内置 tool（Read / Bash / ...）
  ↓
CC PermissionRequest hook 触发，spawn `claude-discord-permission-hook`
  ↓ stdin: { tool_name, tool_args, ... }
hook 进程连 daemon socket
  ↓ NDJSON: { type: "cc_permission_request", request_id, tool_name, ... }
daemon permission-relay 复用现有 flow（button DM + claim + TTL）
  ↓
user 点 Allow/Deny in Discord
  ↓ NDJSON: { type: "permission", request_id, behavior }
daemon 回 hook（同 socket 双工）
  ↓
hook process.exit(behavior === 'allow' ? 0 : 1)
  ↓
CC 收到退出码 → 继续 / 拒绝 tool 调用
```

**实施单元：**

1. **新可执行：** `src/cli/permission-hook.ts`（CLI bin entry，shebang `#!/usr/bin/env bun`）。读 stdin → 连 daemon → 等回复 → 退出码。可被 spawn 而非 require'd。
2. **协议扩展：** `src/protocol/schema.ts` 加 `CcPermissionRequestSchema`（区分 plugin permission_request；多一个 source 字段标 "cc-builtin" vs "plugin"）。
3. **daemon 复用 permission-relay：** `permission-relay.ts handleCcPermissionRequest`，DM 文本前缀加 "🔐 CC tool: " 区分。share button + claim + dispatchToHook 逻辑（dispatchToPlugin 改名 dispatchToTarget）。
4. **CLI install-hook：** `bun run src/cli/index.ts install-hook` 子命令——把 hook 配置写进 `~/.claude/settings.json`，幂等（已存在不重复加）。也提供 `uninstall-hook`。
5. **测试：** unit 测 hook stdin/stdout 协议；integration 测 CC permission flow → daemon → mock Discord button → hook exit code。

**Trade-off：**

- 跟 cmux PermissionRequest hook **并存**：CC 会**串行**调用两个 hook（按 settings.json 顺序）。串行 = 用户在 cmux 端 Allow 后我们 hook 才执行；用户体验是先 cmux 弹再 Discord 弹（双重弹窗）。**必须文档化** + 提供"独占模式"开关：
  - `--disable-cmux-hook`（写 settings.json 时把 cmux 那条注释或临时移除）
  - 或推荐 user 手动选一个
- hook 进程 spawn 开销：每次 CC 内置 tool 都启一个 bun 子进程（~50-100ms cold-start）。批量调 Read 时累积。**优化候选**：hook 进程改成长寿命 daemon-side bridge，CC 启动后预热（day-2）
- timeout 处理：daemon TTL 过期 → hook 怎么知道？需 socket-level timeout（hook 等不超过 N 秒）+ 默认 deny

**对 spec 的关系：** Epic 5 当前只覆盖 plugin tool 权限。新增"CC 内置 tool 权限路由"是扩展，主文档不动；deltas §15 收口。

跟踪 PR：分两步——
- **PR a (spec only)**：本提交，添加 §15 spec
- **PR b (implementation)**：随后实施。bump 0.0.8 → 0.0.9。

### 16. 源-决策同源 — 权限请求弹回 prompt 来源所在 chat

§15 实施后实测发现 fan-out 到 DM 的默认有两处问题：

1. **跨 session 卷入**：hook 装在 `~/.claude/settings.json` 是 user 全局生效，所有 Claude session（cmux session、其他项目 console-only Claude）都触发 hook → 它们的 tool 调用都会被卷到 Discord 等 user 点按钮，跟它们的实际 prompt 源（cmux UI / 终端）错位

2. **channel-mode 内部源-错位**：即便确实是 channel-mode CC，user 从 guild channel A 发的 prompt 触发的工具权限被弹到 DM，user 仍然要换地方看才能批准

**理想原则：源-决策同源** — 权限请求弹回它实际的来源 chat：

| Prompt 源 | 期望权限弹位置 |
|---|---|
| cc TUI 直接打字（cmux / console-only） | cc TUI（默认 flow） |
| Discord DM | 同一 DM |
| Discord guild channel A | guild channel A（同 channel 的 allowFrom 用户都能看到） |

**实施分两层：**

**层 1：hook 早退（解决跨 session 卷入）**

`src/cli/permission-hook.ts` 启动后立即探测 parent CC 是否 channel-mode（复用 PR #45 `src/plugin/connect-policy.ts` 的 `decideConnect` 同款 ppid + cmdline + plugin.json 检测）。**不在 channel-mode 立即 emit `'ask'` 退出**，让 CC 走默认 permission flow。这样 cmux / console-only / 别的 channel-mode-not-us 的 Claude session 不再被卷入。

**层 2：hook 把权限请求路由回原 chat（解决 channel mode 内部错位）**

hook 把 `cwd` (`process.cwd()`) 加进 `cc_permission_request` schema（新可选字段）；daemon 用 cwd 在 registry 反查这个 workspace 的 connection。daemon 端：

- `Connection` 加可选字段 `lastInboundChatId: string | null`
- `inbound-router.ts` 路由 inbound 给 plugin 之前，给 conn.lastInboundChatId = msg.channelId
- `permission-relay.handleCcRequest` 现在用这条信息：
  - 找到匹配 cwd 的 conn → 有 `lastInboundChatId` → 把按钮消息**发到那个 chat_id**（不再 fan-out DM）
  - 找不到 / 没 lastInboundChatId → fall back 到 §15 的 fan-out allowFrom DM（保留兜底）

**协议扩展：**

```jsonc
{
  "type": "cc_permission_request",
  "v": 1,
  "request_id": "...",
  "tool_name": "Bash",
  "description": "...",
  "input_preview": "...",
  "cwd": "/Users/x/project"   // 新加，optional
}
```

**边界：**

- DM 入站 → lastInboundChatId 是 DM channel id → 按钮发 DM ✓
- guild channel 入站 → 按钮发 guild channel（@allowFrom 用户能看到）✓
- channel-mode CC 但 user 在 TUI 直接打字（罕见）→ lastInboundChatId 还是上次 Discord 入站的 chat_id，按钮发错位置但不致命；或者 cwd 反查不到 conn → fall back DM（也错位但更少见）
- 多 user channel：按钮所有 allowFrom 都能点，先点者赢（claimPending 已 atomic）

**对 spec 的关系：** §15 的 hook 行为有缺陷 — fan-out 全部 DM 是过宽默认。§16 是对 §15 的修订（不是反转）：fan-out 仍作为 fall back 保留，但精确路由优先。

bump 0.0.10 → 0.0.11。

### 17. `groupPolicyDefaults` — 无需逐 channel 关闭 mention

§14 的 `groupPolicy: open` 让 bot 看得到的 channel 默认可路由，但用安全 fallback `requireMention: true`——单用户场景下"每个新 channel 都要 group add 一遍才能不 @"是冗余摩擦。

新增 `groupPolicyDefaults` 字段，只在 `groupPolicy === 'open'` 时生效：

```jsonc
{
  "groupPolicy": "open",
  "groupPolicyDefaults": {
    "requireMention": false,    // 新 channel 不用 @ 也能路由
    "allowFrom": []             // 不限定 user (谁都行)
  }
}
```

`groups` 里显式条目继续 per-channel override 优先（先看 explicit，再看 defaults，再回到硬安全 fallback `requireMention: true`）。

**安全设计：**

- 仅 `open` 政策下读 defaults — `opt-in` / `disabled` 仍按原语义忽略 defaults
- `defaults` 字段缺省（旧 access.json）等价于"安全默认"`{requireMention: true, allowFrom: []}`，**不破坏既有行为**
- user 显式选 `requireMention: false` 是知情同意 — 该 admin 自己设定的 prompt-injection 暴露面

**对 spec 的关系：** §14 引入 `groupPolicy`，§17 是 §14 的细化扩展，不是反转。FR-7 系列不动。

bump 0.0.11 → 0.0.12。

### 18. Hook 探测 claude ancestor 而不是 immediate ppid（§16 fix）

§16 hook 用 `process.ppid + ps` 探测 parent 是否 channel-mode。但实测发现 spawn 链是 `CC → bash -c "bun run permission-hook.ts" → bun → permission-hook.ts`，`process.ppid` 拿到的是 bash/bun，不是 CC。结果 hook 当成"探测失败 → 保守 connect" → 卷入 cmux this Claude（不带 `--channels`）。

**修：** 新加 `findClaudeAncestorCmdline()` 递归 walk parent process chain，最多 8 层，找到第一个 cmd basename === `claude` 的进程。plugin 路径不受影响（CC 直接 spawn plugin 第 1 层就找到）；hook 路径终于能找到真正的 CC。

bump 0.0.13 → 0.0.14。

### 19. `lastInboundChatId` TTL + cc TUI fallback — **superseded by §27**

原占位（"待讨论"）。落地见 §27（inbound 新鲜度 TTL + 权限提示 Discord↔TUI 路由 + hook 有界等待 + hook 放弃时收掉按钮）。本节不再单独实施。

### 20. "Allow always" 按钮 — 写 tool 到 settings.json

§15 + §16 实施后，channel mode 每个 Bash / Edit / Write 调用都要 user 点 "Allow"，重复操作烦。CC 自家 TUI 弹窗有"Yes, and don't ask again for ... in `<cwd>`" 选项写 settings.json `permissions.allow` 后续不再问。我们 button row 缺这个，导致同样的工具反复触发权限请求。

**实施：**

- permission-relay.ts handleRequest button row 加 "Allow always" 按钮 (customId `perm:always:<rid>`)
- handleButton 加 'always' 分支：
  - 仍然 claim pending 走 atomic（防 race）
  - dispatch `allow` 给 hook（这次允许）
  - **同时**把 `tool_name` 写进 `~/.claude/settings.json` 的 `permissions.allow`（idempotent）
  - update message 标 "✅ Allowed always"
- 之后 CC 遇到该 tool → settings allow rule 优先于 hook → 自动 pass，hook 不再 spawn

**权限粒度：** 简版只写 `<tool_name>`（如 `Bash`）—— 整个工具名所有调用都通过。后续可加细粒度（`Bash(git *)`）作为 stretch（`§20.1`）。

**安全：** 仅 `allowFrom` 用户能点（已有的 button auth 检查）；user 等于在自家终端勾"don't ask again"，等价。

**对 spec 的关系：** Epic 5 / FR-5 的 plugin 权限 Q&A 协议不动；本扩展只丰富 CC 内置 tool（hook 触发的）那条路径的 button row。

bump 0.0.14 → 0.0.15。

### 21. Hook 探测 `--dangerously-skip-permissions` → 直接 emit 'allow'

§18 walker 让 hook 区分 channel-mode（弹 Discord）vs 非 channel-mode（emit 'ask'）。但 channel-mode CC + `--dangerously-skip-permissions` 共存的场景被忽略：CC user 显式说"unattended skip 所有权限询问"，hook 仍发 cc_permission_request 等 Discord 点 button — 矛盾。

**修：** hook 启动时除探测 channel-mode，还查 cmdline 是否含 `--dangerously-skip-permissions`：

- 含 → 直接 emit 'allow'（user 已知情同意）
- 不含 + channel-mode → 走 §16 路径
- 不含 + 非 channel-mode → emit 'ask'

**安全：** 这是 user 启动 CC 的明确 flag，hook 顺从无需额外 confirm。等价 user 跑 console-only `--dangerously-skip-permissions` CC 时 CC 内部不弹的语义。

bump 0.0.15 → 0.0.16。

### 22. Hook 同时检查 settings.allow（§20 真生效）

§20 写 tool_name 到 `~/.claude/settings.json` `permissions.allow`，期望 CC 后续直接通过该 tool。但 CC 的 PreToolUse hook **优先于** settings.allow 跑（hook 总是 spawn，settings.allow 只在 hook 返 'ask' 时才检查）—— 所以 §20 写入对 hook 无效，user "Allow always" 之后仍弹。

**修：** hook 自己读 `~/.claude/settings.json`，检查 `permissions.allow` 命中：

- 完全匹配 `Bash` / `Edit`
- 模式匹配 `Bash(*)` / `Bash(git *)` 等带括号格式（与 CC 自家匹配规则一致）

命中即 emit 'allow' 短路，不调 daemon → 不弹 Discord。

跟 §21 一并 in 0.0.16。

### 23. `thread_reply` MCP tool — 长 reasoning 走 thread

PRD §11 / FR-5.3: "思考过程 / tool trace 走线程回复"。当前 CC 长回复都堆在 channel timeline 里。新加 plugin tool 让 CC 把详细 reasoning 挂到 thread。

**Tool 协议：**

```jsonc
{
  "tool": "thread_reply",
  "args": {
    "chat_id": "<guild_channel_id>",
    "parent_message_id": "<bot's main reply id>",
    "name": "reasoning",
    "content": "<long markdown>"
  }
}
// returns
{ "ok": true, "result": JSON.stringify({ thread_id, message_id }) }
```

**用法 pattern**（教 CC 写进 mcp-server.ts `instructions`）：

```
1. 主消息：调 reply 发短结论，记下返回 message_id
2. 调 thread_reply(chat_id, message_id, "reasoning", "<完整推理>")
3. 之后详细输出用 thread_id 当 chat_id 继续 reply / edit_message
```

**实施单元：**

- `src/plugin/mcp-server.ts` TOOL_DEFS 加 `thread_reply`
- `src/daemon/tool-handlers.ts` 加 `toolThreadReply`：调 `channel.threads.create({ name, startMessage: parent_message_id })` 然后 `thread.send(content)`，返 `{ thread_id, message_id }`
- DM channel：tool 直接 fail 返 "DM channels don't support threads; use inline reply"
- thread 默认 public（user 已 admin 权限 + bot Has Create/Send-in-Public-Threads）
- access control：thread 不 fan-out access check（parent channel 已 opt-in 即可；thread 继承 channel 权限）

**测试：** controlled e2e mock-client `channel.threads.create` 已支持，加 1 个用例验证调用参数 + 返回结构。

bump 0.0.16 → 0.0.17。

### 24. PostToolUse hook 自动转发 tool trace 到 thread

§23 把"长 reasoning 走 thread"交给 CC 自觉，但 CC 对简单查询（如"最后提交什么"）只发结论，中间 `git log` 等 tool 调用对 user 不可见。本节加 PostToolUse hook 把 channel-mode CC 的每次工具调用自动 push 到对应 Discord thread，让 user 能 audit 全过程。

**前提与边界：**

- CC hooks 暴露 tool input + response，但 **不暴露 thinking**（reasoning 内容）。本节只覆盖 tool 链；thinking 仍由 §23 instructions 兜底（CC 在 thread 首条自述意图）。
- 仅 channel-mode CC 触发（hook 用 §18 walker 探祖先 cmdline 有 `--channels`，非 channel-mode 直接 return）。

**消息协议（新增）：**

```typescript
CcToolTraceSchema {
  type: 'cc_tool_trace',
  v: 1,
  tool_name: string,
  tool_input: string,    // JSON.stringify(input)，超 1800 截断尾部
  tool_response: string, // string 或 JSON.stringify(response)，超 1800 截断
  status: 'ok' | 'error',
  cwd?: string,          // hook 写入，daemon 反查 channel-mode connection
}
```

加入 `WireSchema` discriminatedUnion（13 种 type）。Hook 走与 `cc_permission_request` 相同的 anonymous TCP/socket 连接，daemon 不 require register。

**Skip 列表（hook 端）：**

- plugin 自家 tool：`reply` / `edit_message` / `react` / `thread_reply` / `whoami` / `fetch_messages` / `download_attachment` —— 避免回环和冗余。
- 内部状态：`TodoWrite` —— 纯 CC 内部 task 跟踪，对 user 无信息量。

Skip 直接在 hook 早返回（不连 daemon），减负载。

**Daemon 端：thread 复用策略**

每个 channel-mode connection 维护 `activeTraceThread: { thread_id: string, parent_chat_id: string } | null`：

- inbound 到达时 **清空** `activeTraceThread`（新一轮 turn 起点）
- 第一次收到 `cc_tool_trace` 时：
  - 用 `lastInboundChatId`（§16）作 parent channel
  - 若该 chat 是 DM → 直接 drop trace（DM 不支持 thread）
  - 否则 `channel.threads.create({ name: "trace · <inbound preview 前 40 字>", autoArchiveDuration: 60 })` → 缓存到 `activeTraceThread`
- 之后所有 trace 直接 `thread.send(embed)`

**Embed 格式：**

```
title: "🔧 <tool_name>" (status='error' 时改 ❌)
description: 代码块
  Input:
  ```json
  <tool_input>
  ```
  Output:
  ```
  <tool_response>
  ```
footer: ts
```

>4000 字符整 embed 截断（Discord embed.description 上限 4096）。

**CLI 集成：**

- 新子命令 `claude-discord post-tool-use-hook`，从 stdin 读 `{ tool_name, tool_input, tool_response, cwd, ... }`（CC hook protocol JSON），构 `CcToolTraceSchema` 发 daemon。
- `install-hook` 写 settings.json 时除 PreToolUse 外再写 PostToolUse 块，matcher 同 `*`。
- `uninstall-hook` 同步移除。

**测试单元：**

- hook：skip 列表、截断、非 channel-mode 直返、连不上 daemon 不抛
- daemon：第一次 trace 建 thread；后续复用；inbound 重置；DM drop；embed 字段
- protocol：schema roundtrip

**风险与回滚：**

- thread 数量爆炸：每个 inbound 一个 thread，长时间会膨胀。`autoArchiveDuration: 60`（1 小时不活跃归档），Discord 自动管理。后续可加 stretch §24.1 限频。
- hook 阻塞 CC：fire-and-forget；写 daemon 超时 200ms 后直接 return，绝不卡住 user 的 tool 执行。

bump 0.0.17 → 0.0.18。

### 25. Instructions 强化：tool 调用前先说意图，补 thinking 缺口

§24 把 tool 调用自动转发到 thread，但 CC hook 不暴露 thinking，user 看不到 CC "为什么这么做"。完整 thinking 转发要走 SDK 程序化模式（重，破坏 TUI 交互），先走轻量路径：**强化 mcp-server.ts instructions，让 CC 在工具调用前主动写 1-2 句意图**。

**新增指令（mcp-server.ts INSTRUCTIONS）：**

> When answering needs tools (Bash / Read / Edit / Grep / WebFetch / ...), FIRST send a short reply (≤2 sentences) stating your intent or plan, THEN run the tools, THEN send a follow-up reply with the result (or edit_message the intent reply). The daemon auto-collects each tool call into a thread under your channel reply — without the intent line the user sees a thread of tool I/O with no "why".

**实施细节：**

- 把 instructions 数组抽成顶层 `export const INSTRUCTIONS` —— 便于单测断言关键指令存在
- 不影响代码路径，纯模型 prompting 改动
- 覆盖率取决于模型自觉，估计 60-80%

**测试：** 新增 `src/plugin/__tests__/mcp-server.test.ts` regression guard，断言每条指令的关键词存在（避免后续误删）。

bump 0.0.18 → 0.0.19。

### 26. channel ↔ workspace 强制 1:1（`/use` 冲突时确认抢绑）

**问题。** routing 表是 `channel → workspace` 多对一 —— 两个频道都可以 `/use` 绑到同一个 workspace。CC 一条一条处理 inbound，但 `conn.lastInboundChatId` 是单槽、最后到达者赢；A、B 都喂同一个 CC 时，CC 在处理 A 那条产生的 tool trace（§24）/ 权限弹窗（§16）会被路由到 B（槽里是后到的 B）。channel-as-slot 的设计意图本来就是"一个 channel 一个 workspace"，多对一是个没设防的漏洞。

**不解决 §19。** §19 是 `lastInboundChatId` **陈旧**（用户跑去终端、Discord 半天没动静）；本节是**歧义**（哪个频道算源）。正交。但 1:1 让源唯一，§19 后续做 TTL 时判断更干净。

**行为。** `/use <ws>` 在频道 B：
- `<ws>` 没被任何频道绑 → 直接绑（现行 + §67 健康后缀）
- `<ws>` 已被 B 自己绑 → 当刷新，直接确认（仍重设 topic/presence）
- `<ws>` 已被**别的**频道 A 绑 → **先不绑**，回带按钮的 ephemeral 消息：
  > `<ws>` 当前绑在 <#A>。`[Move it here]` `[Cancel]`
  - `Move it here`（customId `use-move:<ws>`）→ 重新查 `<ws>` 当前绑哪些频道 → 逐个 `unset` → `set(clickChannel, <ws>)` → 重设 topic/presence → 编辑消息成 `✅ moved to here (was <#A>)`
  - `Cancel`（customId `use-cancel`）→ 编辑成 `cancelled`
  - 按钮只有 `allowFrom` 用户能点（复用现有 button auth）；点击时重新查当前绑定（防两次点击间状态变），幂等

**实施单元。**
- `RoutingTable` 加 `unset(channelId): void`（删条目 + 持久化）和 `channelsFor(workspace): string[]`（反查）
- `handleUse` 加冲突检测 + 按钮分支
- `attachInteractionHandler` 的 `isButton()` 分支在 `buttonIntercept` 之前先处理 `use-move:` / `use-cancel`（slash 自己的按钮，不走 permission relay 那条 intercept）
- daemon 重启时不主动清理老的多对一脏数据 —— 下次谁 `/use` 谁那条被清理就够了

**测试。** 无冲突直接绑 / 同频道刷新 / 冲突弹按钮不绑 / 点 Move → 旧绑定清掉新绑定建立 + topic/presence 重设 / 点 Cancel → 状态不变 / 非授权用户点按钮被拒。

**对 spec 的关系。** Epic 4 的 channel-as-slot 路由不动；本节把"一个 channel 一个 workspace"从约定变成强制。FR-8（slash 命令）扩展，不反转。

bump 0.0.23 → 0.0.24。

### 27. 权限提示 Discord ↔ TUI 路由：inbound 新鲜度 TTL + 有界等待 + hook 放弃时收掉按钮

**问题。** §16 把 CC 内置 tool 的权限弹窗路由到 `conn.lastInboundChatId`（最近一次 Discord 消息来的频道）。但这个值不过期：你在频道 C 干完一轮，再去终端直接给同一个 CC 发 prompt，CC 跑工具 → PreToolUse hook 发 `cc_permission_request` → daemon 还是把 Allow/Deny 按钮 DM 发到频道 C → 你人在终端看不到 → CC 的工具卡住，hook 超时是 **1 小时**。同理 §24 的 tool trace 会被 post 进频道 C 上一轮的 trace thread，污染频道。daemon 分不清"这次 tool 调用属于 Discord 那轮还是终端那轮" —— hook 只带 `cwd`，CC 不回报"我在处理非 Discord 的 prompt"。

**不能根治"切到终端后短时间内"的窗口** —— 那要让 CC 在 MCP 回路里带回 source chat_id，超出本节范围。本节用"最近一次 Discord inbound 有多久了"当代理：超过 TTL → 认定"这个 workspace 当前不是 Discord 驱动的"。

**改动。**

- `Connection` 加 `lastInboundTs: number | null`（`inbound-router` 在设 `lastInboundChatId` 时一并设）+ `isInboundFresh(ttlMs = INBOUND_FRESHNESS_TTL_MS): boolean`。`INBOUND_FRESHNESS_TTL_MS` 默认 15 分钟。从没收过 inbound（`null`）算"不新鲜"。
- **权限路径**：`permission-relay.handleCcRequest` 先按 cwd 找 conn，若 `!conn.isInboundFresh()` → 立刻在 hook conn 上回一条新消息 `cc_permission_defer { request_id }`（**不创建 pending、不发 DM**）→ hook 收到 → `emitDecision('ask')` → CC 用自己的 TUI 弹窗（你人在那）。新鲜则照旧创建 pending + 发按钮 DM。
- **trace 路径**：`ToolTraceRelay.handle` 加 `if (!conn.isInboundFresh()) return`（drop，别污染频道）。trace 是 fire-and-forget，不需要回 hook 任何东西。
- **PreToolUse hook 有界等待**：`permission-hook.ts` `TIMEOUT_MS` 从 1h 砍到 **3 分钟**。新鲜 conn 等不到点击就回退 TUI；陈旧 conn 根本不等（拿到 `cc_permission_defer` 立即回退）。`askDiscord` 返回类型扩成 `'allow' | 'deny' | 'defer'`，`main()` 里 `'defer'` → `emitDecision('ask', ...)`。
- **hook 放弃时收掉按钮**：`permission-relay.handleRequest` 给 hook target 在 `conn.socket.once('close', ...)` 上挂 `handleHookGiveup(request_id)` —— hook 进程退出（超时 emit 'ask' / 被杀 / CC 死）时 socket 关闭：若该 `request_id` 的 pending 还在（没被 `handleButton` claim 掉）→ 删 pending + 把按钮 DM 编辑成「⌛ 已在别处处理 — 此按钮已失效」。若 pending 已被 claim（用户点了按钮，hook 收到答案后正常退出）→ 找不到 pending → no-op。

**新协议消息。** `CcPermissionDeferSchema { type:'cc_permission_defer', v, request_id: /^[a-km-z]{5}$/ }` 加入 `WireSchema`。匿名 hook conn 上单向（daemon → hook）。

**与 §19 的关系。** §19 当时只是占位（"`lastInboundChatId` TTL + cc TUI fallback，待讨论"）—— 本节就是它的落地，范围锁定在权限 + trace 两条路径，多源歧义那块明确不在内。§19 标记为 superseded by §27。

**与 §21 的关系。** `--dangerously-skip-permissions` 的 CC，hook 在 §21 那步就 emit 'allow' 了，根本不碰 daemon —— 本节的权限部分只对没带该 flag 的 CC 生效。trace 部分不受 §21 影响。

**测试。**
- `Connection.isInboundFresh`：null → false；刚设 → true；超 TTL → false
- `handleCcRequest`：陈旧 conn → 回 `cc_permission_defer`，不创建 pending、不发 DM；新鲜 conn → 照旧
- `ToolTraceRelay`：陈旧 conn → drop（不建 thread）
- `permission-hook`：收到 `cc_permission_defer` → emit 'ask'
- `handleHookGiveup`：pending 还在 → 删 + 编辑消息；pending 已被 claim → no-op
- schema：`cc_permission_defer` roundtrip

bump 0.0.24 → 0.0.25。

### 28. plugin 父进程探活 — 第三道反僵尸防线

**问题。** plugin 自杀靠两道机制：`mcp-server.ts` 的 `transport.onclose = () => process.exit(0)`（stdio 管道关闭）和 `index.ts` 的 `process.stdin.on('end'/'close', () => process.exit(0))`。这俩覆盖绝大多数情况（父 CC 正常退出、被 SIGKILL —— OS 都会关掉 stdin 管道）。但历史上仍出现过僵尸 plugin（多是 0.0.x 早期版本，那时这两道还没加）；理论上也存在"stdin close 事件因某种原因没派发"的极端情况。

**改动。** 加第三道：plugin 启动时记下真实父 pid（`process.ppid`），定期（5s）检查 `process.ppid` 是否变了 —— 父进程一死，孤儿就被 reparent 到 launchd/init（pid 1），`process.ppid` 随之改变。这个信号比 `kill(originalPpid, 0)` 稳（后者会被 pid 复用骗到）。变了 → `process.exit(0)`。

- 新模块 `src/plugin/orphan-watcher.ts`：`startOrphanWatcher({ originalPpid, getPpid?, onOrphan?, intervalMs? })` → `{ stop }`。`getPpid`/`onOrphan` 可注入，便于单测；默认 `() => process.ppid` / `() => process.exit(0)` / 5000ms。timer `.unref()`，不阻止进程退出。
- `index.ts` 启动末尾调一次 `startOrphanWatcher({ originalPpid: process.ppid })`。
- 不特判"启动时 ppid 已是 1"（plugin 总是 CC 的子进程，不存在这种情况）。

**测试。** ppid 不变 → 不触发；ppid 变（父死→reparent）→ 触发一次；`stop()` 后不再触发；`stop()` 幂等。用 vitest fake timers。

bump 0.0.25 → 0.0.26。

### 29. `/use` `/status` 改用静态 choices —— Discord mobile 友好

**问题。** Discord mobile 客户端键盘无 Tab 键，slash 命令的 autocomplete（输入触发的 suggestion 列表）很难自然触发 —— 用户得 tap 参数 chip、开始打字、再 tap 建议。改用 **静态 choices**（参数固定下拉列表）后，mobile 上点开参数就直接出下拉，一 tap 选定，跟 PC 上的体验一致。

**代价。** choices 是注册时固化的，workspace 上下线时 daemon 必须**重新注册** slash 命令；Discord 全局命令注册有速率限制（每个 app 每天 ~200 次），还有传播延迟（修订后一般几秒到几分钟内 mobile/desktop 客户端收到）。choices 上限 **25 个**（够用）。

**改动。**

- `buildCommandList(workspaces: string[])` —— `/use` `/status` 的 `workspace` 参数在 `workspaces.length > 0` 时用 `.addChoices(...)`（取前 25）；否则退到普通 string 参数（无 choices、无 autocomplete，因为本来也没东西可选）。`setAutocomplete(true)` 删除。
- `registerSlashCommands(client, token, rest?, getWorkspaces?: () => string[])` —— 新增可选 `getWorkspaces` 回调；每次注册时拉当前列表传给 `buildCommandList`。老调用者不传 = 空列表 = 老行为（无 choices）。
- `WorkspaceRegistry.onChange(fn): () => void` —— register / unregister / unregisterByConnection / 容量驱动 eviction 后触发，返回取消订阅函数。
- `daemon/index.ts` —— `clientReady` 之后首注册；订阅 `registry.onChange`，以 500ms 防抖触发"重算 workspace 列表，若与上次注册的不同则再 PUT 一次"。Helper `workspaceListChanged(prev, curr)` 为纯函数便于单测。
- `attachInteractionHandler` 中的 autocomplete 分支保留为空响应（兜底；choices 模式下 Discord 不会触发，但偶尔可能在传播间隙收到旧 client 的 autocomplete 请求）。

**风险。**

- 注册速率限制：debounce 500ms + 仅在列表实际改变时才重注册，覆盖一般的 register/unregister 抖动；极端的高频上下线场景理论可能触发限流，daemon 会 log.warn 但不中断。
- 命令传播延迟：刚启动的 CC 不会立刻出现在 mobile 客户端的 /use 下拉里；mobile 客户端打开 slash 菜单时通常会重新拉一次，几秒内可见。

**测试。** `buildCommandList([])` workspace 参数无 choices；`buildCommandList(['foo','bar'])` 有 2 项 choices；26 个 workspace 只保留前 25；`workspaceListChanged` 顺序无关比较；`WorkspaceRegistry.onChange` 在 register/unregister/eviction 后触发，返回的 unsubscribe 能停。

bump 0.0.26 → 0.0.27。

### 30. daemon `clientReady` 启动宽限 — 首次 slash 注册等 plugin 重连一下

**问题。** §29 的 daemon 启动流程是：`clientReady` 立即调 `registerSlashCommands(...)`，用当时 `registry.list()` 的快照。但 daemon 重启时，已存在的 plugin 进程要走 reconnect 流程（exponential backoff，~几百毫秒到 1s）才重新 `register`。所以首次注册时 `currentWorkspaces()` 大概率是空的 → 首次 PUT 的 `/use` 没 choices（退化成 plain string）。几秒后 `onChange` 触发 debounce 500ms 再 PUT 一次正确的 → mobile 用户若刚好在那 1-2s 窗口打开 `/use` 会看到空下拉，刷新一次（关重开 Discord）才正常。

**改动。** `clientReady` 之后等 2 秒再首次注册 —— 给本地 plugin 留 reconnect + register 的时间。代价：全新安装（没任何 CC 在跑）cold-start 时 slash 命令晚出现 2 秒，可忽略。

- `daemon/index.ts` 在 `clientReady` 回调里、首次 `registerSlashCommands` 之前 `await new Promise(r => setTimeout(r, STARTUP_GRACE_MS))`，常量 2000ms
- 宽限期间没有 `onChange` 订阅（订阅在首次注册之后），所以并发 register 只更新 registry，不触发任何 PUT
- 宽限结束 → snapshot `currentWorkspaces()` → 注册 → 挂 `onChange` → 之后按 §29 行为

**测试。** 这段是 daemon entry 的编排，难单测；改动只有两行（一个 setTimeout + 一个常量）。手动验证：kill daemon 重启 → 1-2 秒内打开 mobile Discord `/use` → 仍能看到刚才那批 workspace。

bump 0.0.27 → 0.0.28。

### 31. daemon 自持日志文件 + size-based 轮转

**问题（#85）。** `logger.ts` 全走 `process.stderr.write`，daemon 进程不持有日志文件 FD。`nohup bun run ... >> daemon.log` 是 shell 的 redirect，daemon 内部 `rename` 没用（shell 的 append FD 仍指向旧 inode）。日志无限增长，长期跑会撑爆磁盘。

**设计。** daemon 自己 open 一个 append FD，每次 `log.*` 同时写它；写完看大小，超阈值就在进程内做 size-based rotate。stderr 写法保留（前台调试 / nohup redirect 仍可见）。

**实施单元。**
- `src/shared/paths.ts` 加 `daemonLog: join(stateDir, 'daemon.log')`。原有 `outLog`/`errLog`（launchd plist 用）保留向后兼容。
- `src/shared/logger.ts` 重构为多 writer：内部 `writers: ((line: string) => void)[]`，默认只有 stderr writer。新增 `attachFileSink({ path, maxBytes = 10*1024*1024, keep = 4 }): { detach(): void }`：用 `openSync(path,'a')` 持 FD；每次 `log.*` 后通过 writer 数组同步 `writeSync(fd, line)`，写完 `fstatSync(fd)` 检查 size；超 `maxBytes` 触发 `rotate()` —— `closeSync(fd)` → 从 `.${keep-1}` 一路 `renameSync` 到 `.${keep}`（最老的被覆盖丢弃）、`current → .1` → `openSync` 新 FD。`detach` 移除 writer + 关 FD。
- `src/daemon/index.ts` 在 `initStateDir` 之后立即 `attachFileSink({ path: paths.daemonLog, ... })`。daemon 退出时不主动 detach（进程退出会自动关 FD）。
- `src/cli/logs.ts` 优先看 `paths.daemonLog`（含 `.1..4` rotated）；没有再 fall back 老的 `outLog`/`errLog`。
- 不动 install.ts / launchd plist 生成（让 daemon 自己的 rotate 跟 launchd 的 `StandardOutPath` 并存即可，后者保持原状）。

**测试（vitest tmp 目录）。**
- `attachFileSink` 把 log 行写入指定文件
- 写够 `maxBytes` 触发一次 rotate：原文件变 `.1`、新文件出现、内容分开
- 多次触发：累计 rotation 不超过 `keep` 份（最老的被丢）
- `detach()` 之后再 log 不写文件、原 FD 关闭

**已知非干净点（写进 PR 描述）。** 本 session 里手动启动 daemon 用了 `nohup ... >> daemon.log` redirect，新 daemon 也会打开同一个 `daemon.log` 持 FD。`O_APPEND` 内核保证不撕裂、但同一行会落两遍。第一次 rotate 后 shell FD 指着改名后的 `.1`、daemon 写新文件，之后两边分离。后续重启 daemon 时把 `>> daemon.log` 去掉就干净。

bump 0.0.28 → 0.0.29。

### 32. FR-5.4 结构化总结走 embed (PRD §11 / #38)

**背景。** PRD §11 唯一未实现的 FR：`reply` 工具支持 Discord embed —— 含 title / description / fields，总字符 ≤ 6000。日常对话纯文本 chunk 已够；这条用于结构化总结（任务报告、PR review 摘要等），渲染更友好。

**改动。**

- `reply` 工具 inputSchema 加可选 `embed?: { title?: string, description?: string, color?: number, fields?: Array<{name:string, value:string, inline?:boolean}> }`
- `toolReply`：当 `embed` 存在时构造 `EmbedBuilder` 一并发；**embed 模式跳过 chunking**（description 自带 4096 容量，embed 自身用来装长文），content 期望短（≤ 2000）
- 抽出纯函数 `validateEmbed(input): {ok, embed, totalChars}` 校验所有 Discord 上限：
  - title ≤ 256；description ≤ 4096；fields ≤ 25 项
  - 每 field name ≤ 256，value ≤ 1024
  - **总字符 ≤ 6000**（title + description + 所有 field 的 name + value 之和）
  - 任一上限超出 → `fail(...)` 不发
- `mcp-server.ts` instructions 加一句指引：长结构化总结用 embed（标题/分段）+ 短 content 引语
- `MockMessage`/`MockClient` 的 `send` 也接受 `embeds`，记录在 message 上，便于 e2e 断言

**测试。** `validateEmbed` 单元覆盖所有上限分支；`toolReply` e2e 验证 embed 模式发 1 条消息（不 chunk）、mock channel 历史里能看到 embed 字段。

bump 0.0.29 → 0.0.30。
