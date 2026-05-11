/**
 * One Connection per plugin socket. Holds line buffer, workspace identity,
 * last-activity timestamp, and helpers to send typed messages.
 */

import type { Socket } from 'node:net'
import { encode } from '../protocol/ndjson.ts'
import type { WireMsg } from '../protocol/schema.ts'

export type ConnectionState = 'pre-register' | 'registered' | 'closed'

export class Connection {
  state: ConnectionState = 'pre-register'
  workspace: string | null = null
  agent: string | null = null
  capabilities: string[] = []
  lastActivityTs: number = Date.now()
  /** Plugin's cwd from register handshake. Used by daemon to reverse-look-up
   *  workspace by cwd for the cc_permission_request hook (deltas §16). */
  cwd: string | null = null
  /** Last inbound message's chat_id (DM channel id or guild channel id),
   *  set by inbound-router before forwarding. Used by deltas §16 to route
   *  cc_permission_request buttons back to the prompt's source chat. */
  lastInboundChatId: string | null = null
  /** Truncated preview of last inbound content — used to name the per-turn
   *  trace thread (deltas §24). Reset on each new inbound. */
  lastInboundPreview: string | null = null
  /** Deltas §24: current turn's tool-trace thread. Set lazily on first
   *  cc_tool_trace after inbound; cleared whenever a new inbound arrives so
   *  each turn gets a fresh thread. */
  activeTraceThreadId: string | null = null

  constructor(public readonly socket: Socket) {}

  send(msg: WireMsg): void {
    if (this.state === 'closed') return
    try {
      this.socket.write(encode(msg))
    } catch {
      // socket may have been closed by peer; ignore — close handler will mark state
    }
  }

  touch(): void {
    this.lastActivityTs = Date.now()
  }

  close(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    try {
      this.socket.end()
    } catch {}
    try {
      this.socket.destroy()
    } catch {}
  }
}
