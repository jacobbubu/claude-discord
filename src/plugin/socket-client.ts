/**
 * Plugin-side Unix socket client. Speaks NDJSON to daemon.
 *
 * Lifecycle:
 *   - connect() establishes connection, sends register, waits for ack
 *   - on data: emits parsed messages via onMessage callback
 *   - on close: emits via onClose, caller (reconnect.ts) re-invokes connect
 */

import { connect as netConnect, type Socket } from 'node:net'
import { LineBuffer } from '../protocol/ndjson.ts'
import { encode } from '../protocol/ndjson.ts'
import { WireSchema, type WireMsg } from '../protocol/schema.ts'

export type SocketClientHandlers = {
  onMessage: (msg: WireMsg) => void
  onError: (err: Error) => void
  onClose: () => void
}

export class SocketClient {
  private sock: Socket | null = null
  private buf = new LineBuffer()

  constructor(
    private readonly path: string,
    private readonly handlers: SocketClientHandlers,
  ) {}

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = netConnect(this.path)
      sock.setEncoding('utf8')

      const onErr = (err: Error) => {
        sock.removeAllListeners('connect')
        reject(err)
        this.handlers.onError(err)
      }

      sock.once('error', onErr)
      sock.once('connect', () => {
        sock.removeListener('error', onErr)
        sock.on('error', err => this.handlers.onError(err))
        sock.on('data', chunk => {
          for (const line of this.buf.push(chunk as unknown as string)) {
            this.consumeLine(line)
          }
        })
        sock.on('close', () => {
          this.sock = null
          this.handlers.onClose()
        })
        this.sock = sock
        resolve()
      })
    })
  }

  send(msg: WireMsg): void {
    if (!this.sock) throw new Error('socket not connected')
    this.sock.write(encode(msg))
  }

  close(): void {
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
      this.handlers.onError(new Error(`bad JSON line: ${line.slice(0, 100)}`))
      return
    }
    const parsed = WireSchema.safeParse(raw)
    if (!parsed.success) {
      this.handlers.onError(
        new Error(`schema reject: ${parsed.error.issues[0]?.message ?? 'unknown'}`),
      )
      return
    }
    this.handlers.onMessage(parsed.data)
  }
}
