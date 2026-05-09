# 验收矩阵 — SC + NFR (PRD §4 / §12)

> 状态：✅ 实现并验证 / 🟡 实现但未充分验证 / ❌ 未实现 / ❓ 主观或观察期
>
> 生成日期：2026-05-09。基于 main commit `c96573e`（含 stage 2 + 真 Discord channel mode + #26/#27/#29 polish）。

## 1. 量化成功标准（SC-1..SC-6，§4）

| # | 指标 | 状态 | 证据 |
|---|---|---|---|
| SC-1 | Daemon 7 天稳定 | ❌ pending | 还没跑 7-day soak。代码层 unhandledRejection / uncaughtException 全局兜底（`plugin/index.ts`、`cli/index.ts`），daemon side 关键 timer 都 `.unref()`。理论可达，待 soak 验证。 |
| SC-2 | Workspace 注册 < 3s | ✅ 验证 | 真 Discord 实测 daemon log 显示 `workspace registered` 在 plugin spawn 后 sub-second 出现。controlled-e2e #1 / live-e2e #1 都是 ms 级。 |
| SC-3 | `/use` 切换 < 1s | 🟡 代码路径直接但未量化 | `slash-commands.ts` /use 改 routing → reply ✅，无 await 长链路。global slash 命令 `~1h` 传播后 DM 可用（PR #35）。Guild 内 instant。延迟未实测。 |
| SC-4 | 离线检测 < 5s | ✅ 验证 | socket close → `unregisterByConnection`（`socket-server.ts:126`）即时；heartbeat reaper 30s 兜底。controlled-e2e #8 reconnect 测过 30ms 内识别。 |
| SC-5 | `/recent` 体感 | ❓ 主观 | 实现：ring-buffer 50/workspace + 条件性 auto-display（`ring-buffer.ts`）。需自用累计后回顾。 |
| SC-6 | 零数据丢失 | 🟡 部分验证 | normal ops：atomicWrite 全状态文件、access.json 解析失败 rename 不丢、permission relay 1h TTL 防泄漏。失败时 plugin `rejectAll` 让 CC 看到错（明确告知）。Discord 端 rate limit 失败仅返回 null（**未来可加 retry queue**）。无端到端"丢消息"压力测试。 |

## 2. 非量化判据（SC-7、SC-8）

| # | 判据 | 状态 |
|---|---|---|
| SC-7 | 作者自用满意度 | ❓ 观察期。channel mode 实测可用，但日常切到 claude-discord 做主力还需累计使用 |
| SC-8 | 第二个用户出现 | ❌ 显式 pending。仓库仍 private (`package.json: private: true`)，未公开发布 |

## 3. NFR-1 性能（§12.1）

| 指标 | 目标 | 状态 |
|---|---|---|
| /use 切换响应 | < 1s | 🟡 代码路径直接，未量化 |
| Workspace 注册延迟 | < 3s | ✅ 实测 sub-second |
| 离线检测延迟 | < 5s | ✅ socket close 即时 |
| Daemon idle CPU | < 1% | ❓ 未压测 |
| Daemon idle 内存（50 ws） | < 100MB | ❓ 未压测 |

## 4. NFR-2 可靠性（§12.2）

| 项 | 状态 | 证据 |
|---|---|---|
| Daemon 7 天 | ❌ pending soak | SC-1 同 |
| Discord 网关断重连 | ✅ | discord.js 14.26 自带 + reconnect ；指数退避在 `plugin/reconnect.ts` |
| Discord rate limit 队列 | 🟡 委托 | 没有 daemon-level 队列，依赖 discord.js 内部 rate limit handling。实战未压测 |
| Plugin 断重连 99% | ✅ | controlled-e2e #8（reconnect）；#26 修了 orphan spin；#27 修了同 cwd 撞名 thrash |
| Normal ops 零丢失 | 🟡 | atomicWrite 覆盖；ring buffer 内存型重启即丢（spec 接受） |

## 5. NFR-3 安全（§12.3）

| 项 | 状态 |
|---|---|
| `.env` / `access.json` / `routing.json` 0o600 | ✅ `paths.ts initStateDir` + `atomicWrite` 强制 |
| STATE_DIR 0o700 | ✅ |
| assertSendable 防 STATE_DIR 泄漏 | ✅ `tool-handlers.ts` |
| safeAttName 防附件名注入 | ✅ |
| access.json 热加载 | ✅ inbound-router 每条 inbound 都 read |
| 配对码 1h 过期 | ✅ `pruneExpired` |
| 仅 allowFrom 触发权限响应 | ✅ button + textResponse 都查 allowFrom |
| Daemon 仅本地 socket | ✅ Unix domain socket |
| token 不进 stderr | ✅ logger 不打 token；configure 子命令写 .env 即 chmod 0600 |

## 6. NFR-4 可观测性（§12.4）

| 项 | 状态 |
|---|---|
| 结构化 stderr 日志 | ✅ `shared/logger.ts` 覆盖启动/连接/路由/异常/LRU |
| 日志级别可配 | ✅ `CLAUDE_DISCORD_LOG_LEVEL=info\|debug` |
| status 子命令 | ✅ `cli/status.ts`（healthy / connections / state files / uptime） |
| Day-2 JSONL audit 流 | ❌ 标 Day-2 |

## 7. NFR-5 兼容性（§12.5）

| 平台 | 状态 |
|---|---|
| macOS launchd | ✅ install / uninstall plist 脚本 |
| Linux systemd | ✅ 同上 systemd unit |
| Windows | ❌ 明确不在 MVP |
| Discord API v10+ | ✅ |
| discord.js 14.x | ✅ |
| Claude Code 当前版本 | ✅ 真 Discord 实测 v2.1.138 通过 |

## 8. NFR-6 资源边界（§12.6）

| 限额 | 状态 |
|---|---|
| Active soft cap 50 | ✅ `registry.ts cap=50` + LRU trim 45（controlled-e2e #7） |
| Ring buffer 50/workspace | ✅ `ring-buffer.ts CAP=50` |
| 单 bot 连接 | ✅ |
| Pending pairing 3 | ✅ `access-control.ts:143` |
| 单 reply 10 attachments / 25MB | ✅ `MAX_FILES_PER_MESSAGE=10`，`MAX_FILE_BYTES=25MB` |
| Chunk 2000 | ✅ `HARD_CHUNK_LIMIT=2000` |

## 9. NFR-7 可测试性（§12.7）

| 测试类 | 状态 |
|---|---|
| Unit（routing / ring buffer / LRU / access state / chunk） | ✅ 多个 unit + integration（vitest） |
| Integration（plugin↔daemon 握手 / 断 / 重连 / 心跳） | ✅ controlled-e2e 9 脚本 / 18 用例 |
| E2E（CC 启动 → DM 路由 → 回复完整链路） | ✅ live-e2e #1 (MCP SDK) + live-e2e #2 (真 claude --print，gated) |
| Live（真 Discord bot + 真 CC） | ✅ 本 session 实测通过（channel mode + always-allow + #26/#27/#29） |

## 10. 关键 Gap 清单

按"距离 MVP 完成"的距离排：

1. **SC-1 / NFR-2 7 天 soak**：必须跑 7 天，未做。这是 MVP gate。
2. **SC-7 自用满意度**：用 1-2 周的"作者放弃 raw claude" 信号才算。观察期。
3. **SC-8 第二用户**：仓库私有未发布；要点是 release 后是否有人主动用。
4. **NFR-1 idle CPU / 内存压测**：未量化。建议用 `top` 看 50 workspace 满载场景。
5. **NFR-2 rate limit 队列**：当前依赖 discord.js 内部，未做 daemon-level retry。实战 burst 时可能丢请求。建议 follow-up issue 加最小化 retry-on-rate-limit。
6. **FR 详细审计 73 条**：本矩阵是 SC + NFR 高层版（A 档）。FR 详尽核对（B 档）留 follow-up。

## 11. 总评

按 BMAD 「MVP 完成契约」（SC-1..SC-8 + NFR-1..NFR-7）的覆盖：

- **代码已实现**约 90%（FR 实施 + NFR-3/-4/-5/-6/-7 全部 ✅；SC-2/SC-4 已实测）
- **真实场景验证**约 70%（live-e2e + 本 session 真 Discord 实测；soak / 性能压测未做）
- **MVP gate 阻塞项**：SC-1（7 天 soak）和公开发布前的 SC-7/SC-8 观察期

代码层 ready；release 前需要 7-day soak + 公开 + 等第二用户出现，才算 PRD 定义的"算 MVP 完成"。
