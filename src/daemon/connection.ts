/**
 * One Connection per plugin socket. Holds line buffer, workspace identity,
 * last-activity timestamp, and helpers to send typed messages.
 */

import type { Socket } from 'node:net'
import { encode } from '../protocol/ndjson.ts'
import type { WireMsg } from '../protocol/schema.ts'

export type ConnectionState = 'pre-register' | 'registered' | 'closed'

/**
 * Deltas §27: how long after the last Discord inbound a workspace still counts
 * as "Discord-driven". Past this, permission prompts fall back to CC's TUI and
 * tool traces are dropped (the user is plausibly at the terminal, not Discord).
 *
 * Deltas §35 supersedes this for the active vs idle decision (event-driven
 * state machine, ~30s sunset), but the constant is kept for any caller that
 * still wants the looser timestamp check.
 */
export const INBOUND_FRESHNESS_TTL_MS = 15 * 60_000

/**
 * Deltas §35: how long to keep the turn "alive" after CC's last reply-class
 * tool call. Covers §25's intent-line → tools → final-reply pattern, plus
 * chunked replies and any tail-end edits.
 */
export const TURN_SUNSET_MS = 30_000

export type TurnState = 'idle' | 'active' | 'sunset'

export class Connection {
  state: ConnectionState = 'pre-register'
  workspace: string | null = null
  agent: string | null = null
  capabilities: string[] = []
  lastActivityTs: number = Date.now()
  /** Plugin's cwd from register handshake. Used by daemon to reverse-look-up
   *  workspace by cwd for the cc_permission_request hook (deltas §16). */
  cwd: string | null = null
  /** Plugin process PID from register handshake. Used by /use and /last to
   *  let the user verify the target workspace is actually alive. */
  pid: number | null = null
  /** Last inbound message's chat_id (DM channel id or guild channel id),
   *  set by inbound-router before forwarding. Used by deltas §16 to route
   *  cc_permission_request buttons back to the prompt's source chat. */
  lastInboundChatId: string | null = null
  /** Wall-clock ms of the last inbound (deltas §27). null = never received an
   *  inbound. Used by isInboundFresh() to decide if this workspace is still
   *  "Discord-driven". */
  lastInboundTs: number | null = null
  /** Truncated preview of last inbound content — used to name the per-turn
   *  trace thread (deltas §24). Reset on each new inbound. */
  lastInboundPreview: string | null = null
  /** Deltas §24: current turn's tool-trace thread. Set lazily on first
   *  cc_tool_trace after inbound; cleared whenever a new inbound arrives so
   *  each turn gets a fresh thread. */
  activeTraceThreadId: string | null = null
  /** Deltas §35: turn lifecycle state machine — idle / active / sunset. */
  turnState: TurnState = 'idle'
  private sunsetTimer: ReturnType<typeof setTimeout> | null = null
  /** Deltas §36: user-requested cancel for the current turn. Set by /cancel
   *  slash command; checked by permission-relay so the next permission-gated
   *  tool gets denied with a reason. Cleared on startTurn (new turn = new
   *  account) and on onReplyDelivered / cc_stop (turn ended). */
  cancelPending: boolean = false

  constructor(public readonly socket: Socket) {}

  send(msg: WireMsg): void {
    if (this.state === 'closed') return
    try {
      this.socket.write(encode(msg))
    } catch {
      // socket may have been closed by peer; ignore — close handler will mark state
    }
  }

  touch(): void {
    this.lastActivityTs = Date.now()
  }

  /**
   * Deltas §27: has this workspace received a Discord inbound within `ttlMs`?
   * Never-received (lastInboundTs null) → false. Used to gate whether
   * permission prompts go to Discord vs CC's TUI, and whether tool traces are
   * forwarded.
   */
  isInboundFresh(ttlMs: number = INBOUND_FRESHNESS_TTL_MS): boolean {
    return this.lastInboundTs != null && Date.now() - this.lastInboundTs < ttlMs
  }

  // ─── Deltas §35: turn lifecycle ──────────────────────────────────────────

  /**
   * A new Discord inbound landed. Enter `active`; cancel any in-flight sunset
   * timer so a tail-of-previous-turn race doesn't drop us back to idle.
   * Also updates the §16/§24/§27 fields kept for back-compat.
   */
  startTurn(chatId: string): void {
    this.turnState = 'active'
    this.lastInboundChatId = chatId
    this.lastInboundTs = Date.now()
    if (this.sunsetTimer) {
      clearTimeout(this.sunsetTimer)
      this.sunsetTimer = null
    }
    // §36: a new turn opens a fresh account — any cancel request from a
    // previous turn that never actually fired (e.g. user clicked /cancel after
    // CC already had finished) shouldn't carry over.
    this.cancelPending = false
  }

  /**
   * CC just delivered a reply-class tool call (reply / edit_message /
   * thread_reply). Move to `sunset` and arm (or re-arm) the tail timer.
   * No-op when already idle — the caller should only invoke this for
   * workspaces that were actually mid-turn (defensive: a stray reply outside
   * any turn doesn't resurrect us).
   */
  startSunset(durationMs: number = TURN_SUNSET_MS): void {
    if (this.turnState === 'idle') return
    this.turnState = 'sunset'
    if (this.sunsetTimer) clearTimeout(this.sunsetTimer)
    this.sunsetTimer = setTimeout(() => {
      this.sunsetTimer = null
      this.turnState = 'idle'
    }, durationMs)
    ;(this.sunsetTimer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * Force-end the current turn. Used by §36 Stop hook (CC's turn actually
   * ended; no need to wait out the sunset tail) and by tests.
   */
  clearTurn(): void {
    this.turnState = 'idle'
    if (this.sunsetTimer) {
      clearTimeout(this.sunsetTimer)
      this.sunsetTimer = null
    }
    // §36: turn is over → drop any pending cancel; it's moot now.
    this.cancelPending = false
  }

  /**
   * Is this workspace currently driving a Discord turn? Used by
   * permission-relay / tool-trace to route to Discord vs defer to CC's TUI.
   * Strictly stricter than `isInboundFresh()` — covers the §35 case where
   * CC has finished replying + 30s tail.
   */
  isInTurn(): boolean {
    return this.turnState !== 'idle'
  }

  // ─── end §35 ─────────────────────────────────────────────────────────────

  close(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    // §35: clear any in-flight sunset timer so a stale fire doesn't manipulate
    // turnState after the conn is gone (the timer is unref()'d so it wouldn't
    // pin the process, but the callback still touches `this`).
    if (this.sunsetTimer) {
      clearTimeout(this.sunsetTimer)
      this.sunsetTimer = null
    }
    try {
      this.socket.end()
    } catch {}
    try {
      this.socket.destroy()
    } catch {}
  }
}
