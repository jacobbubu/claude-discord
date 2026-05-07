# claude-discord

A machine-level agent gateway daemon for Discord × Claude Code. Run multiple
Claude Code workspaces on your machine, route them to a small pool of Discord
channels, switch between them with `/use <workspace>`, and pick up your work
from your phone.

Inspired by
[`claude-plugins-official/discord`](https://github.com/anthropics/claude-plugins)
but rewritten from scratch under MIT, with the product specification driven
through [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD).

## Status

**Epic A MVP complete.** All six slices merged, 113 unit/integration tests
passing, real Discord gateway login verified (`claude_test#5883`). See
`_bmad-output/planning-artifacts/` for the full BMAD planning chain
(brief / PRD / architecture / epics).

Remaining for full release:

- ⏳ Live e2e (real Discord DM ↔ real Claude Code). See
  [LIVE_TEST.md](./LIVE_TEST.md).
- ⏳ 7-day soak test (run the daemon for a week, watch `status`).
- ⏳ Public release (currently `private`; flip when ready).

## How it works

```
┌────────────┐  MCP stdio  ┌────────┐  Unix socket  ┌─────────┐  Discord  ┌─────────┐
│ Claude Code│ ──────────▶ │ Plugin │ ────────────▶ │ Daemon  │ ────────▶ │ Discord │
│ (workspace │  CC's tools │ (proxy)│   NDJSON       │ (single │  gateway  │  bot    │
│  foo)      │             │        │                │  bot,   │           │         │
└────────────┘             └────────┘                │  N      │           │         │
                                                     │  workspc│           │         │
┌────────────┐  MCP stdio  ┌────────┐  Unix socket  │  routed)│  Discord  │ Discord │
│ Claude Code│ ──────────▶ │ Plugin │ ────────────▶ │         │ ◀──────── │  user   │
│ (workspace │             │ (proxy)│                │         │   DM /    │         │
│  bar)      │             │        │                │         │ slash cmd │         │
└────────────┘             └────────┘                └─────────┘           └─────────┘
```

- **Daemon** (singleton, optional launchd/systemd service): owns the Discord
  gateway connection, the workspace registry, the routing table, the rate
  limiter, the ring buffer for `/recent`, and the LRU eviction policy.
- **Plugin** (CC subprocess via `.mcp.json`): a thin proxy with two IO streams
  — MCP stdio with CC, Unix domain socket with daemon. Forwards tool calls
  outbound, MCP notifications inbound. Auto-reconnects on socket close.
- **CLI** (`claude-discord-bot`): start / install / configure / pair / use
  / list / status / logs / reset / etc. Stateless, all subcommands wrap
  `~/.claude/channels/discord/` state files or invoke launchctl/systemctl.

Architecture details: see
[`_bmad-output/planning-artifacts/architecture.md`](./_bmad-output/planning-artifacts/architecture.md).

## Requirements

- [Bun](https://bun.sh) 1.x (runtime — same as the upstream Discord plugin)
- macOS or Linux (Windows post-MVP)
- A Discord bot application + token (see [LIVE_TEST.md](./LIVE_TEST.md) §1)

## Quick start

```bash
# 1. Install deps
bun install

# 2. Configure your Discord bot token
bun run src/cli/index.ts configure MTIz...

# 3a. Foreground daemon (development / testing)
bun run src/cli/index.ts start

# 3b. ...or install as a system service (production)
bun run src/cli/index.ts install            # launchd on macOS, systemd on Linux
bun run src/cli/index.ts install --dry-run  # see what install would do without applying

# 4. In another terminal, open Claude Code in any project directory:
cd /path/to/some-project
claude   # CC reads .mcp.json and auto-spawns the plugin which connects to the daemon

# 5. From Discord, DM your bot any message → receive a 6-hex pairing code
bun run src/cli/index.ts pair <6-hex-code>

# 6. Now from Discord, /use <workspace> to bind a channel and send messages.
```

## CLI reference

| Command | Description |
| --- | --- |
| `start` | Run daemon in foreground (no install required) |
| `dev` | Foreground daemon with file watch (auto-restart on src changes) |
| `configure <token>` | Write Discord bot token to `~/.claude/channels/discord/.env` (mode 0o600) |
| `install [--dry-run]` | Register daemon as launchd / systemd user service |
| `uninstall` | Reverse `install` (idempotent) |
| `stop` / `restart` | Stop / restart the installed service |
| `status` | Show daemon health + service state + state file presence |
| `logs [-f]` | Tail daemon logs (`-f` follows) |
| `reset [--routing\|--inbox\|--pending\|--all\|--including-token\|--including-acl]` | Clear scoped state files |
| `pair <code>` / `deny <code>` | Approve / reject a pending pairing |
| `allow <senderId>` / `remove <senderId>` | Add / remove a Discord user snowflake from allowFrom |
| `policy <pairing\|allowlist\|disabled>` | Set DM gating policy |
| `group add <channelId> [--no-mention] [--allow id1,id2]` / `group rm <channelId>` | Guild channel opt-in |
| `set <key> <value>` | Configure delivery key (`ackReaction` / `replyToMode` / `textChunkLimit` / `chunkMode` / `mentionPatterns`) |
| `access` | Print summary of access state (policy / allowFrom / pending / groups) |

Discord-side slash commands (registered when daemon connects to Discord):
`/use <workspace>` · `/last` · `/list` · `/which` · `/recent [n]` · `/status [workspace]`

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run test        # vitest run (113 tests)
bun run check       # typecheck + tests
bun run dev         # foreground daemon with file watch
```

Spike prototypes that validated each architectural decision live in
[`spikes/`](./spikes) — each has its own `RESULTS.md`:

- `6-mcp-thin-proxy/` — plugin runs MCP stdio + outbound socket in one Bun process
- `7-launchd-socket/` — Unix socket permissions + plist syntax
- `8-plist-signing/` — launchd doesn't require code signing for user agents
- `9-discord-autocomplete/` — discord.js 14 slash command autocomplete API

## Project structure

```
src/
├── daemon/         # Singleton daemon — Discord gateway, registry, ring buffer, LRU,
│                   #   routing, access control, slash commands, permission relay
├── plugin/         # CC-side thin proxy: MCP stdio ↔ Unix socket
├── cli/            # claude-discord-bot subcommands
├── installer/      # plist / systemd templates + plan/apply/verify
├── protocol/       # NDJSON wire schemas (zod) + version + framing
└── shared/         # paths, atomic write, logger
```

## Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `CLAUDE_DISCORD_STATE_DIR` | State directory (override for testing) | `~/.claude/channels/discord/` |
| `DISCORD_BOT_TOKEN` | Discord bot token (set by `configure` or shell env) | — |
| `DISCORD_ACCESS_MODE` | Set to `static` to snapshot access.json at boot (no runtime writes) | live |
| `CLAUDE_DISCORD_WORKSPACE_CAP` | LRU soft cap for active workspaces | 50 |
| `CLAUDE_DISCORD_WORKSPACE_TRIM_TARGET` | LRU trim target on eviction | 45 |
| `CLAUDE_DISCORD_LOG_LEVEL` | `error` / `warn` / `info` / `debug` | `info` |

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

- The [official Discord plugin](https://github.com/anthropics/claude-plugins)
  for the access control + permission Q&A model, which we ported with light
  cleanup
- [openclaw](https://github.com/openclaw/openclaw) for the daemon-install-plan
  pattern (plan → apply → verify → rollback)
- BMAD-METHOD for the analyst → PM → architect → epic-breakdown flow
