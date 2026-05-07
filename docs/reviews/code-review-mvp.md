# Code Review — Epic A MVP

**日期**：2026-05-07

**范围**：slice 1-6 + 上游复盘 P0/P1 整合的全部生产代码（src/）。共 ~5700 行 TS + 113 测试。

**方法**：BMAD bmad-code-review 三视角 streamlined inline——

- **Blind Hunter**：不带先验找 bug
- **Edge Case Hunter**：未处理的失败模式 / race / 边界
- **Acceptance Auditor**：73 条 PRD FR 与实施对照

**引用**：所有 file:line 都是 main 分支当前 HEAD（`e4de77b` 之后）。

---

## 评分总览

| 视角 | Findings | 🔴 Critical | 🟡 Should | 🟢 Polish |
| --- | --- | --- | --- | --- |
| Blind Hunter | 5 | 1 | 2 | 2 |
| Edge Case Hunter | 4 | 0 | 2 | 2 |
| Acceptance Auditor | 4 | 0 | 1 | 3 |
| **总** | **13** | **1** | **5** | **7** |

**结论**：1 个 Critical 应当天修；5 个 Should 列入公开前 backlog；7 个 Polish 跟在用上发现的时候再处理。

---

## Blind Hunter — 不带先验找 bug

### 🔴 BH-1：Permission relay 的双派发竞争

**File**：`src/daemon/permission-relay.ts`

**Pattern**：

```ts
// handleButton:
const entry = this.pending.get(requestId!)
if (!entry) return // (#1 check)
this.finalize(requestId, behavior, entry)  // (#2 mutates pending)
// ...
// handleTextResponse:
const entry = this.pending.get(requestId)
if (!entry) return false
this.finalize(requestId, behavior, entry)
```

**问题**：button click 与 text response 几乎同时到达时——两个 handler 都过了 `pending.get` 检查，都进入 `finalize` 调用 `dispatchToPlugin`。结果：plugin 收到两条 `permission` 消息，CC 收到两次 MCP notification，**Claude 看到一次允许后又看到一次拒绝**（或反之）。Discord 端 button 已 disabled 但 text response 已发，时序窗口约 200ms 量级。

**修复**：把 `pending.delete(requestId)` 提到 `finalize` 入口（在调用 `dispatchToPlugin` 之前），并改 handlerEntry 的 `get → check → claim` 模式为 atomic `claim()`：

```ts
private claimPending(requestId: string): Pending | null {
  const entry = this.pending.get(requestId)
  if (!entry) return null
  this.pending.delete(requestId)  // claim now, before any await
  return entry
}
```

两个 handler 都改用 `claimPending`，谁先调用谁拿到 entry，第二个拿到 null 直接 return。

**严重性**：🔴 — 安全/正确性。CC 看到双重 permission 决策可能让用户拒绝过的工具仍然执行（看 CC 端如何 reduce 多次响应）。**当天修**。

---

### 🟡 BH-2：Plugin 二次 register 可重命名 workspace

**File**：`src/daemon/socket-server.ts:155-181`

**Pattern**：plugin 已 register 后再次发 register（合规客户端不会，但恶意/错乱客户端会）。当前 `handleRegister` 不检查 `conn.state`，直接覆盖 `conn.workspace` 并 `registry.register(newName, conn)`。

**风险**：

- 旧 workspace name 留在 registry 指向的 conn，被 `byName.set(newName, conn)` 后旧 entry 可能仍在（如果 newName ≠ oldName）。**确认**：`registry.register` 只 set newName，没 unset oldName，所以 oldName 仍然指向 conn → 但 conn.workspace 被改成 newName → `unregisterByConnection(conn)` 后续只删 newName，不删 oldName。**孤儿 entry 永远不被清理**。
- 即使是合规 plugin，重连后 plugin 端会重新 register；socket close handler 已经清了旧 conn 的 entry，所以新 register 是干净的。但如果 plugin 不断网就发第二次 register，孤儿就出现了。

**修复**：`handleRegister` 入口检查 `if (conn.state === 'registered')` → `register_reject reason='invalid' detail='already registered'`。

**严重性**：🟡 — 现实利用面窄但不算太边缘。修起来 5 行。

---

### 🟡 BH-3：Plugin 缺全局 unhandled handler

**File**：`src/plugin/index.ts`

**Pattern**：daemon/index.ts 注册了 `unhandledRejection` / `uncaughtException` 全局兜底。**plugin/index.ts 没有**。

**风险**：plugin 是 CC 子进程，stdio 不死它就活着；但 socket-client 的 `consumeLine` 中如果 onMessage 抛出（比如 zod parse 之外的异常），data event 回调就抛进 Node 默认 handler——Node 22 默认 crash 整个 plugin 进程。CC 端看到 MCP 断开，整个 workspace 的 reply 都失败。

**修复**：在 plugin/index.ts 顶部加：

```ts
process.on('unhandledRejection', err =>
  process.stderr.write(`plugin: unhandled rejection: ${err}\n`),
)
process.on('uncaughtException', err =>
  process.stderr.write(`plugin: uncaught exception: ${err}\n`),
)
```

**严重性**：🟡 — 可靠性。一个未捕获错误可以打死 plugin。

---

### 🟢 BH-4：Discord shutdown timeout 不 unref

**File**：`src/daemon/discord-gateway.ts:115-122`

**Pattern**：

```ts
async shutdown() {
  await Promise.race([
    client.destroy(),
    new Promise<void>(r => setTimeout(r, 2_000)),
  ])
}
```

**问题**：如果 `client.destroy()` 立刻 resolve，setTimeout 仍在运行，**保活整个进程 2 秒**。在 graceful shutdown 路径上这意味着 daemon 多挂 2s 才真正退出，影响 launchd 的 stop 时延。

**修复**：

```ts
const t = new Promise<void>(r => {
  const timer = setTimeout(r, 2_000)
  timer.unref()
})
await Promise.race([client.destroy(), t])
```

或更简单：设一个超时 flag，destroy 完了 clear 它。

**严重性**：🟢 — 体感问题，1 行修复。

---

### 🟢 BH-5：configure 多 TOKEN 行只换第一行

**File**：`src/cli/configure.ts`

**Pattern**：

```ts
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  if (line.startsWith('DISCORD_BOT_TOKEN=')) {
    lines.push(`DISCORD_BOT_TOKEN=${trimmed}`)
    updated = true       // ← 只在第一次替换 set，后续 TOKEN 行变成普通 push 跳过
  } else if (line.length > 0) {
    lines.push(line)
  }
}
```

**问题**：如果 `.env` 因人为编辑出现两行 `DISCORD_BOT_TOKEN=`，第一行会被替换，第二行**也被丢弃**（不进 push）——所以效果反而是去重，但行为隐晦。一点没坏，但语义不显。

**修复**：把 if 分支改成显式：

```ts
if (line.startsWith('DISCORD_BOT_TOKEN=')) {
  if (!updated) {
    lines.push(`DISCORD_BOT_TOKEN=${trimmed}`)
    updated = true
  }
  // 后续 TOKEN 行被有意丢弃 — 见 dedupe rationale
} else if (line.length > 0) {
  lines.push(line)
}
```

加个注释说明。

**严重性**：🟢 — 代码可读性。

---

## Edge Case Hunter — 未处理场景

### 🟡 EC-1：Permission pending 无过期 → 内存泄漏

**File**：`src/daemon/permission-relay.ts`

**Pattern**：`this.pending = new Map<string, Pending>()`——只在 button/text response 时 delete，从不 prune。

**风险**：

- CC permission_request 发起后，用户从不响应（关掉 Discord、忘了、bot 离线）。pending entry 永远留在 map 里。
- request_id 是 5 字母，碰撞概率低但可能（25^5 = 9.7M）。长时间运行 + 高频 permission_request → 可能命中已弃用但未清理的 id。
- 实际更严重的是**内存逐年增长**——daemon 7 天 soak 在重度 permission 用户场景会累积上百个 stale entry。

**修复**：

- 给 pending 加 TTL（如 1h），与 access.json pairing pending 的过期一致
- `setInterval(prune, 5min).unref()` 扫一遍

**严重性**：🟡 — 长期可靠性。修一次值钱。

---

### 🟡 EC-2：routing.json hot-reload 半实现（FR-3.3）

**File**：`src/daemon/routing.ts`

**Pattern**：`RoutingTable.reload()` 存在，但**没人在文件变更时调它**。daemon 内部的 `/use` 走 `routing.set` 直接更新内存视图 + 写盘。但如果用户手工改 routing.json，daemon 不会 pick up。

**对比 PRD FR-3.3**："Routing 改动热生效，不需要重启 daemon；内存视图实时更新"。

**实施差距**：内部 `/use` 是热的，**外部修改不是**。

**修复路径**：

- 选项 A：daemon 启动时 `fs.watch(routingFile, () => routing.reload())`。简单。
- 选项 B：每条入站消息重 read（昂贵——每秒可能多次读盘）。
- 选项 C：明确文档"不支持外部手工编辑 routing.json"，把 FR-3.3 收紧为"仅内部 /use 改动生效"。

我倾向选项 A——`fs.watch` 在 macOS/Linux 都稳定，cost 低，完整实现 FR-3.3。

**严重性**：🟡 — FR 不达标。需要决策（A/B/C）后再修。

---

### 🟢 EC-3：Slice-3 fallback 路由静默生效

**File**：`src/daemon/inbound-router.ts:100-104`

**Pattern**：DM channel 没有 routing.json entry 时，路由到"最近注册的 workspace"。当时给 slice 3 留的快路径，slice 4 起 /use 已经实现。

**问题**：用户首次 DM bot（已 paired）但还没在 channel 跑过 /use，消息会**默默路由到任意 workspace**。如果用户有多个 workspace，行为不可预测。

**修复**：

- 选项 A：删除 fallback，DM 没 routing 时回 "this DM is not bound to any workspace; run `/use foo`"。更明确。
- 选项 B：保留 fallback 但加日志 `log.info(fallback routed to ${workspace})` + 给用户发一条提示信息。

倾向选项 A。

**严重性**：🟢 — UX 模糊。

---

### 🟢 EC-4：applyPlan 回滚步骤可能重复

**File**：`src/installer/apply.ts:70-89`

**Pattern**：失败时 `[...undoStack, ...plan.rollback].reverse()`。`undoStack` 是 apply 期间动态记录的 delete-file 步骤；`plan.rollback` 是 plan 构建时定义的同样 delete-file。两者重叠。

**问题**：第二次 delete 抛 ENOENT，被 try/catch 吞掉，没坏掉任何东西。**但 rollback log 里会出现"删除 X / 删除 X (failed)"两条**。

**修复**：apply 只用 plan.rollback（builder 已经定义完整），不收集 undoStack。或：用 Set dedupe by path。

**严重性**：🟢 — Cosmetic / 日志杂讯。

---

## Acceptance Auditor — FR 与实施对照

完整 73 FR 抽查；绝大部分对得上。下面只列**实施与 PRD 不一致**或**部分实施**。

### 🟡 AA-1：FR-5.2/5.3/5.4 长内容 polish 未实施

**PRD**：

- FR-5.2 "长单体内容（如 diff、log）作为 .md 附件"
- FR-5.3 "thinking / tool trace 走线程回复"
- FR-5.4 "结构化总结走 embed"

**实施现状**：`tool-handlers.ts toolReply` 只有 chunked-send。没有 attachment 自动阈值，没有 thread 模式，没有 embed 模式。

**Slice 6 commit message 已显式 defer 到 day-2**，但 PRD 仍列为 P0/P1。需要把 PRD 状态从"实施"改成"day-2 candidate"，或开 issue 跟踪 day-2 实施。

**严重性**：🟡 — PRD 与实施漂移。文档纠正即可，不一定要立刻实现。

---

### 🟢 AA-2：FR-11.8 Static mode 未实施

**PRD**：FR-11.8 P1 — `DISCORD_ACCESS_MODE=static` 启动时一次性快照 access.json，pairing 自动降级 allowlist。

**实施现状**：`access-control.ts` schema 字段都在，但**没实现 boot snapshot 逻辑**。已在上游深度复盘（§3.2）和 issue #19 P2 中识别。

**严重性**：🟢 — 已知 day-2 候选，无需在本 review 重复登记。

---

### 🟢 AA-3：FR-2.3 plugin 心跳值未配置化

**PRD**：FR-2.3 "Plugin 每 N 秒（如 10s）发一次心跳"。

**实施**：`HEARTBEAT_MS = 10_000` 硬编码常量。

**严重性**：🟢 — 可调性缺失，但 PRD 没强制要求 env 配置。如果 7 天 soak 显示 10s 不够（或太频繁），再配置化。

---

### 🟢 AA-4：FR-3.6 agent type routing 仅最小实现

**PRD**：FR-3.6 "Daemon 按 agent type 选用相应消息协议 / 工具集 / 权限 Q&A 通道；day 1 仅 claude-code 实现完整路径；其他 agent type 注册时若 daemon 不识别，拒接并提示 plugin 升级 daemon 或 plugin"。

**实施**：`socket-server.ts:172-180`——agent != 'claude-code' 时 reject。但**没有"按 agent type 选不同工具集"的多路径**——所有逻辑都假设 claude-code。这与 PRD 的 day-1 描述一致（"仅 claude-code 实现完整路径"），符合预期。

**严重性**：🟢 — 当前阶段实施符合 PRD；扩展时再写更多 agent path。

---

## 修复行动表

| 编号 | 严重性 | 描述 | 工作量 | 优先 |
| --- | --- | --- | --- | --- |
| BH-1 | 🔴 | Permission relay double-dispatch | 10 分钟 | **当天修** |
| BH-2 | 🟡 | Re-register 攻击向量 | 10 分钟 | 公开前 |
| BH-3 | 🟡 | Plugin 缺全局 unhandled handler | 5 分钟 | 公开前 |
| EC-1 | 🟡 | Permission pending 无过期 | 30 分钟 | 公开前 |
| EC-2 | 🟡 | routing.json hot-reload 半实现 | 30 分钟 | 公开前 |
| AA-1 | 🟡 | PRD 长内容 polish 漂移 | 15 分钟（doc）/ 半天（实施） | 公开前 doc 改 |
| BH-4 | 🟢 | shutdown timeout 不 unref | 2 分钟 | 顺手 |
| BH-5 | 🟢 | configure 多 TOKEN 行 | 5 分钟 | 顺手 |
| EC-3 | 🟢 | slice-3 fallback 路由 | 10 分钟 | 顺手 |
| EC-4 | 🟢 | applyPlan rollback 重叠 | 5 分钟 | 顺手 |
| AA-2 | 🟢 | Static mode 未实施 | 已在 #19 P2 跟踪 | — |
| AA-3 | 🟢 | 心跳值非配置 | 5 分钟（如要做） | 推后 |
| AA-4 | 🟢 | Agent type routing day-1 范围 | 0 | — |

**当天动作**：BH-1（Critical）+ BH-3、BH-4、BH-5（顺手） — 共 ~30 分钟
**公开前再做**：BH-2、EC-1、EC-2、AA-1（doc）— 共 ~1.5 小时
**推后**：余下的 polish / day-2 项

---

## 复审 Notes

- 13 findings / ~5700 行代码 = 缺陷密度极低（约每 440 行 1 项），说明 BMAD 规划阶段把大部分 acceptance criteria 锁死，实施阶段 noise 很少
- 没有发现内存泄漏（除 EC-1 permission pending 长期累积）、没有 SQL injection 类 OWASP 基础漏洞（项目无数据库 / 网络 framework）、没有 ATOMIC 写文件半态、没有 token 泄漏路径
- 上游复盘的 P0/P1 已经覆盖了对称访问 / prompt injection / capability 声明等高风险项；这次 review 主要补 race condition + 资源边界
- **尚未单测 race condition**：BH-1 的修复验证需要 timing-sensitive test，可以用伪 manual race（顺序调用 + 检查 dispatch 次数）覆盖

下一步：开 follow-up issue 跟踪修复，本 issue 关闭时附 commit 引用。
