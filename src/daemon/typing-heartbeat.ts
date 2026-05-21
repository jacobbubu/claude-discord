/**
 * Architecture deltas §33: keep Discord's "claude is typing…" indicator
 * alive between an inbound and the first outbound reply, so users don't see
 * the dot vanish after 10s and think the bot died on a long CC task.
 *
 * Per-chat interval that re-issues `sendTyping()` every ~8s (Discord decay
 * is ~10s). `stop(chatId)` is called when a reply / edit_message / thread_reply
 * lands. A safety cap (5min default) auto-stops a runaway timer if CC really
 * is stuck — the indicator turning off is itself a signal to the user.
 *
 * Decoupled from DiscordGateway via a `sendTyping(chatId)` callback so tests
 * can inject a vi.fn() without standing up a mock gateway.
 */

import { log } from '../shared/logger.ts'

export type TypingHeartbeatOpts = {
  /** How often to re-issue sendTyping. Default 8000 (Discord ~10s decay). */
  intervalMs?: number
  /** Safety cap: stop & warn after this much wall time. Default 5min. */
  maxMs?: number
  /** §55 (issue #136): called with the chatId when the safety cap trips.
   *  The daemon wires this to ErrorNotifier so the user gets an explicit
   *  in-channel "CC may be stuck" notice instead of just a vanished dot. */
  onStuck?: (chatId: string) => void
}

type Entry = {
  interval: ReturnType<typeof setInterval>
  deadline: ReturnType<typeof setTimeout>
  /** Workspace that owns this chat's reply turn — used by stopByWorkspace
   *  so a plugin disconnect / workspace eviction can clean up its heartbeats. */
  workspace?: string
}

export class TypingHeartbeat {
  private readonly intervalMs: number
  private readonly maxMs: number
  private readonly onStuck?: (chatId: string) => void
  private readonly timers = new Map<string, Entry>()

  constructor(
    private readonly sendTyping: (chatId: string) => void | Promise<void>,
    opts: TypingHeartbeatOpts = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 8_000
    this.maxMs = opts.maxMs ?? 5 * 60_000
    this.onStuck = opts.onStuck
  }

  /**
   * Start (or restart) the heartbeat for a chat. Immediately fires
   * sendTyping, then re-fires every interval until `stop` is called or the
   * max-time safety cap trips. Optional `workspace` lets `stopByWorkspace`
   * clean up if that plugin disconnects mid-turn.
   */
  start(chatId: string, workspace?: string): void {
    this.stop(chatId)
    void this.fire(chatId)
    const interval = setInterval(() => void this.fire(chatId), this.intervalMs)
    ;(interval as unknown as { unref?: () => void }).unref?.()
    const deadline = setTimeout(() => {
      log.warn(
        `typing-heartbeat: max ${this.maxMs}ms reached for ${chatId}; stopping (CC may be stuck)`,
      )
      this.stop(chatId)
      // §55 (issue #136): the vanished typing dot is a weak signal — also
      // surface an explicit in-channel notice that CC stalled.
      try {
        this.onStuck?.(chatId)
      } catch (e) {
        log.warn(`typing-heartbeat: onStuck(${chatId}) threw: ${e}`)
      }
    }, this.maxMs)
    ;(deadline as unknown as { unref?: () => void }).unref?.()
    this.timers.set(chatId, { interval, deadline, workspace })
  }

  /** Stop the heartbeat for a chat (idempotent). */
  stop(chatId: string): void {
    const entry = this.timers.get(chatId)
    if (!entry) return
    clearInterval(entry.interval)
    clearTimeout(entry.deadline)
    this.timers.delete(chatId)
  }

  /**
   * Stop every heartbeat tagged with the given workspace. Daemon wires this
   * to registry-removal so a plugin disconnect doesn't leave a stale typing
   * dot up for the full 5min safety cap.
   */
  stopByWorkspace(workspace: string): void {
    for (const [chatId, entry] of [...this.timers.entries()]) {
      if (entry.workspace === workspace) this.stop(chatId)
    }
  }

  /** Stop every active timer; used on daemon shutdown. */
  stopAll(): void {
    for (const chatId of [...this.timers.keys()]) this.stop(chatId)
  }

  /** Test hook: how many timers are currently active. */
  get activeCount(): number {
    return this.timers.size
  }

  /**
   * §55b (issue #140): chatIds with an active heartbeat tagged with
   * `workspace` — i.e. channels currently awaiting a reply from that
   * workspace's CC. Used to target API-error notices at users who are
   * actually waiting (within the 5min cap; past that, §55 stuck-notice
   * already covers it).
   */
  chatIdsForWorkspace(workspace: string): string[] {
    const out: string[] = []
    for (const [chatId, entry] of this.timers) {
      if (entry.workspace === workspace) out.push(chatId)
    }
    return out
  }

  private async fire(chatId: string): Promise<void> {
    try {
      await this.sendTyping(chatId)
    } catch (e) {
      // sendTyping callback is best-effort; swallow so one transient failure
      // doesn't bring down the interval.
      log.debug(`typing-heartbeat: sendTyping(${chatId}) threw: ${e}`)
    }
  }
}
