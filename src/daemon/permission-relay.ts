/**
 * CC permission Q&A relay — bridges Claude Code's `permission_request` to
 * Discord buttons + text replies, and routes the user's decision back.
 *
 * Wire flow:
 *   CC → plugin (MCP notification 'notifications/claude/channel/permission_request')
 *   plugin → daemon (NDJSON 'permission_request')
 *   daemon → Discord DMs of allowFrom users (button message)
 *   user clicks Allow / Deny / See more (interactionCreate)
 *   user types `yes XXXXX` / `no XXXXX` (intercepted in inbound-router)
 *   daemon → plugin (NDJSON 'permission' { behavior })
 *   plugin → CC (MCP notification 'notifications/claude/channel/permission')
 *
 * Architecture §16.1 / Epic F.7-F.11. Matches upstream's `claude/channel/permission`
 * semantics: 5-letter [a-km-z] request_id, button + text dual-channel response,
 * only allowFrom users participate (guild channels excluded by design).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from 'discord.js'
import { readAccessFile } from './access-control.ts'
import type { DiscordGateway } from './discord-gateway.ts'
import type { WorkspaceRegistry } from './registry.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import type { PermissionMsg, PermissionRequestMsg } from '../protocol/schema.ts'
import { log } from '../shared/logger.ts'
import type { Paths } from '../shared/paths.ts'

type Pending = {
  workspace: string
  tool_name: string
  description: string
  input_preview: string
  /** Track the messages we've sent so "See more" can edit them. */
  messageRefs: { userId: string; messageId: string }[]
  /** Unix ms after which this entry is considered stale and dispatch denied. */
  expiresAt: number
}

const PENDING_TTL_MS = 60 * 60 * 1000 // 1h
const PRUNE_INTERVAL_MS = 5 * 60 * 1000 // 5min

export const PERMISSION_TEXT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export class PermissionRelay {
  private pending = new Map<string, Pending>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly registry: WorkspaceRegistry,
    private readonly paths: Paths,
  ) {
    // EC-1 (docs/reviews/code-review-mvp.md): periodically expire stale
    // pending entries so memory doesn't grow unbounded when users never
    // respond. Each expired entry is denied so CC isn't left hanging.
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS)
    this.pruneTimer.unref()
  }

  /** Stop the prune timer (used on daemon shutdown). */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [requestId, entry] of this.pending) {
      if (entry.expiresAt < now) {
        this.pending.delete(requestId)
        log.warn(`permission ${requestId} expired (no response in ${PENDING_TTL_MS / 60_000}min) — auto-denying`)
        this.dispatchToPlugin(entry.workspace, requestId, 'deny')
      }
    }
  }

  /**
   * A plugin's `permission_request` arrived. Store it, send button DMs.
   */
  async handlePluginRequest(workspace: string, msg: PermissionRequestMsg): Promise<void> {
    const access = readAccessFile(this.paths.accessFile)
    if (access.allowFrom.length === 0) {
      log.warn(
        `permission_request ${msg.request_id}: no allowFrom users — denying immediately`,
      )
      this.dispatchToPlugin(workspace, msg.request_id, 'deny')
      return
    }

    const entry: Pending = {
      workspace,
      tool_name: msg.tool_name,
      description: msg.description,
      input_preview: msg.input_preview,
      messageRefs: [],
      expiresAt: Date.now() + PENDING_TTL_MS,
    }
    this.pending.set(msg.request_id, entry)

    // Main prompt is intentionally minimal — tool name + a one-line summary.
    // The request_id and `yes/no XXXXX` text fallback are folded into the
    // "See more" expansion (handleButton 'more' branch) so they only surface
    // when the user explicitly wants the technical detail or buttons fail.
    const summary = msg.description.split('\n', 1)[0]?.trim() || ''
    const text = summary
      ? `🔐 Permission: ${msg.tool_name}\n${summary}`
      : `🔐 Permission: ${msg.tool_name}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm:more:${msg.request_id}`)
        .setLabel('See more')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`perm:allow:${msg.request_id}`)
        .setLabel('Allow')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm:deny:${msg.request_id}`)
        .setLabel('Deny')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    )

    for (const userId of access.allowFrom) {
      try {
        const user = await this.gateway.client.users.fetch(userId)
        const sent = await user.send({ content: text, components: [row] })
        entry.messageRefs.push({ userId, messageId: sent.id })
      } catch (e) {
        log.warn(`permission_request: send to ${userId} failed: ${e}`)
      }
    }

    if (entry.messageRefs.length === 0) {
      log.warn(`permission_request ${msg.request_id}: failed to reach any allowFrom user — denying`)
      this.pending.delete(msg.request_id)
      this.dispatchToPlugin(workspace, msg.request_id, 'deny')
    }
  }

  /**
   * `interactionCreate` handler for button clicks. Returns true if the
   * interaction was a permission button (so the slash router skips it).
   */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
    if (!m) return false

    const access = readAccessFile(this.paths.accessFile)
    if (!access.allowFrom.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
      return true
    }

    const [, behavior, requestId] = m

    if (behavior === 'more') {
      // 'more' is a non-claiming peek — don't delete pending here.
      const entry = this.pending.get(requestId!)
      if (!entry) {
        await interaction
          .reply({ content: 'This permission request is no longer pending.', ephemeral: true })
          .catch(() => {})
        return true
      }
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(entry.input_preview), null, 2)
      } catch {
        prettyInput = entry.input_preview
      }
      const expanded =
        `🔐 Permission: ${entry.tool_name}\n\n` +
        `tool_name: ${entry.tool_name}\n` +
        `description: ${entry.description}\n` +
        `input_preview:\n\`\`\`json\n${prettyInput}\n\`\`\`\n\n` +
        `_If buttons aren't available, reply with \`yes ${requestId}\` or \`no ${requestId}\`._`
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`perm:allow:${requestId}`)
          .setLabel('Allow')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm:deny:${requestId}`)
          .setLabel('Deny')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger),
      )
      await interaction.update({ content: expanded, components: [row] }).catch(() => {})
      return true
    }

    // allow / deny — atomic claim so concurrent text response can't double-dispatch.
    // (BH-1 in docs/reviews/code-review-mvp.md.)
    const claimed = this.claimPending(requestId!)
    if (!claimed) {
      await interaction
        .reply({
          content: 'This permission request was already answered (or expired).',
          ephemeral: true,
        })
        .catch(() => {})
      return true
    }
    this.dispatchToPlugin(claimed.workspace, requestId!, behavior as 'allow' | 'deny')
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await interaction
      .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
      .catch(() => {})
    return true
  }

  /**
   * Atomic get + delete. First caller wins; concurrent callers see null.
   */
  private claimPending(requestId: string): Pending | null {
    const entry = this.pending.get(requestId)
    if (!entry) return null
    this.pending.delete(requestId)
    return entry
  }

  /**
   * Text reply handler — called by inbound-router BEFORE access gate decides
   * to route the message. Returns true if the text matched a permission
   * response (caller should then drop the message rather than route it).
   */
  handleTextResponse(senderId: string, text: string): boolean {
    const m = PERMISSION_TEXT_RE.exec(text)
    if (!m) return false

    const access = readAccessFile(this.paths.accessFile)
    if (!access.allowFrom.includes(senderId)) return false

    const requestId = m[2]!.toLowerCase()
    const behavior = m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'

    // Atomic claim — concurrent button click won't see this entry. (BH-1)
    const claimed = this.claimPending(requestId)
    if (!claimed) return false // already answered (or expired)

    this.dispatchToPlugin(claimed.workspace, requestId, behavior)
    return true
  }

  private dispatchToPlugin(
    workspace: string,
    request_id: string,
    behavior: 'allow' | 'deny',
  ): void {
    const conn = this.registry.get(workspace)
    if (!conn) {
      log.warn(`permission ${request_id}: workspace ${workspace} no longer connected`)
      return
    }
    const msg: PermissionMsg = {
      type: 'permission',
      v: PROTOCOL_VERSION,
      request_id,
      behavior,
    }
    conn.send(msg)
  }
}

/**
 * Generate a 5-letter [a-km-z] request_id (matches upstream's text-format).
 */
export function makeRequestId(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return s
}
