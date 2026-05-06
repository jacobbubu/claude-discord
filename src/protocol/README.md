# protocol/

Plugin↔Daemon NDJSON protocol implementation.

**Slice 1 status**: empty stub. Spike #6 has the prototype implementation; the
production module lands in **Slice 2** (issue not yet open at the time of this
slice).

When implemented, this directory will contain:

- `schema.ts` — zod schemas for all wire messages (register / register_ack /
  heartbeat / inbound / tool_call / tool_result / permission_request /
  permission / evicted / bye)
- `version.ts` — `PROTOCOL_VERSION` constant + version-compat matrix
- `ndjson.ts` — line-buffered framing helpers

See `_bmad-output/planning-artifacts/architecture.md` §6 for full schema
specification.
