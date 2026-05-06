# claude-discord

A machine-level agent gateway daemon for Discord × Claude Code. Inspired by
[`claude-plugins-official/discord`](https://github.com/anthropics/claude-plugins)
but rewritten from scratch under MIT, with the product specification driven
through [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD).

## Status

**Slice 1 of Epic A**: project skeleton + `start` / `configure` CLI subcommands.
No Discord wiring yet — that lands in subsequent slices. See
[issue #11](https://github.com/jacobbubu/claude-discord/issues/11) for slice
plan and `_bmad-output/planning-artifacts/epics.md` for the full epic / story
breakdown.

## Requirements

- [Bun](https://bun.sh) 1.x (runtime; the upstream Discord plugin is also Bun-based)
- macOS or Linux (Windows post-MVP)

## Quick start

```bash
# Install deps
bun install

# Run the daemon in the foreground (slice-1 stub: initializes state dir, then idles).
bun run src/cli/index.ts start

# Configure your Discord bot token (writes ~/.claude/channels/discord/.env mode 0600).
bun run src/cli/index.ts configure MTIz...
```

State files live under `~/.claude/channels/discord/` by default. Override with
`CLAUDE_DISCORD_STATE_DIR=/some/path` when you want isolated test instances.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run check       # typecheck + tests
```

Source layout follows
[`_bmad-output/planning-artifacts/architecture.md`](./_bmad-output/planning-artifacts/architecture.md)
§9. Spike prototypes for protocol / launchd / autocomplete / signing live in
[`spikes/`](./spikes) — they validated each architectural decision before this
implementation began.

## License

MIT — see [LICENSE](./LICENSE).
