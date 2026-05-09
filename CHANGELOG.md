# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org).

The plugin manifest version (`.claude-plugin/plugin.json`),
marketplace.json version, and `package.json` version are kept in lockstep —
bump all three on each release.

## [Unreleased]

## [0.0.3] - 2026-05-09

### Added
- Channel mode end-to-end working (#25, #27, #32): self-host marketplace via
  `.claude-plugin/marketplace.json` + `plugin.json`; documented `--channels
  plugin:claude-discord@jacobbubu` setup including macOS managed-settings
  `allowedChannelPlugins` configuration
- Slash commands now work in DMs in addition to guild channels (#35) — `setContexts(Guild, BotDM, PrivateChannel)` + global registration alongside per-guild
- Workspace name auto-suffix on collision (`-2`, `-3`, …) per architecture spec; prevents thrash when two CC sessions share the same `cwd` (#34)
- Daemon-side `rateLimited` event listener for observability (#37)
- `scripts/perf-sample.sh` — sample daemon + plugin CPU%/RSS over time, for SC-1 7-day soak (#37)
- `scripts/fr-audit.ts` — heuristic auto-audit of PRD §11 FRs against current implementation (#37)
- `_bmad-output/verification-matrix.md` — SC + NFR coverage tracking (#36)
- `_bmad-output/fr-audit-reviewed.md` — human-reviewed FR audit (73/74 ✅, 1/74 ❌ day-2) (#39)

### Fixed
- Plugin no longer orphans into ~98% CPU loop after parent CC TUI exits — `StdioServerTransport.onclose` + `process.stdin.on('end'/'close')` belt-and-suspenders trigger `process.exit(0)` (#26 / #31)
- Permission DM main prompt no longer exposes internal `request_id` — folded into "See more" expansion (#29 / #30)

### Tests
- 184 tests / 1 skipped (gated live claude CLI). Coverage 62% → 77% (slash-commands 3.75% → 78.94%, tool-handlers 34% → ~80%, permission-relay 57% → 88.77%) — added unit tests for slash command handlers (#40), 4 MCP tool handlers (#41), and permission-relay button + handlePluginRequest paths (#42)

## [0.0.2] - 2026-05-09

### Added
- Plugin marketplace manifest (`.claude-plugin/plugin.json` +
  `.claude-plugin/marketplace.json`) so this repo is a self-host marketplace
  (#27). Bumped from 0.0.1 to force `/plugin update` to refresh cache.

## [0.0.1] - 2026-05-08

Initial MVP release. Epic A (single-bot multi-workspace gateway) complete:

- Daemon (singleton) + plugin (CC subprocess) + CLI (`claude-discord-bot`)
- NDJSON over Unix domain socket, version + capability negotiation
- Routing table with hot reload + atomic writes
- LRU soft cap (50, trim to 45) with self-healing reconnect
- Ring buffer (50/workspace) for `/recent`
- Permission Q&A relay (button + text "yes XXXXX")
- Access policy (pairing / allowlist / disabled), guild opt-in, mention detection
- launchd (macOS) + systemd (Linux) install plans
- Six slash commands: `/use`, `/last`, `/list`, `/which`, `/recent`, `/status`
- Five MCP tools: `reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`
- 132 tests across 30 files (controlled e2e + live e2e #1 + unit/integration)
- Real Discord smoke verified (`claude_test#5883` login)

[Unreleased]: https://github.com/jacobbubu/claude-discord/compare/0.0.3...HEAD
[0.0.3]: https://github.com/jacobbubu/claude-discord/compare/0.0.2...0.0.3
[0.0.2]: https://github.com/jacobbubu/claude-discord/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/jacobbubu/claude-discord/releases/tag/0.0.1
