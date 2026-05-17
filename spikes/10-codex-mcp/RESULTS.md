# Spike 10 — Codex MCP integration

**Goal:** confirm we can register the existing `src/plugin/index.ts` MCP
server with OpenAI's Codex (desktop app primary target, closed-source) so
the same daemon ↔ plugin pipeline works for both Claude Code and Codex.

**Date:** 2026-05-17

## Background

User wants Codex desktop to drive the same Discord ↔ agent gateway that CC
uses today. Codex is closed-source but per
[docs](https://developers.openai.com/codex/mcp):

- Desktop / CLI / IDE share `~/.codex/config.toml` for MCP server config
- STDIO MCP servers supported
- Codex has its own hooks system (PreToolUse / PostToolUse / Stop / etc.)
  configurable in `~/.codex/config.toml` inline or `~/.codex/hooks.json`

## Findings

### 1. MCP server registration format

Bundled plugin (computer-use) uses a sibling `.mcp.json` with the standard
Anthropic-style schema:

```json
{
  "mcpServers": {
    "<name>": {
      "command": "...",
      "args": ["..."],
      "cwd": "."
    }
  }
}
```

For ad-hoc registration (not via plugin marketplace), Codex's
[Configuration Reference](https://developers.openai.com/codex/config-reference)
documents the `[mcp_servers.<name>]` TOML table form.

### 2. Plugin manifest format

`.codex-plugin/plugin.json` is essentially a superset of our existing
`.claude-plugin/plugin.json`:

| Field | CC `.claude-plugin/plugin.json` | Codex `.codex-plugin/plugin.json` |
| --- | --- | --- |
| `name` | ✓ | ✓ |
| `version` | ✓ | ✓ |
| `description` | ✓ | ✓ |
| `keywords` | ✓ | ✓ |
| `author` | — | object `{name, email, url}` |
| `homepage` | — | URL |
| `license` | — | string |
| `mcpServers` | implicit via top-level `.mcp.json` | explicit path string |
| `skills` | implicit `.claude/skills/` | explicit path string |
| `interface` | — | display metadata (displayName, screenshots, brandColor, defaultPrompt, etc.) |

If we want a polished Codex marketplace experience later, we'd add a
`.codex-plugin/plugin.json` with the interface block. For this spike we
take the shortcut: direct `~/.codex/config.toml` edit, no manifest.

### 3. Hooks

Codex hooks events: `PreToolUse / PostToolUse / PermissionRequest /
UserPromptSubmit / Stop`. Configured in
`~/.codex/config.toml` (or `~/.codex/hooks.json`) inline:

```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "bun run /path/to/permission-hook.ts"
timeout = 30
```

Same event names as CC, **but config format differs** (TOML inline tables
vs CC's JSON `~/.claude/settings.json`).

### 4. Inbound notifications (channel mode equivalent)

Open issues — not yet documented:

- [#15299](https://github.com/openai/codex/issues/15299): "Support inbound
  MCP notifications routed into an active Codex CLI session"
- [#17543](https://github.com/openai/codex/issues/17543): "Support
  injecting MCP custom notifications into Codex sessions"

Recent work on `codex-rmcp-client` reportedly adds notification-to-submission
conversion. Status unclear — needs empirical test once we have a working
MCP server registered.

## Experiment plan

1. **Backup `~/.codex/config.toml`** → done (`~/.codex/config.toml.bak-spike10`)
2. **Add MCP server entry** for our plugin
3. **Restart Codex desktop**
4. **From inside Codex**: ask it to call one of our tools (e.g. `reply`
   to a known chat_id). Verify Discord receives the message.
5. **Test hooks**: add a stub PreToolUse hook that logs to a file. Verify
   firing.
6. **Test notification push (channel mode)**: have daemon push an inbound
   notification (existing `relayInbound`) and see if Codex picks it up.

## Status

- ✓ Codex confirmed installed (`~/.codex/` exists, config.toml present)
- ✓ Backup made
- ✓ Added `[mcp_servers.claude-discord]` to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.claude-discord]
  command = "bun"
  args = ["run", "/Users/rongshen/vibe-coding/claude_discord/src/plugin/index.ts"]
  ```
- ✓ User restarted Codex desktop
- ✓ **Codex spawned the plugin, plugin registered with daemon, `whoami`
  tool returned correctly** (workspace `oai_artifact_tool`, socket
  connected:true)
- ✓ **`reply` tool round-trip works end-to-end**: Codex → plugin → daemon
  → Discord. Confirmed message landed in channel 1501813221512970340
  with message id 1505563030799519806.
- ⏳ Inbound notification (channel mode equivalent) — next
- ⏳ Hooks (PreToolUse / PostToolUse / Stop) — pending

## Findings (revised)

**Zero code changes required** for the baseline integration. The plugin
already registers with `agent: 'claude-code'`, and the daemon accepts
that string. The daemon does not need to know whether the upstream agent
is CC or Codex — the MCP protocol abstracts it cleanly.

The whole pipeline (plugin ← MCP stdio ← Codex; plugin → Unix socket →
daemon → Discord gateway → user) works on the very first try, with no
adaptation. This is much better than expected for a closed-source desktop
app.

### Observation: multiple workspaces spawn naturally

Daemon log shows 4 workspaces registered while we were testing:
`oai_artifact_tool`, `oai_artifact_tool-2`, `oai_artifact_tool-3`,
`ontology-for-sales`, `workspace`. Each Codex conversation / project that
references the MCP server in its config spawns a fresh plugin process.
Basename collision auto-suffixing (§4.2) works as designed.

## Open questions to answer

1. Does Codex strip MCP server stdout/stderr? Our plugin logs to stderr —
   need to know if that gets surfaced or swallowed.
2. Codex's MCP timeout? If our plugin takes >Ns to handshake, will Codex
   give up?
3. When user sends a Discord DM and daemon pushes a notification to the
   plugin, does Codex receive it as a "user-submitted" prompt or silently
   discard?
4. Channel mode allowlist equivalent — does Codex have anything similar
   to CC's `--channels` flag + macOS managed-settings? Or is MCP enough?

## References

- [Model Context Protocol – Codex](https://developers.openai.com/codex/mcp)
- [Hooks – Codex](https://developers.openai.com/codex/hooks)
- [Configuration Reference – Codex](https://developers.openai.com/codex/config-reference)
- [Sample plugin manifest](file:///Users/rongshen/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/computer-use/.codex-plugin/plugin.json)
