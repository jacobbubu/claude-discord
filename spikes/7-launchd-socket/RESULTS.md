# Spike #7 — Unix socket on launchd 权限验证结果

**状态**：✅ **自动验证全部通过**；2 项 manual follow-up 留作开发期手测

**日期**：2026-05-06

## 待验证假设

来自 `architecture.md` §17 / §20：

- daemon 通过 launchd 启动时创建的 Unix socket 文件 mode 应为 0o600
- 父目录 `~/.claude/channels/discord/` mode 应为 0o700
- daemon 进程应以 owner = 当前 user 身份运行（不被 launchd 提权）
- 同 user 同机器能连，他 user 不能
- plist 模板语法合法

## 验证方法

写两个文件 + 一个验证驱动：

| 文件 | 角色 |
| --- | --- |
| `daemon-stub.ts` | 最小 daemon，创建带 0o600 socket，等连接 |
| `plist-template.xml` | LaunchAgent 模板，含 `{HOME}` / `{BUN_PATH}` / `{INSTALL_DIR}` 占位符 |
| `verify.ts` | 驱动：跑 daemon-stub、检查 mode/owner/connect、用 plutil 校验 plist |

**关键设计选择**：本 spike 不真实 `launchctl load` 用户的 LaunchAgents 目录——避免污染本机环境。改为：

- daemon-stub 在 tempdir 创建 socket，等价模拟 launchd 启动后的运行态
- plist 用 `plutil -lint` 静态校验 + `plutil -p` 检查关键键
- "真实 launchctl 安装+卸载"作为 RESULTS.md 末尾的人工手测步骤

## 测试运行

```bash
cd spikes/7-launchd-socket
bun install
bun run verify.ts
```

输出：

```
Step 1: spawning daemon-stub...
daemon-stub: pid=81277 uid=501 socket=.../daemon.sock mode=600 dirMode=700
✓ socket exists: .../daemon.sock
✓ socket mode = 0o600
✓ parent dir mode = 0o700
✓ socket owner = current user (uid 501)
Step 5: connect from same shell user...
daemon-stub: client connected
✓ same-user connect + echo works
Step 6: rendering plist + plutil -lint...
✓ plist syntax valid (plutil -lint passed)
✓ Label / RunAtLoad / KeepAlive all set as expected

🎉 All assertions passed.
```

## 自动验证项

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | daemon 创建 socket，文件 mode = 0o600 | ✅ |
| 2 | 父目录 mode = 0o700 | ✅ |
| 3 | daemon 进程 uid = 当前 user uid（无提权） | ✅ |
| 4 | 同 user 同机器 connect + echo 工作 | ✅ |
| 5 | plist 模板 plutil -lint 通过 | ✅ |
| 6 | plist 包含 Label / RunAtLoad / KeepAlive 关键键且值正确 | ✅ |

## 架构含义

- `architecture.md` §17.3（socket 权限）描述与实际可达的状态一致——0o600 socket + 0o700 父目录 + owner = user 全部能强制
- `architecture.md` §10.2（plist 模板）格式经 plutil 校验合法，可作为 installer 实现的起点
- 实施时 daemon 启动后必须做以下两件事：
  - `mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })`
  - `chmodSync(SOCKET_PATH, 0o600)` after `server.listen()`（mkdirSync 与 listen 都受 umask 影响，必须显式 chmod）

## 未自动验证项（开发期人工跑）

### Manual #1 — 真实 launchctl bootstrap

```bash
# 1. 把 plist 复制到 LaunchAgents
cp plist-template.xml ~/Library/LaunchAgents/com.jacobbubu.claude-discord-spike-7.plist

# 2. 替换占位符
BUN_PATH=$(which bun)
INSTALL_DIR=$(pwd)
sed -i '' "s|{BUN_PATH}|$BUN_PATH|g; s|{INSTALL_DIR}|$INSTALL_DIR|g; s|{HOME}|$HOME|g" \
  ~/Library/LaunchAgents/com.jacobbubu.claude-discord-spike-7.plist

# 3. 装载
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jacobbubu.claude-discord-spike-7.plist

# 4. 看是否在跑
launchctl print gui/$(id -u)/com.jacobbubu.claude-discord-spike-7

# 5. 检查 socket 是否被 launchd-起的 daemon 创建并 0o600
ls -la ~/.claude/channels/discord/spike-7.sock

# 6. 卸载
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jacobbubu.claude-discord-spike-7.plist

# 7. 删 plist
rm ~/Library/LaunchAgents/com.jacobbubu.claude-discord-spike-7.plist
rm -f ~/.claude/channels/discord/spike-7.sock
rm -f ~/.claude/channels/discord/spike-7.{out,err}.log
```

**期望结果**：步骤 5 看到 `srw-------` 0o600 mode 的 socket 文件，owner 是当前 user。如果这条不成立（罕见但可能 — 某些 macOS 版本对 launchd-spawned 进程的 umask 处理不同），需要 daemon 启动时显式 chmod。我们的 daemon-stub 已经显式 chmod，所以这条预期通过。

### Manual #2 — 跨用户拒绝访问

需要在同一台 Mac 上有第二个 user account。开发期不必每次都测——只在涉及多用户安全语义时（即 enterprise 场景，目前 out of scope）需要。

简化的等价测试：用 `chmod 0o644` 把 socket 临时开放给所有人，看会不会真的被另一个用户连上——但这违背我们的产品定位（单用户），不必做。

## 后续

- `daemon-stub.ts` 中的 mkdirSync + chmodSync 双重保险写法直接进 `src/daemon/index.ts` 启动序列
- `plist-template.xml` 直接进 `src/installer/plist-template.ts`（编译期模板，运行时填占位符）
- `verify.ts` 中 plutil -lint / plutil -p 的检查逻辑可作为 `installer/apply.ts` 的"安装后 verify"步骤参考
