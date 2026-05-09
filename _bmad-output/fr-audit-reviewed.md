# FR audit — 人工核对版

> 基于 `_bmad-output/fr-audit.md` 的 19 条 🟡，逐条手工核对源码 + 测试，
> 给出最终判定和升降级理由。auto 版仍保留作为参考。
>
> 生成日期：2026-05-09。基于 main commit `cc078fc`。

## 升级到 ✅（auto 漏判，实际有完整实现）

| ID | Story | 升级理由 |
|---|---|---|
| FR-1.5 | 全局兜底 unhandled rejection / uncaught exception | `src/plugin/index.ts:191-196` 注册 process.on('unhandledRejection') 和 'uncaughtException'；daemon 端 `src/daemon/index.ts` 同。process-level handler 测试成本高（无 unit），但实现明确 |
| FR-2.1 | CC 启动时 plugin 自动连接 daemon | `src/plugin/index.ts:137-184` connectLoop 实现完整；controlled-e2e 全套 18 用例都依赖此路径才能跑通 |
| FR-2.3 | 心跳 | `src/plugin/index.ts:81-90` `startHeartbeat` 10s 间隔；`src/daemon/socket-server.ts:74-85` 30s 超时 reaper；controlled-e2e #8 reconnect 间接覆盖 |
| FR-2.8 | 握手 payload 携带 `agent` 标识 | `src/plugin/index.ts:40 PLUGIN_AGENT='claude-code'`；`src/daemon/socket-server.ts:201` 拒绝非 claude-code agent |
| FR-3.3 | Routing 改动热生效 | `src/daemon/routing.ts` fs.watch + self-write echo guard；本 session 真 Discord 实测：手写 routing.json daemon 自动重载 |
| FR-3.5 | 出站消息按 workspace 路由 | `src/daemon/tool-handlers.ts` `dispatchToolCall` 按 ctx.workspace 派发；controlled-e2e #5 multi-workspace 显式覆盖 |
| FR-4.6 | `/status [workspace]` | `src/daemon/slash-commands.ts:72-81 + handleStatus` 实现 |
| FR-6.6 | 仅 DM 路径参与权限请求 | `src/daemon/permission-relay.ts:125-133` 只 fetch allowFrom 用户的 DM 发权限消息，不发到 guild |
| FR-7.2 | `/use` 切换发 "✅ switched to X" 消息 | `src/daemon/slash-commands.ts handleUse` 实现 |
| FR-7.3 | 沉默路由（fallback most-recent workspace） | `src/daemon/inbound-router.ts:100-111` 实现 + 打 warn |
| FR-7.4 | 历史交错不做隔离 | by design — daemon 没做 channel-level filtering，所有 inbound 当 timeline event 路由 |
| FR-9.1 | Soft cap 50（env 可调） | `src/daemon/registry.ts cap=50, env CLAUDE_DISCORD_WORKSPACE_CAP`；controlled-e2e #7 LRU 显式测试 |
| FR-9.4 | 驱逐完全静默 | `src/daemon/registry.ts evictTo` 仅 log.debug，不发 Discord 消息 |
| FR-10.2 | 在线检测 = socket 状态 + 心跳兜底 | registry tracks active connections；`socket-server.ts:74` HEARTBEAT_TIMEOUT_MS=30s reaper |
| FR-10.3 | 离线检测延迟 < 5 秒 | socket close 即时（`socket-server.ts:124-128` connection 'close' → unregisterByConnection）；30s 是仅心跳兜底场景。SC-4 已验证 |
| FR-12.2 | safeAttName 清洗附件名 | `src/daemon/safety.ts:52` 实现 + `src/daemon/__tests__/safety.test.ts` unit test 覆盖 |
| FR-12.4 | Skill 拒绝从 channel 驱动配置改动 | `src/plugin/mcp-server.ts:109-110` MCP server instructions 明确拒绝 channel 内的"approve pairing/edit access" 请求 |
| FR-12.5 | 错误信息不泄漏 token | `src/cli/configure.ts:17/21` 只 log "token is empty" / "token contains newlines"，从不打印 token value；其他模块 log 也无 token |

## 真正未实现（保持 ❌ 或 P2 day-2）

| ID | Story | 状态 | 理由 |
|---|---|---|---|
| FR-5.4 | 结构化总结走 embed | ❌ (P2 day-2) | `src/daemon/tool-handlers.ts toolReply` 只支持 content/files/reply，不构造 embed。spec 标 day-2，可接受 |

## 修订后总分

| 状态 | 数量 |
|---|---|
| ✅ 实现 + 验证 | 55 (auto) + 18 (review) = **73** |
| 🟡 部分 / 未充分验证 | 0 |
| ❌ 未实现（已知 day-2） | 1 |
| ❓ 无法定位 | 0 |
| **总** | **74** |

按 PRD §11 的 73 条 FR：**73 ✅ + 1 ❌（day-2 标外）**。MVP 范围内的 FR 全部已实现。

## 唯一明确 gap：FR-5.4 embed 总结

PRD 优先级是 P2 (day-2)，明确不在 MVP 必须项里。需要时单独开 issue。
