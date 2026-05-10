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
import type { Connection } from './connection.ts'
import type { DiscordGateway } from './discord-gateway.ts'
import type { WorkspaceRegistry } from './registry.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import type {
  CcPermissionRequestMsg,
  PermissionMsg,
  PermissionRequestMsg,
} from '../protocol/schema.ts'
import { log } from '../shared/logger.ts'
import type { Paths } from '../shared/paths.ts'

/**
 * Pending permission request can target either:
 *   - a registered plugin (workspace name) — the spec's existing path
 *   - an anonymous one-shot hook conn — architecture deltas §15
 *
 * The button + text-response paths are unified; only dispatch back differs.
 */
type PendingTarget =
  | { kind: 'plugin'; workspace: string }
  | { kind: 'hook'; conn: Connection }

type Pending = {
  target: PendingTarget
  /** "plugin" or "cc-builtin" — drives DM prompt prefix and log lines. */
  source: 'plugin' | 'cc-builtin'
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
        this.dispatchToTarget(entry.target, requestId, 'deny')
      }
    }
  }

  /**
   * A plugin's `permission_request` arrived. Store it, send button DMs.
   */
  async handlePluginRequest(workspace: string, msg: PermissionRequestMsg): Promise<void> {
    return this.handleRequest(
      { kind: 'plugin', workspace },
      'plugin',
      msg.request_id,
      msg.tool_name,
      msg.description,
      msg.input_preview,
    )
  }

  /**
   * CC's `cc_permission_request` arrived from an anonymous one-shot hook
   * subprocess (architecture deltas §15). Conn is the hook's socket — daemon
   * writes the `permission` reply back on it. Hook then exits.
   */
  async handleCcRequest(conn: Connection, msg: CcPermissionRequestMsg): Promise<void> {
    // Architecture deltas §16: route the button DM to the prompt's source
    // chat instead of fan-out. Use the cwd to find the matching workspace
    // conn, then read its lastInboundChatId (set by inbound-router).
    let sourceChatId: string | null = null
    if (msg.cwd) {
      for (const c of this.registry.list()) {
        if (c.cwd === msg.cwd && c.lastInboundChatId) {
          sourceChatId = c.lastInboundChatId
          break
        }
      }
    }
    return this.handleRequest(
      { kind: 'hook', conn },
      'cc-builtin',
      msg.request_id,
      msg.tool_name,
      msg.description,
      msg.input_preview,
      sourceChatId,
    )
  }

  /**
   * Shared logic for plugin and hook requests. Only the `target` and the DM
   * prompt prefix differ.
   */
  private async handleRequest(
    target: PendingTarget,
    source: 'plugin' | 'cc-builtin',
    request_id: string,
    tool_name: string,
    description: string,
    input_preview: string,
    sourceChatId: string | null = null,
  ): Promise<void> {
    const access = readAccessFile(this.paths.accessFile)
    if (access.allowFrom.length === 0) {
      log.warn(
        `${source === 'plugin' ? 'permission_request' : 'cc_permission_request'} ${request_id}: no allowFrom users — denying immediately`,
      )
      this.dispatchToTarget(target, request_id, 'deny')
      return
    }

    const entry: Pending = {
      target,
      source,
      tool_name,
      description,
      input_preview,
      messageRefs: [],
      expiresAt: Date.now() + PENDING_TTL_MS,
    }
    this.pending.set(request_id, entry)

    const prefix = source === 'cc-builtin' ? '🔐 CC tool' : '🔐 Permission'
    const summary = description.split('\n', 1)[0]?.trim() || ''
    const text = summary
      ? `${prefix}: ${tool_name}\n${summary}`
      : `${prefix}: ${tool_name}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm:more:${request_id}`)
        .setLabel('See more')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`perm:allow:${request_id}`)
        .setLabel('Allow')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm:deny:${request_id}`)
        .setLabel('Deny')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    )

    // Architecture deltas §16: prefer sending the button to the prompt's
    // source chat (channel or DM where the inbound came from). Fall back
    // to fan-out DM to allowFrom users if source-chat send fails or no
    // sourceChatId is known (plugin path or cwd-not-matched hook path).
    let sourceChatSucceeded = false
    if (sourceChatId) {
      try {
        const ch = await this.gateway.client.channels.fetch(sourceChatId)
        if (ch && 'send' in ch && typeof (ch as { send?: unknown }).send === 'function') {
          const sent = await (
            ch as { send: (o: { content: string; components: unknown[] }) => Promise<{ id: string }> }
          ).send({ content: text, components: [row] })
          entry.messageRefs.push({ userId: '<source-chat>', messageId: sent.id })
          sourceChatSucceeded = true
        }
      } catch (e) {
        log.warn(`permission ${request_id}: source chat ${sourceChatId} send failed: ${e}; falling back to DM`)
      }
    }

    if (!sourceChatSucceeded) {
      for (const userId of access.allowFrom) {
        try {
          const user = await this.gateway.client.users.fetch(userId)
          const sent = await user.send({ content: text, components: [row] })
          entry.messageRefs.push({ userId, messageId: sent.id })
        } catch (e) {
          log.warn(`permission DM to ${userId} failed: ${e}`)
        }
      }
    }

    if (entry.messageRefs.length === 0) {
      log.warn(`permission ${request_id}: failed to reach any allowFrom user — denying`)
      this.pending.delete(request_id)
      this.dispatchToTarget(target, request_id, 'deny')
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
      const expandedPrefix = entry.source === 'cc-builtin' ? '🔐 CC tool' : '🔐 Permission'
      const expanded =
        `${expandedPrefix}: ${entry.tool_name}\n\n` +
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
    this.dispatchToTarget(claimed.target, requestId!, behavior as 'allow' | 'deny')
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

    this.dispatchToTarget(claimed.target, requestId, behavior)
    return true
  }

  private dispatchToTarget(
    target: PendingTarget,
    request_id: string,
    behavior: 'allow' | 'deny',
  ): void {
    const msg: PermissionMsg = {
      type: 'permission',
      v: PROTOCOL_VERSION,
      request_id,
      behavior,
    }
    if (target.kind === 'plugin') {
      const conn = this.registry.get(target.workspace)
      if (!conn) {
        log.warn(`permission ${request_id}: workspace ${target.workspace} no longer connected`)
        return
      }
      conn.send(msg)
    } else {
      // Hook target — write directly to the conn that opened the request.
      try {
        target.conn.send(msg)
      } catch (e) {
        log.warn(`permission ${request_id}: hook conn write failed: ${e}`)
      }
    }
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
