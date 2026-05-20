/**
 * §53: per-channel pinned message showing the current workspace binding.
 *
 * Replaces both the bot's global presence (which can only show one workspace
 * at a time across all channels) and the channel topic (limited to guild
 * text channels, hidden in Discord mobile, and rate-limited at 2/10min per
 * channel by Discord).
 *
 * Lifecycle:
 *   - bind / switch → syncIndicator: edit existing pinned msg, or send+pin a new one
 *   - unbind         → unpinIndicator: delete the message, clear stored id
 *   - daemon start   → reconcileIndicators: walk routing.json once, fix drift
 *
 * On switch we edit the *same* message id rather than re-sending so the
 * indicator stays near the top of the pins list and channel notifications
 * don't spam users with "Workspace switched" messages.
 */

import type { Message, TextBasedChannel } from 'discord.js'
import type { DiscordGateway } from './discord-gateway.ts'
import type { RoutingTable } from './routing.ts'
import { log } from '../shared/logger.ts'

/**
 * Stable content prefix so daemon-restart reconcile can find a previously
 * pinned indicator even when we lost the stored message id (routing.json
 * deleted, old daemon version, etc.). Keep this exact across versions.
 */
export const INDICATOR_PREFIX = 'Workspace: `'

export type PinnedIndicatorDeps = {
  gateway: DiscordGateway
  routing: RoutingTable
}

function renderContent(workspace: string, switchedAt: number): string {
  const ts = Math.floor(switchedAt / 1000)
  return `${INDICATOR_PREFIX}${workspace}\` · switched <t:${ts}:R>`
}

type WritableChannel = TextBasedChannel & {
  send: (content: string) => Promise<Message>
  messages: {
    fetch: (id: string) => Promise<Message>
    fetchPinned: () => Promise<Map<string, Message> | { find: (cb: (m: Message) => boolean) => Message | undefined }>
  }
}

async function fetchWritableChannel(
  deps: PinnedIndicatorDeps,
  channelId: string,
): Promise<WritableChannel | null> {
  try {
    const ch = await deps.gateway.client.channels.fetch(channelId)
    if (!ch || !ch.isTextBased?.() || !('messages' in ch) || !('send' in ch)) return null
    return ch as unknown as WritableChannel
  } catch (e) {
    log.debug(`pinned-indicator: fetch channel ${channelId} failed: ${e}`)
    return null
  }
}

/**
 * Edit the existing indicator or create+pin a new one. Idempotent.
 *
 * Order of attempts:
 *   1. stored id → fetch + edit
 *   2. scan pins for our prior indicator (author=self, prefix match) → reuse
 *   3. send a fresh message + pin it
 *
 * Failures at any step are logged at debug/warn and never thrown — workspace
 * routing must succeed even when Discord pin/permission state is broken.
 */
export async function syncIndicator(deps: PinnedIndicatorDeps, channelId: string): Promise<void> {
  const entry = deps.routing.get(channelId)
  if (!entry) return

  const channel = await fetchWritableChannel(deps, channelId)
  if (!channel) return

  const content = renderContent(entry.workspace, entry.switched_at)

  // 1) Try edit by stored id.
  if (entry.indicator_message_id) {
    try {
      const msg = await channel.messages.fetch(entry.indicator_message_id)
      if (msg.content === content) return
      await msg.edit(content)
      return
    } catch (e) {
      log.debug(
        `pinned-indicator: edit ${entry.indicator_message_id} in ${channelId} failed (${e}); falling through to scan/create`,
      )
    }
  }

  // 2) Scan current pins for our previous indicator.
  const selfId = deps.gateway.client.user?.id
  try {
    const pins = (await channel.messages.fetchPinned()) as unknown as Iterable<Message> & {
      find?: (cb: (m: Message) => boolean) => Message | undefined
    }
    const findFn = typeof pins.find === 'function'
      ? pins.find.bind(pins)
      : (cb: (m: Message) => boolean): Message | undefined => {
          for (const m of pins) if (cb(m)) return m
          return undefined
        }
    const existing = findFn(m => m.author?.id === selfId && m.content?.startsWith(INDICATOR_PREFIX))
    if (existing) {
      if (existing.content !== content) {
        await existing.edit(content).catch(e =>
          log.debug(`pinned-indicator: edit reused pin ${existing.id} failed: ${e}`),
        )
      }
      deps.routing.setIndicatorMessageId(channelId, existing.id)
      return
    }
  } catch (e) {
    log.debug(`pinned-indicator: fetchPinned for ${channelId} failed: ${e}`)
  }

  // 3) Send + pin a new message.
  let sent: Message
  try {
    sent = await channel.send(content)
  } catch (e) {
    log.warn(`pinned-indicator: send to ${channelId} failed: ${e}`)
    return
  }
  try {
    await (sent as Message & { pin?: () => Promise<unknown> }).pin?.()
  } catch (e) {
    // Pin can fail for: 50/pin cap reached, missing ManageMessages perm in
    // guild channels. Keep the id stored — next sync will edit instead of
    // re-sending, so we don't spam the channel.
    log.warn(`pinned-indicator: pin in ${channelId} failed: ${e}`)
  }
  deps.routing.setIndicatorMessageId(channelId, sent.id)
}

/**
 * Delete the indicator message and clear the stored id. Called from the
 * unbind path *before* routing.unset (we need the id from the entry).
 *
 * Best-effort: missing message / no permission are logged at debug, never
 * thrown. The routing entry will be removed regardless.
 */
export async function unpinIndicator(deps: PinnedIndicatorDeps, channelId: string): Promise<void> {
  const entry = deps.routing.get(channelId)
  if (!entry?.indicator_message_id) return

  const channel = await fetchWritableChannel(deps, channelId)
  if (channel) {
    try {
      const msg = await channel.messages.fetch(entry.indicator_message_id)
      // delete() on a pinned message unpins implicitly.
      await (msg as Message & { delete?: () => Promise<unknown> }).delete?.().catch((e: unknown) =>
        log.debug(`pinned-indicator: delete ${entry.indicator_message_id} failed: ${e}`),
      )
    } catch (e) {
      log.debug(
        `pinned-indicator: fetch ${entry.indicator_message_id} for unpin in ${channelId} failed: ${e}`,
      )
    }
  }

  deps.routing.setIndicatorMessageId(channelId, null)
}

/**
 * Walk routing.json on daemon startup and ensure every bound channel has a
 * fresh indicator. Handles: previous daemon crashed mid-bind, user manually
 * deleted the pinned message, schema upgrade from v0 → v1+indicator.
 */
export async function reconcileIndicators(deps: PinnedIndicatorDeps): Promise<void> {
  const entries = deps.routing.list()
  if (entries.length === 0) return
  log.info(`pinned-indicator: reconciling ${entries.length} channel(s)`)
  // Sequential — Discord rate limits per-channel are lenient but cross-channel
  // bursts in a fresh bot still trip global limits. Throughput here is not
  // important; correctness is.
  for (const e of entries) {
    await syncIndicator(deps, e.channelId).catch(err =>
      log.warn(`pinned-indicator: reconcile of ${e.channelId} failed: ${err}`),
    )
  }
}
