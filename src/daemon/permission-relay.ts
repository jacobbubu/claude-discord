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
  /** Track the messages we've sent so we can edit them (See more / §27 giveup). */
  messageRefs: { userId: string; channelId: string; messageId: string }[]
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
    // chat instead of fan-out. Find the workspace conn by cwd, then read its
    // lastInboundChatId (set by inbound-router).
    const wsConn = msg.cwd ? this.registry.list().find(c => c.cwd === msg.cwd) ?? null : null

    // Architecture deltas §27: if that workspace hasn't seen a Discord inbound
    // recently, the user is plausibly at the terminal — don't route the button
    // DM to a channel they aren't watching; tell the hook to use CC's TUI.
    // (Only applies when we actually matched a workspace conn; an unmatched
    //  cwd keeps the old fan-out behavior.)
    // §35 supersedes the TTL check with a turn lifecycle (idle / active /
    // sunset). Only routes to Discord while CC is in a Discord-driven turn.
    if (wsConn && !wsConn.isInTurn()) {
      log.info(`cc_permission_request ${msg.request_id}: workspace ${wsConn.workspace} not in a Discord turn — deferring to CC TUI`)
      try {
        conn.send({ type: 'cc_permission_defer', v: PROTOCOL_VERSION, request_id: msg.request_id })
      } catch (e) {
        log.warn(`cc_permission_request ${msg.request_id}: defer write failed: ${e}`)
      }
      return
    }

    // Architecture deltas §36: user requested cancel for this turn — short-
    // circuit the permission flow with a deny + reason. No Discord round-trip,
    // no pending pool entry. Flag stays set so subsequent tool attempts in the
    // same turn also get denied (until reply / Stop hook clears it).
    if (wsConn && wsConn.cancelPending) {
      log.info(`cc_permission_request ${msg.request_id}: workspace ${wsConn.workspace} cancelPending — denying`)
      try {
        conn.send({
          type: 'permission',
          v: PROTOCOL_VERSION,
          request_id: msg.request_id,
          behavior: 'deny',
          reason:
            '用户已在 Discord 取消本回合。立刻停止当前工作，调一次 plugin:claude-discord:reply 发"已取消"，然后结束 turn。不要再调任何其他 tool。',
        })
      } catch (e) {
        log.warn(`cc_permission_request ${msg.request_id}: cancel deny write failed: ${e}`)
      }
      return
    }

    const sourceChatId = wsConn?.lastInboundChatId ?? null
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

    // Architecture deltas §27: a hook conn closes when the hook process exits
    // — either because it got our answer (pending already claimed → no-op
    // below) or because it timed out / was killed before any answer (pending
    // still present → mark the buttons stale so the user isn't left clicking
    // a dead control while CC's TUI now owns the prompt).
    if (target.kind === 'hook') {
      target.conn.socket.once('close', () => this.handleHookGiveup(request_id))
    }

    const prefix = source === 'cc-builtin' ? '🔐 CC tool' : '🔐 Permission'
    const summary = description.split('\n', 1)[0]?.trim() || ''
    const text = summary
      ? `${prefix}: ${tool_name}\n${summary}`
      : `${prefix}: ${tool_name}`
    // Architecture deltas §20: "Allow always" persists tool to settings.json
    // permissions.allow → CC bypasses subsequent calls. Only for cc-builtin
    // (plugin tools have their own pre-allowlist flow).
    const buttons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId(`perm:more:${request_id}`)
        .setLabel('See more')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`perm:allow:${request_id}`)
        .setLabel('Allow')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
    ]
    if (source === 'cc-builtin') {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`perm:always:${request_id}`)
          .setLabel('Allow always')
          .setEmoji('🔓')
          .setStyle(ButtonStyle.Success),
      )
    }
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`perm:deny:${request_id}`)
        .setLabel('Deny')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    )
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)

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
            ch as { send: (o: { content: string; components: unknown[] }) => Promise<{ id: string; channelId: string }> }
          ).send({ content: text, components: [row] })
          entry.messageRefs.push({ userId: '<source-chat>', channelId: sourceChatId, messageId: sent.id })
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
          entry.messageRefs.push({ userId, channelId: sent.channelId, messageId: sent.id })
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
    const m = /^perm:(allow|deny|more|always):([a-km-z]{5})$/.exec(interaction.customId)
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
    // §20: 'always' = allow this call AND persist tool_name to settings.json
    // permissions.allow so CC bypasses subsequent calls.
    const effectiveBehavior: 'allow' | 'deny' =
      behavior === 'always' ? 'allow' : (behavior as 'allow' | 'deny')
    this.dispatchToTarget(claimed.target, requestId!, effectiveBehavior)

    let label = effectiveBehavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    if (behavior === 'always') {
      // §34: tighten to a derived pattern (e.g. Bash(git:*)) when possible
      // so we don't auto-allow every future invocation of catch-all tools.
      const rule = deriveAllowRule(claimed.tool_name, claimed.input_preview)
      const ok = persistAllowRule(rule)
      label = ok
        ? `✅ Allowed always (\`${rule}\` added to settings.json)`
        : `✅ Allowed (settings.json write failed; this call only)`
    }
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
   * Architecture deltas §27: the hook conn that opened `requestId` closed. If
   * the request is still pending, the hook gave up (timed out) or died before
   * an answer — drop it and edit the button message(s) so a late click gets a
   * clear "this is dead now" instead of a confusing fake "✅ Allowed".
   * If the request was already claimed (button clicked → hook exited normally
   * after receiving the answer), there's nothing to do.
   */
  private handleHookGiveup(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    log.info(`permission ${requestId}: hook conn closed before answer — marking buttons stale`)
    void this.editAllRefs(entry, '⌛ No longer active — answer in the terminal.')
  }

  /** Append a status line to every button message we sent and strip the buttons. */
  private async editAllRefs(entry: Pending, label: string): Promise<void> {
    for (const ref of entry.messageRefs) {
      try {
        const ch = await this.gateway.client.channels.fetch(ref.channelId)
        const msgs = (ch as { messages?: { fetch?: (id: string) => Promise<unknown> } } | null)?.messages
        if (!msgs || typeof msgs.fetch !== 'function') continue
        const m = (await msgs.fetch(ref.messageId)) as {
          content: string
          edit: (o: { content: string; components: unknown[] }) => Promise<unknown>
        }
        await m.edit({ content: `${m.content}\n\n${label}`, components: [] })
      } catch {
        // message or channel gone, missing perms, etc — best-effort only
      }
    }
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

/**
 * §34 / §20.1: derive a finer-grained permission rule from the tool input,
 * to be written into `~/.claude/settings.json` `permissions.allow` on the
 * "Allow always" click. Beats §20's bare-tool-name approach which would
 * auto-allow *every* future invocation of e.g. Bash (including `rm -rf`).
 *
 * Strategy (conservative — when in doubt, fall back to the bare name so
 * we never widen beyond §20's existing behavior):
 *   - Bash: take command's first whitespace-delimited word → `Bash(<word>:*)`
 *   - Edit / Write / MultiEdit / NotebookEdit: use the file path → `Tool(<path>)`
 *   - everything else (or unparseable input_preview): bare `<tool_name>`
 *
 * Pure for unit-testability.
 */
export function deriveAllowRule(toolName: string, inputPreview: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(inputPreview)
  } catch {
    return toolName
  }
  if (typeof parsed !== 'object' || parsed === null) return toolName
  const input = parsed as Record<string, unknown>

  if (toolName === 'Bash') {
    const cmd = input.command
    if (typeof cmd !== 'string') return toolName
    const first = cmd.trim().split(/\s+/, 1)[0]
    if (!first) return toolName
    return `Bash(${first}:*)`
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const p = input.file_path
    if (typeof p !== 'string' || p.length === 0) return toolName
    return `${toolName}(${p})`
  }
  if (toolName === 'NotebookEdit') {
    const p = input.notebook_path
    if (typeof p !== 'string' || p.length === 0) return toolName
    return `NotebookEdit(${p})`
  }
  return toolName
}

/**
 * §20: append a rule string to ~/.claude/settings.json `permissions.allow`.
 * §34: the input is now usually a derived pattern (e.g. `Bash(git:*)`) rather
 * than a bare tool name; the function itself just appends any string.
 * Idempotent (no duplicate entries). Returns true on successful write.
 *
 * Tests can pass an explicit path; production callers omit it (defaults
 * to the user-level settings.json).
 */
export function persistAllowRule(toolName: string, settingsPath?: string): boolean {
  try {
    const home = process.env.HOME ?? ''
    const path = settingsPath ?? `${home}/.claude/settings.json`
    if (!path || path === '/.claude/settings.json') return false
    const fs = require('node:fs') as typeof import('node:fs')
    let data: Record<string, unknown> = {}
    if (fs.existsSync(path)) {
      try {
        data = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        return false
      }
    }
    const perms = (data.permissions ??= {} as Record<string, unknown>) as Record<string, unknown>
    const allow = (perms.allow ??= [] as string[]) as string[]
    if (!allow.includes(toolName)) {
      allow.push(toolName)
    }
    fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
    return true
  } catch (e) {
    log.warn(`persistAllowRule(${toolName}) failed: ${e}`)
    return false
  }
}
