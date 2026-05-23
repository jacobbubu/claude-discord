/**
 * Architecture deltas §57 (issue #148): Discord-side multi-choice picker.
 *
 * `AskUserQuestion` (CC's built-in) renders its picker only in the local TUI
 * — Discord-driven turns lose the question entirely. This relay backs a new
 * MCP tool `discord_ask_question` that renders the question as a Discord
 * button message and resolves when the user clicks. Same shape as
 * permission-relay: pending map keyed by short request id, button click
 * resolves the awaiting Promise, TTL pruning so unanswered requests don't
 * leak forever.
 *
 * Discord cap: 25 buttons per message (5 buttons × 5 rows) — also the cap
 * AskUserQuestion uses, so the schemas align cleanly.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type DMChannel,
  type TextChannel,
} from 'discord.js'
import type { DiscordGateway } from './discord-gateway.ts'
import { log } from '../shared/logger.ts'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 min
const PRUNE_INTERVAL_MS = 5 * 60 * 1000 // 5 min
const MAX_OPTIONS = 25 // Discord cap (5 × 5)
const BUTTON_LABEL_MAX = 80 // Discord cap on button label length
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_LEN = 8

export type AskQuestionOption = {
  /** Short label shown on the button (truncated to 80 chars). */
  label: string
  /** Optional longer description shown alongside the buttons in the embed. */
  description?: string
}

export type AskQuestionResult =
  | { ok: true; index: number; label: string }
  | { ok: false; error: string }

type Pending = {
  resolve: (r: AskQuestionResult) => void
  expiresAt: number
  options: AskQuestionOption[]
  channelId: string
  messageId: string
}

export type AskQuestionRelayOpts = {
  /** Max wait time before auto-resolving with a timeout error. Default 30 min. */
  timeoutMs?: number
}

function randomId(): string {
  let s = ''
  for (let i = 0; i < ID_LEN; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  }
  return s
}

function trimLabel(s: string): string {
  if (s.length <= BUTTON_LABEL_MAX) return s
  return s.slice(0, BUTTON_LABEL_MAX - 1) + '…'
}

export class AskQuestionRelay {
  private readonly pending = new Map<string, Pending>()
  private readonly defaultTimeoutMs: number
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly gateway: DiscordGateway,
    opts: AskQuestionRelayOpts = {},
  ) {
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS)
    ;(this.pruneTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** Stop the prune timer; resolve any outstanding pending with cancellation
   *  so awaiting tool calls don't hang the daemon's shutdown. */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    for (const [id, p] of this.pending) {
      p.resolve({ ok: false, error: 'daemon shutting down' })
      this.pending.delete(id)
    }
  }

  /** Test hook: how many outstanding questions are awaiting a click. */
  get pendingCount(): number {
    return this.pending.size
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, p] of this.pending) {
      if (p.expiresAt < now) {
        this.pending.delete(id)
        log.warn(`ask-question ${id} expired — auto-resolving as timeout`)
        p.resolve({ ok: false, error: 'timed out waiting for user choice' })
      }
    }
  }

  /**
   * Send a question + per-option buttons to `channelId`. Returns a promise
   * that resolves when a user clicks (or rejects via `{ok:false}` on timeout
   * / send failure / shutdown).
   */
  async ask(
    channelId: string,
    question: string,
    options: AskQuestionOption[],
    opts: { header?: string; timeoutMs?: number } = {},
  ): Promise<AskQuestionResult> {
    if (options.length < 2) return { ok: false, error: 'need at least 2 options' }
    if (options.length > MAX_OPTIONS) {
      return { ok: false, error: `too many options (max ${MAX_OPTIONS}, got ${options.length})` }
    }

    let ch
    try {
      ch = await this.gateway.client.channels.fetch(channelId)
    } catch (e) {
      return { ok: false, error: `channel ${channelId} not fetchable: ${e}` }
    }
    if (!ch || !ch.isTextBased() || !('send' in ch)) {
      return { ok: false, error: `channel ${channelId} not text-based` }
    }

    const id = this.uniqueId()

    // Embed body — question + numbered option list with descriptions.
    const lines: string[] = []
    options.forEach((o, i) => {
      lines.push(`**${i + 1}.** ${o.label}${o.description ? ` — ${o.description}` : ''}`)
    })
    const embed = new EmbedBuilder()
      .setTitle(opts.header ?? '请选择')
      .setDescription(`${question}\n\n${lines.join('\n')}`)

    // Buttons — up to 5 per row, customId `aq:<id>:<index>`.
    const rows: ActionRowBuilder<ButtonBuilder>[] = []
    for (let i = 0; i < options.length; i++) {
      if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>())
      rows[rows.length - 1]!.addComponents(
        new ButtonBuilder()
          .setCustomId(`aq:${id}:${i}`)
          .setLabel(trimLabel(`${i + 1}. ${options[i]!.label}`))
          .setStyle(ButtonStyle.Secondary),
      )
    }

    let sent
    try {
      sent = await (ch as TextChannel | DMChannel).send({ embeds: [embed], components: rows })
    } catch (e) {
      return { ok: false, error: `send failed: ${e}` }
    }

    return new Promise<AskQuestionResult>(resolve => {
      this.pending.set(id, {
        resolve,
        expiresAt: Date.now() + (opts.timeoutMs ?? this.defaultTimeoutMs),
        options,
        channelId,
        messageId: sent.id,
      })
    })
  }

  /**
   * Consume a button interaction if it belongs to one of our pending
   * questions. Returns true iff handled — caller chains us with other
   * button-handlers via `buttonIntercept`.
   */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const m = /^aq:([a-z0-9]+):(\d+)$/.exec(interaction.customId)
    if (!m) return false
    const id = m[1]!
    const idx = Number(m[2])

    const pending = this.pending.get(id)
    if (!pending) {
      // Expired / already handled / unknown — politely tell the clicker.
      await interaction
        .reply({ content: '⚠️ 这个问题已经过期或被处理过。', ephemeral: true })
        .catch(() => {})
      return true
    }
    if (idx < 0 || idx >= pending.options.length) {
      await interaction
        .reply({ content: '⚠️ 选项越界。', ephemeral: true })
        .catch(() => {})
      return true
    }

    this.pending.delete(id)
    const chosen = pending.options[idx]!
    // Edit the original message: drop the buttons (so the question can't be
    // re-clicked) and record who chose what.
    await interaction
      .update({
        content: `选择: **${idx + 1}. ${chosen.label}** — by <@${interaction.user.id}>`,
        components: [],
      })
      .catch(e => log.warn(`ask-question ${id}: update message failed: ${e}`))

    pending.resolve({ ok: true, index: idx, label: chosen.label })
    return true
  }

  private uniqueId(): string {
    // 36^8 = ~2.8e12 — collision in a small pending map is astronomically
    // unlikely, but loop a few times to be safe and fall back to a time tail.
    for (let i = 0; i < 10; i++) {
      const id = randomId()
      if (!this.pending.has(id)) return id
    }
    return randomId() + Date.now().toString(36)
  }
}
