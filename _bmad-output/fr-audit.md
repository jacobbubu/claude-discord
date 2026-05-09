# FR audit — PRD §11 73 条 FR × main 当前实现

> 自动生成。状态列基于 grep 命中数的 heuristic（test_hits>0 → ✅，src_hits>0 → 🟡，0 → ❓）；
> reviewer 必须二次核对，不可只信脚本。运行：`bun run scripts/fr-audit.ts`

## Epic 1: Daemon Process & Lifecycle

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-1.1 | P0 | ✅ | `src/cli/index.ts` (4 kw with tests, 83 src + 97 test hits) | 通过 `claude-discord-bot start` 前台运行 daemon |
| FR-1.2 | P0 | ✅ | `src/cli/index.ts` (5 kw with tests, 72 src + 19 test hits) | 通过 `claude-discord-bot install` 注册为 launchd / systemd 服务 |
| FR-1.3 | P0 | ✅ | `src/cli/index.ts` (3 kw with tests, 78 src + 16 test hits) | 通过 `claude-discord-bot uninstall` 卸载服务 |
| FR-1.4 | P1 | ✅ | `src/cli/index.ts` (3 kw with tests, 48 src + 22 test hits) | 通过 `claude-discord-bot status` 查健康状态 |
| FR-1.5 | P0 | 🟡 | `src/daemon/index.ts` (32 src hits, weak test signal (1 kw)) | 全局兜底 unhandled rejection / uncaught exception |
| FR-1.6 | P0 | ✅ | `src/cli/dev.ts` (2 kw with tests, 7 src + 88 test hits) | 连续运行 7 天不需要 kill -9 |
## Epic 2: Plugin SDK（CC-side）

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-2.1 | P0 | 🟡 | `src/plugin/mcp-server.ts` (5 src hits, weak test signal (1 kw)) | CC 启动时 plugin 自动连接 daemon |
| FR-2.2 | P0 | ✅ | `src/plugin/index.ts` (4 kw with tests, 14 src + 109 test hits) | 握手时报 workspace 标识 |
| FR-2.3 | P0 | 🟡 | `—` (domain has 5 files but story keywords don't match — manual check) | 心跳 |
| FR-2.4 | P0 | ✅ | `src/plugin/index.ts` (2 kw with tests, 26 src + 54 test hits) | 自动 reconnect |
| FR-2.5 | P0 | ✅ | `src/plugin/index.ts` (2 kw with tests, 17 src + 81 test hits) | Plugin 接收 daemon 路由的入站消息 |
| FR-2.6 | P0 | ✅ | `src/plugin/index.ts` (6 kw with tests, 18 src + 120 test hits) | Plugin 转发 CC 端的工具调用结果回 daemon |
| FR-2.7 | P0 | ✅ | `src/plugin/index.ts` (4 kw with tests, 30 src + 120 test hits) | Plugin 在 CC 退出时干净断开 |
| FR-2.8 | P0 | 🟡 | `src/plugin/index.ts` (2 src hits, weak test signal (4 kw)) | 握手 payload 携带 `agent` 标识 |
| FR-2.9 | P0 | ✅ | `src/plugin/index.ts` (2 kw with tests, 4 src + 51 test hits) | Plugin 在握手时声明 `protocol_version` 与 `capabilities` |
## Epic 3: Discord Channel Routing

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-3.1 | P0 | ✅ | `src/daemon/routing.ts` (5 kw with tests, 50 src + 153 test hits) | `routing.json` 维护 channel → workspace 的持久化映射 |
| FR-3.2 | P0 | ✅ | `src/daemon/registry.ts` (6 kw with tests, 51 src + 202 test hits) | Daemon 内存维护 active registry：workspace name → plugin socket |
| FR-3.3 | P0 | 🟡 | `src/daemon/routing.ts` (15 src hits, weak test signal (1 kw)) | Routing 改动热生效 |
| FR-3.4 | P0 | ✅ | `src/daemon/inbound-router.ts` (5 kw with tests, 41 src + 140 test hits) | 入站消息按 channel 路由 |
| FR-3.5 | P0 | 🟡 | `—` (domain has 4 files but story keywords don't match — manual check) | 出站消息按 workspace 路由 |
| FR-3.6 | P0 | ✅ | `src/daemon/registry.ts` (4 kw with tests, 23 src + 168 test hits) | Daemon 按 agent type 选用相应消息协议 / 工具集 / 权限 Q&A 通道 |
## Epic 4: Slash Commands

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-4.1 | P0 | ✅ | `src/daemon/slash-commands.ts` (5 kw with tests, 26 src + 185 test hits) | `/use <workspace>` 切换当前 channel 绑定 |
| FR-4.2 | P0 | ✅ | `src/daemon/slash-commands.ts` (2 kw with tests, 18 src + 54 test hits) | `/last` 切回上一个 workspace |
| FR-4.3 | P0 | ✅ | `src/daemon/slash-commands.ts` (4 kw with tests, 21 src + 275 test hits) | `/list` 列出所有活动 workspace（时间倒序） |
| FR-4.4 | P0 | ✅ | `src/daemon/slash-commands.ts` (4 kw with tests, 18 src + 235 test hits) | `/which` 查当前 channel 的绑定 |
| FR-4.5 | P0 | ✅ | `src/daemon/slash-commands.ts` (3 kw with tests, 20 src + 28 test hits) | `/recent [N]` 列当前 workspace 最近 N 条 |
| FR-4.6 | P1 | 🟡 | `src/daemon/slash-commands.ts` (7 src hits, weak test signal (0 kw)) | `/status [workspace]` 查在线状态 |
| FR-4.7 | P0 | ✅ | `src/daemon/slash-commands.ts` (3 kw with tests, 43 src + 26 test hits) | Slash 命令自动补全 |
| FR-4.8 | P0 | ✅ | `src/daemon/slash-commands.ts` (4 kw with tests, 33 src + 245 test hits) | Slash 命令鉴权 |
## Epic 5: Long Content Display

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-5.1 | P0 | ✅ | `src/cli/access-mutate.ts` (3 kw with tests, 28 src + 46 test hits) | 短消息（≤ 2000 字符）直接 inline |
| FR-5.2 | P2 (day-2) | ✅ | `src/daemon/permission-relay.ts` (2 kw with tests, 11 src + 15 test hits) | 长单体内容（如 diff、log）作为 `.md` 附件 |
| FR-5.3 | P2 (day-2) | ✅ | `src/daemon/permission-relay.ts` (2 kw with tests, 11 src + 71 test hits) | 思考过程 / tool trace 走线程回复 |
| FR-5.4 | P2 (day-2) | 🟡 | `src/daemon/permission-relay.ts` (6 src hits, weak test signal (1 kw)) | 结构化总结走 embed |
| FR-5.5 | P0 | ✅ | `src/daemon/permission-relay.ts` (2 kw with tests, 44 src + 88 test hits) | 流式进度 edit 同一消息 |
## Epic 6: Discord Permission Q&A Relay

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-6.1 | P0 | ✅ | `src/protocol/schema.ts` (5 kw with tests, 11 src + 23 test hits) | 接收 CC 的 `permission_request` 通知 |
| FR-6.2 | P0 | ✅ | `src/daemon/tool-handlers.ts` (5 kw with tests, 4 src + 61 test hits) | 给 `allowFrom` 用户发带按钮的 DM |
| FR-6.3 | P1 | ✅ | `src/protocol/schema.ts` (6 kw with tests, 8 src + 45 test hits) | "See more" 展开完整 input_preview |
| FR-6.4 | P0 | ✅ | `src/protocol/schema.ts` (2 kw with tests, 11 src + 76 test hits) | 按钮回应 → 发 `permission` 通知给 CC |
| FR-6.5 | P1 | ✅ | `src/daemon/tool-handlers.ts` (2 kw with tests, 4 src + 29 test hits) | 文本回应 `yes XXXXX` / `no XXXXX` |
| FR-6.6 | P0 | 🟡 | `src/daemon/tool-handlers.ts` (1 src hits, weak test signal (1 kw)) | 仅 DM 路径参与权限请求 |
## Epic 7: Channel UX

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-7.1 | P0 | ✅ | `src/cli/index.ts` (5 kw with tests, 13 src + 224 test hits) | Channel topic 永远写当前 workspace |
| FR-7.2 | P0 | 🟡 | `—` (domain has 2 files but story keywords don't match — manual check) | 切换时发 "✅ switched to X" 消息 |
| FR-7.3 | P0 | 🟡 | `—` (domain has 2 files but story keywords don't match — manual check) | 没切就打字 = 沉默路由 |
| FR-7.4 | P0 | 🟡 | `—` (domain has 2 files but story keywords don't match — manual check) | 历史交错不做隔离 |
## Epic 8: Message Recall Ring Buffer

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-8.1 | P0 | ✅ | `src/protocol/schema.ts` (3 kw with tests, 452 src + 254 test hits) | Daemon 维护 per-workspace 50 条 ring buffer |
| FR-8.2 | P0 | ✅ | `src/daemon/slash-commands.ts` (2 kw with tests, 50 src + 18 test hits) | `/recent N` 读 buffer 展示 |
| FR-8.3 | P0 | ✅ | `src/daemon/__tests__/controlled-e2e/_mock-client.ts` (4 kw with tests, 183 src + 153 test hits) | `/use` 切换时按必要性算法决定是否自动展示 |
| FR-8.4 | P0 | ✅ | `src/daemon/__tests__/permission-relay.test.ts` (4 kw with tests, 454 src + 272 test hits) | Workspace 被 LRU 驱逐时 ring buffer 同步清理 |
## Epic 9: Workspace Registry Capacity

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-9.1 | P0 | 🟡 | `src/daemon/registry.ts` (28 src hits, weak test signal (1 kw)) | Soft cap 50（可由 `CLAUDE_DISCORD_WORKSPACE_CAP` 调整） |
| FR-9.2 | P0 | ✅ | `src/daemon/registry.ts` (4 kw with tests, 73 src + 46 test hits) | 注册数超 cap 时按 LRU 驱逐到 45 |
| FR-9.3 | P0 | ✅ | `src/daemon/socket-server.ts` (6 kw with tests, 575 src + 370 test hits) | 驱逐 = 关闭 plugin socket + 丢 ring buffer + 删 active registry 条目 |
| FR-9.4 | P0 | 🟡 | `src/plugin/mcp-server.ts` (65 src hits, weak test signal (1 kw)) | 驱逐完全静默 |
| FR-9.5 | P0 | ✅ | `src/daemon/__tests__/controlled-e2e/08-reconnect.test.ts` (4 kw with tests, 87 src + 97 test hits) | Plugin reconnect 时无缝重新出现 |
## Epic 10: Offline Workspace UX

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-10.1 | P0 | ✅ | `src/cli/index.ts` (2 kw with tests, 31 src + 107 test hits) | 入站消息发往离线 workspace 时 bot 立即回执 |
| FR-10.2 | P0 | 🟡 | `src/cli/status.ts` (9 src hits, weak test signal (1 kw)) | 在线检测 = socket 状态 + 心跳兜底 |
| FR-10.3 | P0 | 🟡 | `—` (domain has 21 files but story keywords don't match — manual check) | 离线检测延迟 < 5 秒 |
## Epic 11: Sender-side Access Control（沿用上游）

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-11.1 | P0 | ✅ | `src/cli/access-mutate.ts` (5 kw with tests, 67 src + 132 test hits) | `dmPolicy = pairing`：陌生人 DM 回 6 hex 配对码，丢消息 |
| FR-11.2 | P0 | ✅ | `src/cli/access-mutate.ts` (2 kw with tests, 10 src + 33 test hits) | `dmPolicy = allowlist`：陌生人静默丢 |
| FR-11.3 | P0 | ✅ | `src/cli/access-mutate.ts` (4 kw with tests, 36 src + 102 test hits) | `dmPolicy = disabled`：全丢（含 allowFrom 与 guild 频道） |
| FR-11.4 | P0 | ✅ | `src/cli/index.ts` (7 kw with tests, 138 src + 228 test hits) | `claude-discord-bot pair <code>` 批准 |
| FR-11.5 | P0 | ✅ | `src/cli/index.ts` (6 kw with tests, 48 src + 150 test hits) | Guild 频道按 channel ID opt-in |
| FR-11.6 | P0 | ✅ | `src/cli/access-mutate.ts` (3 kw with tests, 29 src + 53 test hits) | Mention 检测三路径 |
| FR-11.7 | P0 | ✅ | `src/cli/access-mutate.ts` (3 kw with tests, 105 src + 126 test hits) | `access.json` 热加载 |
| FR-11.8 | P1 | ✅ | `src/cli/access-mutate.ts` (3 kw with tests, 44 src + 54 test hits) | Static mode（`DISCORD_ACCESS_MODE=static`） |
## Epic 12: Safety & Data Hygiene（沿用上游）

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-12.1 | P0 | ✅ | `src/cli/__tests__/configure.test.ts` (5 kw with tests, 26 src + 111 test hits) | `assertSendable` 阻止 STATE_DIR 文件外发 |
| FR-12.2 | P0 | 🟡 | `—` (domain has 21 files but story keywords don't match — manual check) | `safeAttName` 清洗附件名 |
| FR-12.3 | P0 | ✅ | `src/cli/__tests__/configure.test.ts` (5 kw with tests, 158 src + 221 test hits) | 文件权限收紧 |
| FR-12.4 | P0 | 🟡 | `src/cli/index.ts` (14 src hits, weak test signal (1 kw)) | Skill 拒绝从 channel 驱动配置改动 |
| FR-12.5 | P0 | 🟡 | `src/cli/configure.ts` (24 src hits, weak test signal (1 kw)) | 错误信息不泄漏 token |
## Epic 13: CLI Installer

| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |
|---|---|---|---|---|
| FR-13.1 | P0 | ✅ | `src/cli/index.ts` (5 kw with tests, 100 src + 111 test hits) | `claude-discord-bot configure <token>` 写 token |
| FR-13.2 | P0 | ✅ | `src/cli/index.ts` (5 kw with tests, 74 src + 16 test hits) | `claude-discord-bot install` 写 launchd plist (macOS) |
| FR-13.3 | P0 | ✅ | `src/cli/index.ts` (8 kw with tests, 114 src + 171 test hits) | `claude-discord-bot install` 写 systemd unit (Linux) |
| FR-13.4 | P1 | ✅ | `src/cli/install.ts` (3 kw with tests, 21 src + 13 test hits) | 安装脚本支持预演与原子失败 |
| FR-13.5 | P0 | ✅ | `src/cli/index.ts` (3 kw with tests, 35 src + 16 test hits) | `claude-discord-bot uninstall` 反向 |
