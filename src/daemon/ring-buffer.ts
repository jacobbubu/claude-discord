/**
 * Per-workspace ring buffer of recent message exchanges.
 *
 * Architecture §14: 50 entries each, in-memory only (daemon restart drops
 * everything). Used by /recent N and the conditional auto-display on /use.
 */

const CAP = 50

const NECESSITY_THRESHOLD_MS = 15 * 60 * 1000

export type RingEntry = {
  ts: number
  channelId: string
  direction: 'in' | 'out'
  textPreview: string
}

const PREVIEW_MAX = 200

export class RingBuffer {
  private buf: RingEntry[] = []

  push(e: { ts?: number; channelId: string; direction: 'in' | 'out'; text: string }): void {
    const entry: RingEntry = {
      ts: e.ts ?? Date.now(),
      channelId: e.channelId,
      direction: e.direction,
      textPreview: e.text.length > PREVIEW_MAX ? e.text.slice(0, PREVIEW_MAX) + '…' : e.text,
    }
    this.buf.push(entry)
    if (this.buf.length > CAP) this.buf.shift()
  }

  recent(n: number): RingEntry[] {
    if (n <= 0) return []
    return this.buf.slice(-n)
  }

  isEmpty(): boolean {
    return this.buf.length === 0
  }

  lastActivity(): number {
    return this.buf.at(-1)?.ts ?? 0
  }

  lastChannel(): string | null {
    return this.buf.at(-1)?.channelId ?? null
  }

  clear(): void {
    this.buf = []
  }

  get size(): number {
    return this.buf.length
  }
}

/**
 * Decide whether `/use foo` should display the recent context automatically.
 * See architecture §14.2 / FR-8.3.
 */
export function shouldAutoDisplay(
  buf: RingBuffer,
  currentChannelId: string,
  now: number = Date.now(),
): boolean {
  if (buf.isEmpty()) return false
  if (now - buf.lastActivity() < NECESSITY_THRESHOLD_MS) return false
  if (buf.lastChannel() === currentChannelId) return false
  return true
}

/**
 * Map of workspace name → RingBuffer. Owned by the daemon.
 */
export class RingBufferMap {
  private map = new Map<string, RingBuffer>()

  for(workspace: string): RingBuffer {
    let b = this.map.get(workspace)
    if (!b) {
      b = new RingBuffer()
      this.map.set(workspace, b)
    }
    return b
  }

  get(workspace: string): RingBuffer | undefined {
    return this.map.get(workspace)
  }

  delete(workspace: string): void {
    this.map.delete(workspace)
  }

  get size(): number {
    return this.map.size
  }
}
