# Spike #9 — discord.js application command 自动补全

**状态**：✅ **静态验证通过**；live 模式（连真 Discord）作为可选人工跑

**日期**：2026-05-06

## 待验证假设

来自 `architecture.md` §16.2：

> Slash 命令自动补全：注册 Discord application command，参数类型由 Discord 客户端校验。Autocomplete handler 查 `WorkspaceRegistry` 列出活动 workspace 名。

具体技术问题：

- discord.js 14.x 的 `SlashCommandBuilder` 是否支持 `addStringOption().setAutocomplete(true)`？
- 生成的 JSON 是否符合 Discord application command API？
- `interactionCreate` 中能否区分 `isAutocomplete()` 和 `isChatInputCommand()`？

## 验证方法

写一个**双模式**的 spike bot：

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| **Static**（默认） | 不设环境变量 | 构造 SlashCommandBuilder，dump JSON，断言关键字段。无网络。 |
| **Live**（可选） | 设 `SPIKE9_TEST_BOT_TOKEN` + `SPIKE9_TEST_GUILD_ID` | 注册命令到测试 guild + 连 Discord + 处理 interaction。Ctrl-C 时 deregister 清理 |

**为什么不用上游已有的 bot token**：会污染你日常使用的 bot——slash 命令注册到上游 bot 会让所有 guild 看到这些命令。所以默认 static，live 必须显式提供独立 test token。

## 测试运行

```bash
cd spikes/9-discord-autocomplete
bun install
bun run bot.ts
```

输出：

```
Mode: STATIC (no network)

SlashCommandBuilder /use → JSON:
{
  "options": [
    {
      "autocomplete": true,
      "type": 3,
      "name": "workspace",
      "description": "Workspace name",
      "required": true
    }
  ],
  "name": "use",
  "description": "Switch this channel to a workspace",
  "type": 1
}

✓ /use payload has type:3 (string) + autocomplete:true + required:true
✓ /recent payload has type:4 (integer) + min:1 max:5

Verified discord.js 14 API surface supports:
  - addStringOption().setAutocomplete(true)
  - addIntegerOption().setMinValue(1).setMaxValue(5)
  - .toJSON() emits Discord-compatible application command payload
```

## 验证项

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | discord.js 14 `SlashCommandBuilder` 编译通过 | ✅（bun 跑过，无 TS 错） |
| 2 | `.addStringOption(o => o.setAutocomplete(true))` 在 JSON 输出中产生 `autocomplete: true` | ✅ |
| 3 | `.addIntegerOption(o => o.setMinValue(1).setMaxValue(5))` 产生 `min_value: 1, max_value: 5` | ✅ |
| 4 | `.toJSON()` 输出与 Discord application command API 兼容（type 3 = STRING, type 4 = INTEGER） | ✅（手工核对 Discord API docs） |
| 5 | `Interaction` 类型 narrowing 中含 `isAutocomplete()` 与 `isChatInputCommand()` | ✅（TS 编译通过） |

## 架构含义

`architecture.md` §16.2 与 §11 Epic 4（slash 命令套件）的描述**完全可实现**。具体：

- `/use` `/recent` `/list` `/which` `/last` `/status` 六个命令都能用 `SlashCommandBuilder` 链式构造
- Autocomplete handler 是 `interactionCreate` 中的一个分支，不需要单独连接
- 注册路径有两条：global（所有 guild，传播延迟可达 1h）vs per-guild（单 guild，立即生效）。**MVP 期建议 per-guild**（用户加 bot 到自己 server 后立即可用），稳定后再考虑 global。

## 未自动验证项（live 模式人工跑）

如果你想真实在 Discord 客户端验证 autocomplete UX：

1. 在 Discord Developer Portal 创建一个**独立的 test bot**（别用现有 .env 里的）
2. Reset 它的 token，把 token 设为 `SPIKE9_TEST_BOT_TOKEN`
3. 邀请该 bot 到一个**独立的 test guild**（或你的私人测试 server），把 guild id 设为 `SPIKE9_TEST_GUILD_ID`
4. 跑：

```bash
cd spikes/9-discord-autocomplete
SPIKE9_TEST_BOT_TOKEN=... SPIKE9_TEST_GUILD_ID=... bun run bot.ts
```

5. 在 Discord 客户端打 `/use ` 看下拉是否出现候选；试 `/recent 3`
6. Ctrl-C 停止——bot 会自动 deregister 命令清理

**期望**：

- 客户端打 `/` 后看到 `/use` 与 `/recent` 在补全菜单里
- `/use` 后空格触发 autocomplete，显示 fake workspace 列表（claude_discord、eos、moltis 等）
- `/recent` 的 `n` 参数被客户端校验在 1-5 范围
- 移动端（iOS / Android Discord）同 desktop 行为一致

**对架构文档的修正**：无。§16.2 已准确描述实现路径。

## 后续

- `bot.ts` 中 `buildUseCommand()` / `buildRecentCommand()` 风格直接进 `src/daemon/slash-commands.ts`
- `handleAutocomplete()` 中"focus → filter → respond 25 max"模式直接用
- 注册路径建议先 per-guild（MVP），稳定后转 global（user-experience 改进）
