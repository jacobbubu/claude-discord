/**
 * §54: per-channel "which workspace is this channel bound to" indicator,
 * routed by channel type.
 *
 *   Guild text channel → channel topic `[claude-discord] <workspace>`
 *                        (desktop: always shown in the header; mobile: one
 *                         tap on the channel name; rate-limited 2/10min by
 *                         Discord, rarely hit since switching is infrequent)
 *   DM channel         → pinned message (DMs have no topic; a DM is 1:1 with
 *                         the bot so there's only ever one binding anyway)
 *
 * Supersedes §53, which used a pinned message everywhere. Pinned messages
 * turned out to be near-invisible: Discord does not float them at the top of
 * the channel, you have to open the pin list, so the binding was effectively
 * hidden. Topic is "faithful" on desktop and one-tap on mobile.
 *
 * Lifecycle:
 *   bind / switch → applyWorkspaceIndicator
 *   unbind (move) → clearWorkspaceIndicator
 *   daemon start  → reconcileWorkspaceIndicators
 */

import type { Message } from 'discord.js'
import type { DiscordGateway } from './discord-gateway.ts'
import type { RoutingTable } from './routing.ts'
import { log } from '../shared/logger.ts'

/** Content prefix of the DM pinned indicator. Stable across versions so a
 * restart can re-discover its own prior pin. */
export const INDICATOR_PREFIX = 'Workspace: `'
/** Topic prefix marking a topic as ours, so we never clobber a user-set topic. */
export const TOPIC_PREFIX = '[claude-discord] '

export type WorkspaceIndicatorDeps = {
  gateway: DiscordGateway
  routing: RoutingTable
}

type AnyChannel = {
  isDMBased?: () => boolean
  topic?: string | null
  setTopic?: (topic: string | null) => Promise<unknown>
  send?: (content: string) => Promise<Message>
  messages?: {
    fetch: (id: string) => Promise<Message>
    fetchPins?: (opts?: { limit?: number }) => Promise<{ items: Array<{ message: Message }> }>
    fetchPinned?: () => Promise<Iterable<Message> & { find?: (cb: (m: Message) => boolean) => Message | undefined }>
  }
}

function renderPinnedContent(workspace: string, switchedAt: number): string {
  const ts = Math.floor(switchedAt / 1000)
  return `${INDICATOR_PREFIX}${workspace}\` · switched <t:${ts}:R>`
}

async function fetchChannel(deps: WorkspaceIndicatorDeps, channelId: string): Promise<AnyChannel | null> {
  try {
    const ch = await deps.gateway.client.channels.fetch(channelId)
    return (ch as unknown as AnyChannel) ?? null
  } catch (e) {
    log.debug(`workspace-indicator: fetch channel ${channelId} failed: ${e}`)
    return null
  }
}

// ───────────────────────── guild: channel topic ─────────────────────────

async function setTopic(channel: AnyChannel, channelId: string, workspace: string): Promise<void> {
  if (typeof channel.setTopic !== 'function') return
  try {
    await channel.setTopic(`${TOPIC_PREFIX}${workspace}`)
  } catch (e) {
    // Missing ManageChannels / rate-limit exhaustion — never block routing.
    log.debug(`workspace-indicator: setTopic ${channelId} failed: ${e}`)
  }
}

async function clearTopicIfOurs(channel: AnyChannel, channelId: string): Promise<void> {
  if (typeof channel.setTopic !== 'function') return
  // Only clear a topic we set — don't wipe a topic the user wrote themselves.
  if (typeof channel.topic !== 'string' || !channel.topic.startsWith(TOPIC_PREFIX)) return
  try {
    await channel.setTopic(null)
  } catch (e) {
    log.debug(`workspace-indicator: clearTopic ${channelId} failed: ${e}`)
  }
}

// ───────────────────────── DM: pinned message ───────────────────────────

/** Find a prior bot-authored indicator among the channel's pins. Uses the
 * current `fetchPins` API, falling back to the deprecated `fetchPinned`. */
async function findPinnedIndicator(
  channel: AnyChannel,
  selfId: string | undefined,
): Promise<Message | undefined> {
  const mgr = channel.messages
  if (!mgr) return undefined
  const match = (m: Message): boolean =>
    m.author?.id === selfId && typeof m.content === 'string' && m.content.startsWith(INDICATOR_PREFIX)
  if (typeof mgr.fetchPins === 'function') {
    const res = await mgr.fetchPins({ limit: 50 })
    return res.items.find(it => match(it.message))?.message
  }
  if (typeof mgr.fetchPinned === 'function') {
    const pins = await mgr.fetchPinned()
    if (typeof pins.find === 'function') return pins.find(match)
    for (const m of pins) if (match(m)) return m
  }
  return undefined
}

async function syncPinned(
  deps: WorkspaceIndicatorDeps,
  channel: AnyChannel,
  channelId: string,
  entry: { workspace: string; switched_at: number; indicator_message_id?: string },
): Promise<void> {
  if (typeof channel.send !== 'function' || !channel.messages) return
  const content = renderPinnedContent(entry.workspace, entry.switched_at)

  // 1) Edit by stored id.
  if (entry.indicator_message_id) {
    try {
      const msg = await channel.messages.fetch(entry.indicator_message_id)
      if (msg.content === content) return
      await msg.edit(content)
      return
    } catch (e) {
      log.debug(`workspace-indicator: edit pinned ${entry.indicator_message_id} failed (${e}); rescanning`)
    }
  }

  // 2) Reuse a prior pinned indicator if one survived a restart.
  try {
    const existing = await findPinnedIndicator(channel, deps.gateway.client.user?.id)
    if (existing) {
      if (existing.content !== content) {
        await existing.edit(content).catch(e =>
          log.debug(`workspace-indicator: edit reused pin ${existing.id} failed: ${e}`),
        )
      }
      deps.routing.setIndicatorMessageId(channelId, existing.id)
      return
    }
  } catch (e) {
    log.debug(`workspace-indicator: fetchPins ${channelId} failed: ${e}`)
  }

  // 3) Send + pin a fresh one.
  let sent: Message
  try {
    sent = await channel.send(content)
  } catch (e) {
    log.warn(`workspace-indicator: send pinned to ${channelId} failed: ${e}`)
    return
  }
  try {
    await (sent as Message & { pin?: () => Promise<unknown> }).pin?.()
  } catch (e) {
    // pin cap (50) or missing perms — keep the id so next sync edits in place.
    log.warn(`workspace-indicator: pin in ${channelId} failed: ${e}`)
  }
  deps.routing.setIndicatorMessageId(channelId, sent.id)
}

/** Delete a stored pinned indicator (used for DM unbind, and to clean up a
 * §53-era pin left on a guild channel). Clears the stored id. */
async function deletePinned(
  deps: WorkspaceIndicatorDeps,
  channel: AnyChannel,
  channelId: string,
  indicatorId: string,
): Promise<void> {
  if (channel.messages) {
    try {
      const msg = await channel.messages.fetch(indicatorId)
      await (msg as Message & { delete?: () => Promise<unknown> }).delete?.().catch((e: unknown) =>
        log.debug(`workspace-indicator: delete pinned ${indicatorId} failed: ${e}`),
      )
    } catch (e) {
      log.debug(`workspace-indicator: fetch pinned ${indicatorId} for delete failed: ${e}`)
    }
  }
  deps.routing.setIndicatorMessageId(channelId, null)
}

// ───────────────────────────── routers ──────────────────────────────────

/** Refresh this channel's indicator after a bind/switch. Routes by channel
 * type: DM → pinned message, guild → channel topic (cleaning up any leftover
 * §53 pin first). Best-effort; never throws. */
export async function applyWorkspaceIndicator(deps: WorkspaceIndicatorDeps, channelId: string): Promise<void> {
  const entry = deps.routing.get(channelId)
  if (!entry) return
  const channel = await fetchChannel(deps, channelId)
  if (!channel) return

  if (channel.isDMBased?.()) {
    await syncPinned(deps, channel, channelId, entry)
    return
  }
  // Guild: topic is the indicator. Remove any §53-era pinned message first.
  if (entry.indicator_message_id) await deletePinned(deps, channel, channelId, entry.indicator_message_id)
  await setTopic(channel, channelId, entry.workspace)
}

/** Tear down this channel's indicator before its routing entry is removed
 * (use-move steals the workspace to another channel). */
export async function clearWorkspaceIndicator(deps: WorkspaceIndicatorDeps, channelId: string): Promise<void> {
  const entry = deps.routing.get(channelId)
  if (!entry) return
  const channel = await fetchChannel(deps, channelId)
  if (!channel) return

  if (channel.isDMBased?.()) {
    if (entry.indicator_message_id) await deletePinned(deps, channel, channelId, entry.indicator_message_id)
    return
  }
  if (entry.indicator_message_id) await deletePinned(deps, channel, channelId, entry.indicator_message_id)
  await clearTopicIfOurs(channel, channelId)
}

/** Walk routing.json on daemon startup and bring every channel's indicator
 * into the right state (handles crashes, manual edits, and the §53→§54
 * pinned→topic migration for guild channels). */
export async function reconcileWorkspaceIndicators(deps: WorkspaceIndicatorDeps): Promise<void> {
  const entries = deps.routing.list()
  if (entries.length === 0) return
  log.info(`workspace-indicator: reconciling ${entries.length} channel(s)`)
  for (const e of entries) {
    await applyWorkspaceIndicator(deps, e.channelId).catch(err =>
      log.warn(`workspace-indicator: reconcile of ${e.channelId} failed: ${err}`),
    )
  }
}
