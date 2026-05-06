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
