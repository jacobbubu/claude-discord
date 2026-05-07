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
}

export const PERMISSION_TEXT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export class PermissionRelay {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly registry: WorkspaceRegistry,
    private readonly paths: Paths,
  ) {}

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
    }
    this.pending.set(msg.request_id, entry)

    const text = `🔐 Permission: ${msg.tool_name}\n\nrequest_id: \`${msg.request_id}\` — reply with \`yes ${msg.request_id}\` or \`no ${msg.request_id}\` if buttons aren't available.`
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
    const entry = this.pending.get(requestId!)
    if (!entry) {
      await interaction
        .reply({ content: 'This permission request is no longer pending.', ephemeral: true })
        .catch(() => {})
      return true
    }

    if (behavior === 'more') {
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
        `input_preview:\n\`\`\`json\n${prettyInput}\n\`\`\``
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

    // allow / deny
    this.finalize(requestId!, behavior as 'allow' | 'deny', entry)
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await interaction
      .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
      .catch(() => {})
    return true
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

    const entry = this.pending.get(requestId)
    if (!entry) return false // pending may have expired or been answered already

    this.finalize(requestId, behavior, entry)
    return true
  }

  private finalize(requestId: string, behavior: 'allow' | 'deny', entry: Pending): void {
    this.pending.delete(requestId)
    this.dispatchToPlugin(entry.workspace, requestId, behavior)
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
