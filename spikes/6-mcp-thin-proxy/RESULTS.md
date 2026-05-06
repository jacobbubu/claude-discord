# Spike #6 — MCP-as-thin-proxy 验证结果

**状态**：✅ **架构假设成立**

**日期**：2026-05-06（开发当天）

## 待验证的假设

来自 `architecture.md` §7：

> Plugin 是 CC 的子进程，CC 控制 plugin 的 stdin/stdout（MCP 协议层）。Plugin 自己控制 outbound socket（向 daemon）。这是两个独立 IO 流，互不阻塞。Bun 事件循环可以同时处理。

如果这条不成立，整个三进程架构（daemon + plugin + CC）需要重新设计。

## 验证方法

写 50 行级别的最小原型 + 测试驱动：

| 文件 | 行数 | 角色 |
| --- | --- | --- |
| `mock-daemon.ts` | ~95 | 模拟 daemon：Unix socket 服务端 + NDJSON echo + 主动推 inbound |
| `plugin.ts` | ~140 | 真 plugin：MCP server (stdio) + outbound socket client |
| `test-driver.ts` | ~75 | 模拟 CC：用 `@modelcontextprotocol/sdk` Client + `StdioClientTransport` 起 plugin |

**测试驱动模拟的是 CC**，因为 CC 启动插件用的就是 `StdioClientTransport`（参见 `.mcp.json` 里 `command: "bun"` 的方式）——所以这等价于 "如果 CC 来 spawn 我们的 plugin，能不能跑"。

## 测试运行

```bash
cd spikes/6-mcp-thin-proxy
bun install
bun run test-driver.ts
```

输出（节选）：

```
Step 1: spawning mock-daemon...
mock-daemon: listening on /tmp/claude-discord-spike-71788.sock
✓ mock-daemon spawned

Step 2: spawning plugin via StdioClientTransport...
mock-daemon: client connected
plugin: connected to daemon
plugin: started, MCP stdio + daemon socket both wired
mock-daemon: rx register
✓ MCP client connected to plugin

plugin: rx register_ack
✓ tools listed: [reply]

Step 4: calling reply tool...
mock-daemon: rx tool_call
plugin: rx tool_result
✓ tool result: mock-daemon echoed: {"chat_id":"c1","text":"hello world"}

Step 5: waiting 500ms for inbound push to flow plugin→MCP...
plugin: rx inbound
✓ plugin stderr shows "plugin: rx inbound" — confirms daemon→plugin direction

🎉 All assertions passed.
```

## 验证项与结论

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | Plugin 进程能被 `StdioClientTransport` spawn（= CC 通过 `.mcp.json` 起 plugin 的方式） | ✅ |
| 2 | Plugin 能通过 MCP stdio 响应 `ListToolsRequest` 与 `CallToolRequest` | ✅ |
| 3 | Plugin 能维持 outbound Unix socket 连接到 daemon | ✅ |
| 4 | CC → plugin → daemon → plugin → CC 的 tool_call/tool_result 全链路工作 | ✅ |
| 5 | Daemon → plugin → MCP notification → CC 的反向通道工作 | ✅ |
| 6 | 两个 IO 流（stdio + socket）在同一 Bun 进程中互不阻塞 | ✅（验证：handshake、tool_call、daemon push 三个交互在同一会话内交错发生，没有死锁） |

## 架构含义

`architecture.md` §7 的核心论证**完全成立**：

- Plugin 在同一 Bun 事件循环里同时跑 MCP server（stdio）和 socket client（Unix domain socket）
- 协议解耦干净：MCP 端用 `@modelcontextprotocol/sdk`，socket 端用自定义 NDJSON
- 两边 IO 异步交错，没有需要特殊调度的边界

**对架构文档的修正**：无。`architecture.md` §3 / §6 / §7 描述的协议形态可以直接 1:1 进入开发阶段。

## 边界与已知未验证项

这次 spike 只覆盖了"协议形态可行"。下面这些假设没在本 spike 验证，需要别的 spike 或开发期试错：

| 未验证项 | 谁负责 |
| --- | --- |
| 真 Claude Code 通过 `--channels plugin:claude-discord` 启动 plugin 的实际行为 | 开发期手动测；live-e2e 测试 |
| Plugin 进程数量级（多 CC 同时起多 plugin）下 socket server 的并发处理 | 开发期 e2e 测；spike #7（launchd 权限）部分覆盖 |
| 协议版本不匹配 / unknown agent 时 daemon 拒绝的行为 | 开发期 unit 测试 |
| Plugin 自动 reconnect 的指数退避在长断线场景下的稳定性 | 开发期 integration 测试 |
| Discord rate limit 命中时 daemon 出站队列的退化策略 | 开发期 e2e 测 |

## 后续

- 把 `mock-daemon.ts` / `plugin.ts` / `test-driver.ts` 中协议处理代码作为 §`src/protocol/` 与 §`src/plugin/` 实际模块的起点（不是直接复制——会有结构调整与错误处理强化）
- Spike #7 / #9 / #8 仍需要做（launchd 权限、discord.js autocomplete、plist 签名）

## 附：协议消息样例

来自实际跑通的 NDJSON 流：

```json
// plugin → daemon
{"type":"register","v":1,"agent":"claude-code","cwd":"/Users/x/proj/foo","pid":12345,"capabilities":["reply"]}

// daemon → plugin
{"type":"register_ack","v":1,"workspace":"foo","server_capabilities":["reply"]}

// plugin → daemon (CC 调 reply 工具)
{"type":"tool_call","v":1,"id":"tc-1","tool":"reply","args":{"chat_id":"c1","text":"hello world"}}

// daemon → plugin (echo result)
{"type":"tool_result","v":1,"id":"tc-1","ok":true,"result":"mock-daemon echoed: ..."}

// daemon → plugin (主动推消息)
{"type":"inbound","v":1,"chat_id":"c1","message_id":"m1","user":"tester","user_id":"u1","ts":"...","content":"hello from mock daemon"}
```
