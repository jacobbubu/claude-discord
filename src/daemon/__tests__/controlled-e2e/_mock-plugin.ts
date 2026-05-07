/**
 * Test-side mock plugin: connects to daemon socket, sends register, optionally
 * pushes tool_call / permission_request, receives daemon-side messages.
 *
 * Replaces a real CC subprocess for stage-2 controlled e2e tests. The daemon
 * sees this as a regular plugin connection — register handshake, heartbeat,
 * inbound messages, tool_result responses all flow through.
 *
 * Real-CC subprocess driver (with --dangerously-skip-permissions) is a
 * future stretch goal; for regression coverage of daemon-integrated
 * behavior, this protocol-level mock is sufficient.
 */

import { connect, type Socket } from 'node:net'
import { LineBuffer, encode } from '../../../protocol/ndjson.ts'
import {
  WireSchema,
  type PermissionRequestMsg,
  type ToolCallMsg,
  type WireMsg,
} from '../../../protocol/schema.ts'
import { PROTOCOL_VERSION } from '../../../protocol/version.ts'

export type MockPluginOpts = {
  socketPath: string
  agent?: string
  cwd: string
  pid?: number
  capabilities?: string[]
}

export class MockPlugin {
  private sock: Socket | null = null
  private buf = new LineBuffer()
  /** Messages we've received from the daemon (in order). */
  readonly received: WireMsg[] = []
  /** Resolvers waiting for a particular message type. */
  private waiters: Array<{ predicate: (m: WireMsg) => boolean; resolve: (m: WireMsg) => void }> = []
  workspace: string | null = null
  serverCapabilities: string[] = []

  constructor(private readonly opts: MockPluginOpts) {}

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = connect(this.opts.socketPath)
      sock.setEncoding('utf8')
      const onErr = (err: Error) => reject(err)
      sock.once('error', onErr)
      sock.once('connect', () => {
        sock.removeListener('error', onErr)
        sock.on('error', () => {})
        sock.on('data', chunk => {
          for (const line of this.buf.push(chunk as unknown as string)) this.consumeLine(line)
        })
        sock.on('close', () => {
          this.sock = null
        })
        this.sock = sock
        resolve()
      })
    })
  }

  /** Send register and await register_ack (or register_reject). */
  async register(): Promise<{ ok: true; workspace: string } | { ok: false; reason: string }> {
    this.send({
      type: 'register',
      v: PROTOCOL_VERSION,
      agent: this.opts.agent ?? 'claude-code',
      cwd: this.opts.cwd,
      pid: this.opts.pid ?? process.pid,
      capabilities: this.opts.capabilities ?? ['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment'],
    })
    const ack = await this.waitFor(m => m.type === 'register_ack' || m.type === 'register_reject')
    if (ack.type === 'register_ack') {
      this.workspace = ack.workspace
      this.serverCapabilities = ack.server_capabilities
      return { ok: true, workspace: ack.workspace }
    }
    if (ack.type === 'register_reject') {
      return { ok: false, reason: ack.reason }
    }
    throw new Error(`unexpected register response: ${ack.type}`)
  }

  /** Send a NDJSON message to the daemon. */
  send(msg: WireMsg): void {
    if (!this.sock) throw new Error('not connected')
    this.sock.write(encode(msg))
  }

  /**
   * Issue a tool_call (the daemon will dispatch it to discord.js — in tests
   * that means MockClient). Returns the matching tool_result.
   */
  async callTool(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: string; error?: string }> {
    const id = `tc-${Math.random().toString(36).slice(2, 8)}`
    const call: ToolCallMsg = { type: 'tool_call', v: PROTOCOL_VERSION, id, tool, args }
    this.send(call)
    const res = await this.waitFor(m => m.type === 'tool_result' && m.id === id)
    if (res.type !== 'tool_result') throw new Error('unexpected response')
    return { ok: res.ok, result: res.result, error: res.error }
  }

  /** Send a permission_request (simulating what CC's MCP notification would forward). */
  sendPermissionRequest(req: Omit<PermissionRequestMsg, 'type' | 'v'>): void {
    this.send({ type: 'permission_request', v: PROTOCOL_VERSION, ...req })
  }

  /**
   * Wait for a message matching `predicate`. If the message has already arrived
   * earlier, resolves immediately.
   */
  waitFor(predicate: (m: WireMsg) => boolean, timeoutMs = 2_000): Promise<WireMsg> {
    const existing = this.received.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<WireMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock-plugin waitFor timeout')), timeoutMs)
      timer.unref()
      this.waiters.push({
        predicate,
        resolve: m => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  /** Filter received messages by type for assertions. */
  receivedOfType<T extends WireMsg['type']>(type: T): Array<Extract<WireMsg, { type: T }>> {
    return this.received.filter((m): m is Extract<WireMsg, { type: T }> => m.type === type)
  }

  async close(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.end()
      } catch {}
      this.sock = null
    }
  }

  private consumeLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    const parsed = WireSchema.safeParse(raw)
    if (!parsed.success) return
    const msg = parsed.data
    this.received.push(msg)
    // Wake any waiters whose predicate matches.
    const remaining: typeof this.waiters = []
    for (const w of this.waiters) {
      if (w.predicate(msg)) w.resolve(msg)
      else remaining.push(w)
    }
    this.waiters = remaining
  }
}
