# Contributing to claude-discord

This project's spec is driven through
[BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) v6.6.0 (`bmm`
module + `claude-code` tool). Every non-trivial change starts with an
architecture delta written down before any code.

## Development workflow

```bash
git clone https://github.com/jacobbubu/claude-discord
cd claude-discord
bun install

bun run typecheck   # tsc --noEmit
bun run test        # vitest run (500+ tests across unit / integration)
bun run check       # typecheck + tests
bun run dev         # foreground daemon with file watch
```

## BMAD spec-first workflow

Every non-trivial change goes through:

1. **Append** a numbered `### §N` section to
   `_bmad-output/planning-artifacts/architecture.md` describing the problem,
   the change, and the test plan — **before** any code is written.
2. **Open** a GitHub issue in Chinese, labelled with the canonical
   work-type label (`feature` / `bug` / `chore` / `requirement` / `research`).
3. **Branch** as `codex/<issue-id>-<short-slug>`, implement, push.
4. **Open a PR** titled `<type>: <短摘要> (#<issue-id>)`. PR body
   references the architecture §N + lists the verification steps that
   proved the change.

Why bother: there are now 45+ architecture deltas (§1–§45+). Reading
`architecture.md` linearly gives the full history of *why* every moving
piece is the way it is, in commit order. Code-only diff archaeology would
take much longer.

`docs/` vs `_bmad-output/planning-artifacts/`: long-running project
knowledge (reference notes, code-review reports, deep-dive research) goes
in `docs/`. Delta-scoped artifacts (one architecture §N = one decision)
stay in `_bmad-output/planning-artifacts/`. If you're not sure: "is this
*about* a specific code change?" — yes → append a §N to architecture.md
and link the doc from there.

## Project structure

```
src/
├── daemon/                # Singleton daemon — Discord gateway, registry,
│                          #   ring buffer, LRU, routing, access control,
│                          #   slash commands, permission relay, typing
│                          #   heartbeat, tool trace
├── plugin/                # CC-side thin proxy: MCP stdio ↔ Unix socket,
│                          #   orphan-watcher, reconnect/backoff
├── cli/                   # claude-discord-bot subcommands + PreToolUse /
│                          #   PostToolUse / Stop hook entrypoints
├── installer/             # plist / systemd templates + plan/apply/verify
├── protocol/              # NDJSON wire schemas (zod) + version + framing
└── shared/                # paths, atomic write, rotating-file logger

_bmad/                     # BMAD-METHOD v6.6.0 install (bmm module).
│                          #   Source-controlled so anyone can re-run skills.
│                          #   Local customizations live in custom/ only.

_bmad-output/
├── planning-artifacts/    # Spec gate (PRD / architecture / epics) —
│                          #   committed. Each merged delta first appended
│                          #   a §N section to architecture.md before any
│                          #   code changed.
└── brainstorming/         # Brainstorming session snapshots — committed.

docs/                      # Long-term project knowledge (research, code
                           #   reviews). Not tied to a specific delta.

.claude/skills/            # 42 BMAD skills written by the installer.
                           #   Invoke via `bmad-help`, `bmad-create-architecture`,
                           #   etc.
```

## Spike prototypes

Each major architectural decision was validated by a throwaway spike that
lives in [`spikes/`](./spikes). Each has its own `RESULTS.md` with what
worked, what didn't, and the decision rationale:

- `6-mcp-thin-proxy/` — plugin runs MCP stdio + outbound socket in one Bun process
- `7-launchd-socket/` — Unix socket permissions + plist syntax
- `8-plist-signing/` — launchd doesn't require code signing for user agents
- `9-discord-autocomplete/` — discord.js 14 slash command autocomplete API

## BMAD documentation map

```
_bmad-output/
├── planning-artifacts/       ← committed: spec, plans, audits
│   ├── product-brief.md
│   ├── prd.md                ← 73 FRs + 7 NFRs (single source of truth)
│   ├── architecture.md       ← module-by-module mapping + every §N delta
│   ├── epics.md              ← Epic A MVP breakdown
│   └── prd-validation-report.md
├── verification-matrix.md    ← SC + NFR audit
├── fr-audit.md               ← auto-generated FR audit (heuristic)
├── fr-audit-reviewed.md      ← human-reviewed FR audit (canonical)
└── brainstorming/            ← analyst-stage discovery sessions

docs/                         ← long-term reference, not BMAD planning
├── research/                 ← upstream architecture deep-dives, capability inventory
└── reviews/                  ← code-review reports

CHANGELOG.md                  ← release history (Keep a Changelog format)
LIVE_TEST.md                  ← real-Discord walk-through
```

### Commit policy

| Path | Committed? |
| --- | --- |
| `_bmad-output/planning-artifacts/` | yes (review + traceability) |
| `_bmad-output/brainstorming/` | yes (decision provenance) |
| `_bmad-output/implementation-artifacts/` | no (per-session scratch) |
| `docs/` | yes (long-term project knowledge) |

## Using BMAD skills inside Claude Code

In a fresh CC session, type `/bmad-help` (or any `/bmm:*` skill) — they're
registered under `.claude/skills/`.

Common entry points:

```text
> use the bmad-help skill                  # lists every BMAD skill available
> use the bmad-create-architecture skill   # add a new architecture §N
> use the bmad-create-prd skill            # update the PRD (if scope expands)
```

Re-running the installer is safe: `npx bmad-method install` re-applies
upstream files but honours `_bmad/custom/config.toml` (which pins
`core.output_folder = "_bmad-output"` and the Chinese output preference).
**Don't edit anything outside `_bmad/custom/` directly** — those changes
get clobbered on the next install.

For verification status, read `_bmad-output/verification-matrix.md` first —
it tells you which SC / NFR / FR are ✅ vs ❌ pending.

## Issue & commit conventions

- All issues in Chinese: titles, bodies, comments, delivery notes.
- One primary label per issue: `feature` / `bug` / `chore` / `requirement` / `research`.
- Branch naming: `codex/<issue-id>-<short-slug>`. One branch per issue.
- Commit + PR title format: `<type>: <short summary> (#<issue-id>)`.
- Every merged change references the originating issue.
- Don't ship "cleanup" / "misc" / no-issue commits.

Full discipline rules: see `CLAUDE.md` (project-level instructions for AI
agents).

## Pre-flight before opening a PR

```bash
bun run check       # typecheck + tests must pass
```

If you touched the daemon or plugin schema, also restart the daemon
locally and verify a Discord round-trip — `bun run test` mocks Discord.
