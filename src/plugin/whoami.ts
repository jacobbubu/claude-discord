/**
 * `whoami` tool — plugin self-introspection. Pure builder, no I/O, no
 * daemon round-trip; exported separately so tests can import without
 * triggering plugin/index.ts's top-level connectLoop.
 *
 * Architecture deltas §11.
 */

import { PROTOCOL_VERSION } from '../protocol/version.ts'
import type { ToolResultMsg } from '../protocol/schema.ts'

export type WhoamiInfo = {
  /** Daemon-assigned workspace name (with auto-suffix if collided). null pre-register. */
  workspace: string | null
  /** Daemon Unix socket path. */
  daemon_socket: string
  /** Agent identifier passed in register handshake. */
  agent: string
  /** Plugin version from `.claude-plugin/plugin.json` at install path, or '?' if unreadable. */
  plugin_version: string
  /** True iff plugin currently has a live socket to daemon. */
  connected: boolean
}

export function buildWhoamiResult(info: WhoamiInfo): ToolResultMsg {
  return {
    type: 'tool_result',
    v: PROTOCOL_VERSION,
    id: 'whoami',
    ok: true,
    result: JSON.stringify(info, null, 2),
  }
}
