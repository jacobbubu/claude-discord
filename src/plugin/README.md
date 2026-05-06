# plugin/

CC-side MCP plugin (thin proxy between CC stdio and daemon socket).

**Slice 1 status**: empty stub. Spike #6 has a 50-line prototype that proved
the architecture works; the production module lands in **Slice 2**.

When implemented:

- `index.ts` — entry: `bun run src/plugin/index.ts`, runs MCP server +
  daemon socket client in same Bun event loop
- `mcp-server.ts` — wraps `@modelcontextprotocol/sdk` Server with the 5 tools
- `socket-client.ts` — Unix domain socket client with reconnect + heartbeat
- `tool-handlers.ts` — bridges MCP tool calls ↔ daemon NDJSON tool_call
- `inbound-relay.ts` — daemon push → MCP `notifications/claude/channel`
- `reconnect.ts` — exponential backoff for daemon socket disconnect

See `_bmad-output/planning-artifacts/architecture.md` §7 + §4.2.
