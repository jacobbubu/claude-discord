/**
 * Active workspace registry — maps workspace name → live Connection.
 *
 * Slice 6: soft-cap LRU eviction (default 50, trim to 45). Cap and trim are
 * configurable via CLAUDE_DISCORD_WORKSPACE_CAP / _TRIM_TARGET env vars.
 *
 * On eviction:
 *   - the connection's socket is closed (plugin auto-reconnects after socket close)
 *   - the registry entry is removed
 *   - the optional onEvict callback fires (daemon wires ring-buffer cleanup here)
 *
 * Eviction is silent — no Discord message, only debug-level logs. Plugin
 * reconnects transparently and re-registers under the same workspace name.
 */

import { log } from '../shared/logger.ts'
import type { Connection } from './connection.ts'

const DEFAULT_CAP = 50
const DEFAULT_TRIM = 45
const CAP_MIN = 10
const CAP_MAX = 500

export type EvictionListener = (workspace: string) => void
/** Architecture deltas §29: fires after any registry mutation (register /
 *  unregister / eviction). Used by daemon to re-register slash commands when
 *  the workspace set changes (static choices need to refresh). */
export type ChangeListener = () => void

function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    log.warn(`${name}=${raw} out of range [${min}, ${max}], using default ${fallback}`)
    return fallback
  }
  return n
}

export class WorkspaceRegistry {
  private byName = new Map<string, Connection>()
  private readonly cap: number
  private readonly trim: number
  private readonly listeners: EvictionListener[] = []
  private readonly changeListeners: ChangeListener[] = []

  constructor(opts: { cap?: number; trim?: number } = {}) {
    this.cap = opts.cap ?? readEnvInt('CLAUDE_DISCORD_WORKSPACE_CAP', DEFAULT_CAP, CAP_MIN, CAP_MAX)
    this.trim = opts.trim ?? readEnvInt(
      'CLAUDE_DISCORD_WORKSPACE_TRIM_TARGET',
      DEFAULT_TRIM,
      CAP_MIN,
      this.cap,
    )
  }

  /**
   * Subscribe to eviction events. Daemon uses this to clear ring buffers.
   * Called only for cap-driven evictions, not for normal unregister.
   */
  onEviction(fn: EvictionListener): void {
    this.listeners.push(fn)
  }

  /**
   * Architecture deltas §29: subscribe to any membership change (register /
   * unregister / eviction). Returns an unsubscribe function. Listener errors
   * are swallowed so one bad listener can't break the others.
   */
  onChange(fn: ChangeListener): () => void {
    this.changeListeners.push(fn)
    return () => {
      const i = this.changeListeners.indexOf(fn)
      if (i >= 0) this.changeListeners.splice(i, 1)
    }
  }

  private notifyChange(): void {
    for (const fn of this.changeListeners) {
      try {
        fn()
      } catch (e) {
        log.warn(`change listener error: ${e}`)
      }
    }
  }

  register(name: string, conn: Connection): void {
    // Replace any existing entry for the same name (re-registration after reconnect).
    const prev = this.byName.get(name)
    const wasNewName = prev === undefined
    if (prev && prev !== conn) prev.close()
    this.byName.set(name, conn)
    if (this.byName.size > this.cap) this.evictTo(this.trim) // notifyChange happens inside if it evicted
    // Only notify on actual membership change — reconnect re-registering the
    // same name with the same conn shouldn't churn slash registration.
    if (wasNewName || prev !== conn) this.notifyChange()
  }

  unregister(name: string): void {
    if (this.byName.delete(name)) this.notifyChange()
  }

  unregisterByConnection(conn: Connection): void {
    if (!conn.workspace) return
    const cur = this.byName.get(conn.workspace)
    if (cur === conn) {
      this.byName.delete(conn.workspace)
      this.notifyChange()
    }
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

  /**
   * For tests / introspection — current cap/trim values.
   */
  config(): { cap: number; trim: number } {
    return { cap: this.cap, trim: this.trim }
  }

  /**
   * Drop the least-recently-active connections until size <= target.
   * Each evicted connection's socket is closed (triggering plugin reconnect),
   * its name is removed from the map, and listeners fire.
   */
  private evictTo(target: number): void {
    const entries = [...this.byName.values()].sort(
      (a, b) => a.lastActivityTs - b.lastActivityTs,
    )
    const toEvict = entries.slice(0, this.byName.size - target)
    for (const conn of toEvict) {
      const name = conn.workspace
      log.debug(
        `LRU evict: workspace=${name} last_activity=${new Date(conn.lastActivityTs).toISOString()}`,
      )
      if (name) {
        this.byName.delete(name)
        for (const fn of this.listeners) {
          try {
            fn(name)
          } catch (e) {
            log.warn(`eviction listener error: ${e}`)
          }
        }
      }
      conn.close()
    }
    if (toEvict.length > 0) this.notifyChange()
  }
}
