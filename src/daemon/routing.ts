/**
 * routing.json: channel id → workspace name (+ history for /last + switch time).
 *
 * Slice 3 only reads; slice 4's /use slash command will write.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
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

export class RoutingTable {
  private data: Routing = DEFAULT_ROUTING

  constructor(private readonly path: string) {
    this.reload()
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
    atomicWrite(this.path, JSON.stringify(this.data, null, 2) + '\n', 0o600)
  }

  list(): Array<{ channelId: string } & RoutingEntry> {
    return Object.entries(this.data.channels).map(([channelId, e]) => ({ channelId, ...e }))
  }
}
