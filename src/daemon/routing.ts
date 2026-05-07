/**
 * routing.json: channel id → workspace name (+ history for /last + switch time).
 *
 * Slice 3 only reads; slice 4's /use slash command will write.
 */

import { existsSync, readFileSync, renameSync, statSync, watch, type FSWatcher } from 'node:fs'
import { z } from 'zod'
import { atomicWrite } from '../shared/atomic-write.ts'
import { log } from '../shared/logger.ts'

const RoutingEntrySchema = z.object({
  workspace: z.string(),
  history: z.array(z.string()).default([]),
  switched_at: z.number().int(),
})

const RoutingSchema = z.object({
  version: z.literal(1),
  channels: z.record(z.string(), RoutingEntrySchema),
})

export type RoutingEntry = z.infer<typeof RoutingEntrySchema>
export type Routing = z.infer<typeof RoutingSchema>

const DEFAULT_ROUTING: Routing = { version: 1, channels: {} }

// Watch self-write echo grace window — fs.watch fires for our own atomicWrite
// too. Ignore events whose mtime is within this many ms of our last set().
const SELF_WRITE_GRACE_MS = 200

export class RoutingTable {
  private data: Routing = DEFAULT_ROUTING
  private lastSelfWriteAt = 0
  private watcher: FSWatcher | null = null

  constructor(private readonly path: string) {
    this.reload()
    this.startWatching()
  }

  /**
   * EC-2 (docs/reviews/code-review-mvp.md): watch routing.json for external
   * edits and reload on change. /use-driven writes are skipped via the
   * `lastSelfWriteAt` echo guard.
   */
  private startWatching(): void {
    try {
      this.watcher = watch(this.path, { persistent: false }, () => {
        try {
          const m = statSync(this.path).mtimeMs
          if (Math.abs(m - this.lastSelfWriteAt) < SELF_WRITE_GRACE_MS) return
        } catch {
          // file may have been moved aside (corrupt rename); reload handles it
        }
        log.debug('routing.json external change detected — reloading')
        this.reload()
      })
      this.watcher?.on('error', err => {
        log.warn(`routing.json watch error: ${err}`)
      })
    } catch (e) {
      // ENOENT during initial install is expected — first /use creates the file
      log.debug(`routing.json watch not started (file may not exist yet): ${e}`)
    }
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  reload(): void {
    if (!existsSync(this.path)) {
      this.data = { version: 1, channels: {} }
      return
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      const parsed = RoutingSchema.safeParse(raw)
      if (!parsed.success) {
        const corrupt = `${this.path}.corrupt-${Date.now()}`
        log.warn(`routing.json schema invalid; moving to ${corrupt}`)
        try {
          renameSync(this.path, corrupt)
        } catch {}
        this.data = { version: 1, channels: {} }
        return
      }
      this.data = parsed.data
    } catch (e) {
      log.warn(`routing.json parse failed: ${e}; using empty default`)
      this.data = { version: 1, channels: {} }
    }
  }

  get(channelId: string): RoutingEntry | null {
    return this.data.channels[channelId] ?? null
  }

  set(channelId: string, workspace: string, now = Date.now()): void {
    const prev = this.data.channels[channelId]
    const history = prev ? [prev.workspace, ...prev.history.filter(w => w !== prev.workspace)].slice(0, 10) : []
    this.data.channels[channelId] = {
      workspace,
      history,
      switched_at: now,
    }
    this.lastSelfWriteAt = Date.now()
    atomicWrite(this.path, JSON.stringify(this.data, null, 2) + '\n', 0o600)
    // Refresh again immediately after write so future statSync sees a fresh
    // mtime; this also handles the case where a write happened slightly
    // before our atomicWrite landed (race in fs.watch ordering).
    try {
      this.lastSelfWriteAt = statSync(this.path).mtimeMs
    } catch {}
    // Start watcher lazily if it wasn't running (file existed only after first set).
    if (!this.watcher) this.startWatching()
  }

  list(): Array<{ channelId: string } & RoutingEntry> {
    return Object.entries(this.data.channels).map(([channelId, e]) => ({ channelId, ...e }))
  }
}
