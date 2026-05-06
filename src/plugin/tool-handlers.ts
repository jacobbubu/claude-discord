/**
 * Bridges MCP tool calls (from CC) to daemon NDJSON tool_call.
 *
 * Owns the pendingResult correlation map: tool_call has a unique id, the
 * matching tool_result resolves the awaiting MCP request.
 */

import { PROTOCOL_VERSION } from '../protocol/version.ts'
import type { ToolResultMsg } from '../protocol/schema.ts'
import type { SocketClient } from './socket-client.ts'

export class ToolBridge {
  private pending = new Map<string, (m: ToolResultMsg) => void>()
  private nextId = 1

  constructor(
    private readonly socket: SocketClient,
    private readonly toolTimeoutMs = 60_000,
  ) {}

  /** Resolve any pending call matching the result's id. Caller from inbound dispatch. */
  receiveResult(msg: ToolResultMsg): void {
    const cb = this.pending.get(msg.id)
    if (cb) {
      this.pending.delete(msg.id)
      cb(msg)
    }
  }

  /** Reject every outstanding call (used on socket close to fail-fast). */
  rejectAll(reason: string): void {
    for (const cb of this.pending.values()) {
      cb({ type: 'tool_result', v: PROTOCOL_VERSION, id: '', ok: false, error: reason })
    }
    this.pending.clear()
  }

  /** Bridge an MCP tool call → daemon tool_call → wait for tool_result. */
  call(tool: string, args: Record<string, unknown>): Promise<ToolResultMsg> {
    const id = `tc-${this.nextId++}`
    return new Promise<ToolResultMsg>(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({
            type: 'tool_result',
            v: PROTOCOL_VERSION,
            id,
            ok: false,
            error: `tool_call timeout after ${this.toolTimeoutMs}ms`,
          })
        }
      }, this.toolTimeoutMs)
      timer.unref()

      this.pending.set(id, m => {
        clearTimeout(timer)
        resolve(m)
      })

      try {
        this.socket.send({ type: 'tool_call', v: PROTOCOL_VERSION, id, tool, args })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({
          type: 'tool_result',
          v: PROTOCOL_VERSION,
          id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })
  }
}
