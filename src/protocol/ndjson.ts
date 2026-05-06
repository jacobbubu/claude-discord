/**
 * NDJSON line framing helpers — daemon and plugin both read streams of
 * `\n`-delimited JSON objects.
 */

import type { WireMsg } from './schema.ts'

/**
 * Encode a message to its wire form (ends with newline).
 */
export function encode(msg: WireMsg): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Stateful line buffer. Feed bytes; pull complete lines.
 */
export class LineBuffer {
  private buf = ''

  /** Append a chunk and return all complete lines (without trailing `\n`). */
  push(chunk: string): string[] {
    this.buf += chunk
    const lines: string[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) lines.push(line)
    }
    return lines
  }

  /** Bytes still in the buffer (incomplete trailing line). */
  pending(): string {
    return this.buf
  }
}
