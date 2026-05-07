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
