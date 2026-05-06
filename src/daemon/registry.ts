/**
 * Active workspace registry — maps workspace name → live Connection.
 *
 * Slice 2 baseline: no LRU, no soft cap. Capacity management lands in
 * Epic E (slice 5/6). The Map is JS-insertion-ordered, which the future
 * LRU code will exploit.
 */

import type { Connection } from './connection.ts'

export class WorkspaceRegistry {
  private byName = new Map<string, Connection>()

  register(name: string, conn: Connection): void {
    // Replace any existing entry for the same name (re-registration after reconnect).
    const prev = this.byName.get(name)
    if (prev && prev !== conn) prev.close()
    this.byName.set(name, conn)
  }

  unregister(name: string): void {
    this.byName.delete(name)
  }

  unregisterByConnection(conn: Connection): void {
    if (!conn.workspace) return
    const cur = this.byName.get(conn.workspace)
    if (cur === conn) this.byName.delete(conn.workspace)
  }

  get(name: string): Connection | undefined {
    return this.byName.get(name)
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  list(): Connection[] {
    return [...this.byName.values()]
  }

  get size(): number {
    return this.byName.size
  }
}
