# Spike #8 — launchd plist 是否需要 macOS 签名

**状态**：✅ **不需要签名**——unsigned LaunchAgent 在 user 域 launchctl bootstrap 直接成功

**日期**：2026-05-06

## 待验证假设

来自 `architecture.md` §20：

> 越新越严的 macOS 代码签名要求可能影响：
> - 用户安装我们的 plist 时是否被 Gatekeeper 拦截
> - launchd load 是否要求 plist 可执行的二进制带签名
> - ad-hoc 签名 / 开发者证书签名 / 完全无签名 三档分别能跑到哪

如果必须签名，installer 需要把签名步骤纳入 \`apply\`；如果不签名也行，就不必。

## 验证方法

写一个 **真实跑 launchctl bootstrap** 的验证脚本（不是只静态检查）：

| 文件 | 角色 |
| --- | --- |
| `daemon-stub.ts` | 最小 daemon：每秒写心跳到 `$SPIKE8_HEARTBEAT` 文件 |
| `verify.ts` | 端到端跑：写 plist + bootstrap + 等心跳 + print + bootout |

**Disposable label**：`com.jacobbubu.claude-discord-spike-8-${pid}`，每次 pid 不同避免与之前残留冲突。

**Aggressive cleanup**：`process.on('exit')` 注册 teardown，无论成功失败都跑 bootout + 删 plist。

## 测试运行

```bash
cd spikes/8-plist-signing
bun install
bun run verify.ts
```

**实际输出**：

```
Plist label: com.jacobbubu.claude-discord-spike-8-90452
Plist path:  /var/folders/.../spike8-tUxj4x/...plist
Bun path:    /Users/rongshen/.bun/bin/bun

Step 1: codesign status of bun binary...
  codesign output: Executable=/Users/rongshen/.bun/bin/bun / Identifier=bun / Format=Mach-O thin (arm64)
✓ codesign captured (informational)

Step 2: launchctl bootstrap (no signature on plist itself)...
✓ launchctl bootstrap succeeded (no signing required)

Step 3: wait up to 5s for daemon heartbeat file...
✓ heartbeat appeared: 1 1778084672197 90460

Step 4: launchctl print gui/${UID}/${LABEL}...
✓ launchctl print: pid = 90460

Step 5: launchctl bootout (cleanup)...
✓ launchctl bootout succeeded
✓ service deregistered (launchctl print returns non-zero)
```

## 验证项

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | bun 二进制签名状态记录（informational） | ✅ Mach-O thin arm64（macOS 默认接受） |
| 2 | unsigned plist 通过 `launchctl bootstrap gui/<uid>` 加载 | ✅ |
| 3 | launchd-spawned 进程实际运行（heartbeat 文件出现） | ✅ |
| 4 | `launchctl print gui/<uid>/<label>` 报告 pid | ✅ |
| 5 | `launchctl bootout` 干净卸载 | ✅ |
| 6 | 卸载后 `launchctl print` 返回非零（即服务已不存在） | ✅ |

## 架构含义

**对 `architecture.md` §10 的修正**：无。§10 描述的安装路径 plan/apply/verify 不涉及签名，**和实际行为一致**。

**对 installer 实施的指导**：

- `claude-discord-bot install` 不需要写签名步骤
- plist 文件本身不需要签名
- daemon 二进制（编译后的 .js 或 bun 本身）不需要 codesign 处理
- 用户域（gui/<uid>）的 LaunchAgent 不触发 Gatekeeper 弹窗（这是 Apple 设计——Gatekeeper 拦的是从 Internet 下载的 .app，不是用户主动放到 LaunchAgents 的脚本）

**对未来的 production 关注点**（不影响 MVP）：

- 如果将来发布预编译的二进制（`bun build --compile`），那个二进制的 quarantine attribute 可能需要被 strip：`xattr -d com.apple.quarantine <binary>`
- 如果使用 npm install 得到的 daemon（仍是 .js + node_modules），bun 跑时不触发 quarantine（因为不是从 download 来）
- Apple 在 macOS 16/17 之后可能进一步收紧 LaunchAgent 策略——届时再 spike

## 已知不验证项

| 项 | 说明 |
| --- | --- |
| Apple Silicon vs Intel Mac 差异 | 本次仅在 arm64 跑，但 launchctl 行为应一致 |
| macOS 14 / 15 / 16 跨版本 | 仅本机版本测；版本差异可能存在但概率低 |
| Gatekeeper 弹窗（来自 download） | 我们走 npm install，不触发；如果将来分发 .app bundle 才需要重测 |

## 后续

- Spike code 中的 `verify.ts` plist generation 直接进 `src/installer/plist-template.ts`
- `process.on('exit')` 自动清理模式直接进 `src/installer/apply-launchd.ts`（apply 失败时 bootout 已 bootstrap 的 service）
- Production installer 不引入签名步骤；后续如有 macOS 版本调整再加
