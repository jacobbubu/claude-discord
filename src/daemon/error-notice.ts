/**
 * Architecture deltas §55 (issue #136): surface turn failures into the
 * source Discord channel so the user isn't left guessing when only the
 * daemon log has the reason.
 *
 * Covers the failures the daemon can directly observe:
 *   - typing-heartbeat hitting its 5min safety cap (CC stuck / rate-limited)
 *   - `reply` tool file-access errors (path / size / not sendable)
 *   - `reply` tool send failures (429 retry-exhausted, network, ...)
 *
 * NOT covered: an Anthropic API 429 that hits Claude Code *before* it calls
 * into this plugin — the daemon never sees it. That needs the CC
 * Notification hook; tracked separately in issue #137.
 *
 * A per-channel throttle keeps an error storm (e.g. CC retrying a doomed
 * `reply` in a loop) from spamming the channel.
 *
 * Decoupled from DiscordGateway via a `send` callback (same pattern as
 * TypingHeartbeat) so tests can inject a vi.fn() without a mock gateway.
 */

import { log } from '../shared/logger.ts'

/** Min wall time between error notices posted to the same channel. */
const DEFAULT_THROTTLE_MS = 60_000

/** Detail strings are truncated to this before being appended to a notice —
 *  a Discord error message shouldn't dump a wall of text on the user. */
const DETAIL_MAX = 300

export type ErrorNoticeKind = 'stuck' | 'file' | 'send'

const PREFIX: Record<ErrorNoticeKind, string> = {
  stuck: '⚠️ 已经 5 分钟没有收到 Claude Code 的回复，可能卡住或被限流了。',
  file: '⚠️ 回复中的文件处理失败，消息没能发出',
  send: '⚠️ 回复发送失败',
}

export type ErrorNotifierOpts = {
  /** Min ms between notices to the same channel. Default 60s. */
  throttleMs?: number
}

export class ErrorNotifier {
  private readonly throttleMs: number
  private readonly lastSent = new Map<string, number>()

  constructor(
    private readonly send: (channelId: string, content: string) => Promise<{ id: string } | null>,
    opts: ErrorNotifierOpts = {},
  ) {
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS
  }

  /**
   * Post a short ⚠️ notice to `channelId`. For `file` / `send` kinds the
   * `detail` (truncated) is appended after the standard prefix; `stuck`
   * ignores `detail`. No-op if a notice was posted to this channel within
   * the throttle window. Never throws — error reporting must not itself
   * fail the caller's path.
   */
  async notify(channelId: string, kind: ErrorNoticeKind, detail?: string): Promise<void> {
    const now = Date.now()
    const prev = this.lastSent.get(channelId)
    if (prev != null && now - prev < this.throttleMs) {
      log.debug(`error-notice: throttled ${kind} for ${channelId}`)
      return
    }
    // Optimistic: claim the throttle slot before the async send so a burst
    // (CC retrying a doomed reply) collapses to one notice even if sends race.
    this.lastSent.set(channelId, now)

    let content = PREFIX[kind]
    if (kind !== 'stuck' && detail) {
      const trimmed = detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail
      content += `：${trimmed}`
    }

    try {
      await this.send(channelId, content)
    } catch (e) {
      log.warn(`error-notice: posting ${kind} notice to ${channelId} failed: ${e}`)
    }
  }
}
