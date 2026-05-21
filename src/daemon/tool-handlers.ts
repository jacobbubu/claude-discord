/**
 * Real implementations of the 5 MCP tools (reply / react / edit_message /
 * fetch_messages / download_attachment). Replaces the slice-2 echo stub.
 *
 * Each handler:
 *   - Looks up the target Discord channel via the gateway's discord.js client
 *   - Applies safety hygiene (assertSendable, safeAttName)
 *   - Pushes outbound activity into the ring buffer (so /recent works)
 */

import { Buffer } from 'node:buffer'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  type Channel,
  type Message,
  type MessageReplyOptions,
  type MessageCreateOptions,
} from 'discord.js'
import { readAccessFile } from './access-control.ts'
import type { DiscordGateway } from './discord-gateway.ts'
import type { ErrorNotifier } from './error-notice.ts'
import type { RingBufferMap } from './ring-buffer.ts'
import { assertSendable, safeAttName } from './safety.ts'
import type { TypingHeartbeat } from './typing-heartbeat.ts'
import { log } from '../shared/logger.ts'
import type { Paths } from '../shared/paths.ts'

const HARD_CHUNK_LIMIT = 2000
const MAX_FILES_PER_MESSAGE = 10
const MAX_FILE_BYTES = 25 * 1024 * 1024

// Discord embed limits (§32 / FR-5.4). Sum of title + description + each
// field's name + value across all embeds must be ≤ 6000.
const EMBED_TITLE_MAX = 256
const EMBED_DESC_MAX = 4096
const EMBED_FIELDS_MAX = 25
const EMBED_FIELD_NAME_MAX = 256
const EMBED_FIELD_VALUE_MAX = 1024
const EMBED_TOTAL_MAX = 6000
// §42 additional caps from Discord docs
const EMBED_AUTHOR_NAME_MAX = 256
const EMBED_FOOTER_TEXT_MAX = 2048
const MAX_EMBEDS_PER_MESSAGE = 10

/** Shape of the `embed` (or each `embeds[]` entry) the `reply` tool accepts.
 *
 * §42 extended: \`author\` / \`image\` / \`thumbnail\` / \`footer\` / \`url\` /
 * \`timestamp\` previously missing. \`image.url\` and \`thumbnail.url\` accept
 * \`attachment://<filename>\` to reference a file uploaded in the same
 * message's \`files\` array.
 */
export type ReplyEmbedInput = {
  title?: string
  description?: string
  color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  // §42
  url?: string
  timestamp?: string // ISO 8601
  author?: { name: string; icon_url?: string; url?: string }
  image?: { url: string }
  thumbnail?: { url: string }
  footer?: { text: string; icon_url?: string }
}

/** §32 / FR-5.4: validate an embed input against Discord's per-field and
 *  6000-total-char caps. Pure for unit-testability. Returns either a built
 *  EmbedBuilder + the computed char total, or a human-readable error. */
export function validateEmbed(
  input: ReplyEmbedInput,
): { ok: true; embed: EmbedBuilder; totalChars: number } | { ok: false; error: string } {
  let total = 0

  if (input.title != null) {
    if (typeof input.title !== 'string') return { ok: false, error: 'embed.title must be a string' }
    if (input.title.length > EMBED_TITLE_MAX) {
      return { ok: false, error: `embed.title > ${EMBED_TITLE_MAX} chars` }
    }
    total += input.title.length
  }

  if (input.description != null) {
    if (typeof input.description !== 'string') return { ok: false, error: 'embed.description must be a string' }
    if (input.description.length > EMBED_DESC_MAX) {
      return { ok: false, error: `embed.description > ${EMBED_DESC_MAX} chars` }
    }
    total += input.description.length
  }

  if (input.color != null) {
    if (typeof input.color !== 'number' || !Number.isInteger(input.color) || input.color < 0 || input.color > 0xffffff) {
      return { ok: false, error: 'embed.color must be an integer in [0, 0xFFFFFF]' }
    }
  }

  const fields = input.fields ?? []
  if (!Array.isArray(fields)) return { ok: false, error: 'embed.fields must be an array' }
  if (fields.length > EMBED_FIELDS_MAX) {
    return { ok: false, error: `embed.fields has ${fields.length} entries, max ${EMBED_FIELDS_MAX}` }
  }
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (typeof f.name !== 'string' || typeof f.value !== 'string') {
      return { ok: false, error: `embed.fields[${i}] requires string name + value` }
    }
    if (f.name.length === 0 || f.value.length === 0) {
      return { ok: false, error: `embed.fields[${i}] name + value must be non-empty` }
    }
    if (f.name.length > EMBED_FIELD_NAME_MAX) {
      return { ok: false, error: `embed.fields[${i}].name > ${EMBED_FIELD_NAME_MAX} chars` }
    }
    if (f.value.length > EMBED_FIELD_VALUE_MAX) {
      return { ok: false, error: `embed.fields[${i}].value > ${EMBED_FIELD_VALUE_MAX} chars` }
    }
    total += f.name.length + f.value.length
  }

  // §42: validate optional structured fields and add their char weight before
  // the 6000-total cap check, so over-budget embeds reject up-front.
  if (input.author != null) {
    if (typeof input.author !== 'object') return { ok: false, error: 'embed.author must be an object' }
    if (typeof input.author.name !== 'string' || input.author.name.length === 0) {
      return { ok: false, error: 'embed.author.name must be a non-empty string' }
    }
    if (input.author.name.length > EMBED_AUTHOR_NAME_MAX) {
      return { ok: false, error: `embed.author.name > ${EMBED_AUTHOR_NAME_MAX} chars` }
    }
    total += input.author.name.length
    if (input.author.icon_url != null && typeof input.author.icon_url !== 'string') {
      return { ok: false, error: 'embed.author.icon_url must be a string' }
    }
    if (input.author.url != null && typeof input.author.url !== 'string') {
      return { ok: false, error: 'embed.author.url must be a string' }
    }
  }

  if (input.footer != null) {
    if (typeof input.footer !== 'object') return { ok: false, error: 'embed.footer must be an object' }
    if (typeof input.footer.text !== 'string' || input.footer.text.length === 0) {
      return { ok: false, error: 'embed.footer.text must be a non-empty string' }
    }
    if (input.footer.text.length > EMBED_FOOTER_TEXT_MAX) {
      return { ok: false, error: `embed.footer.text > ${EMBED_FOOTER_TEXT_MAX} chars` }
    }
    total += input.footer.text.length
    if (input.footer.icon_url != null && typeof input.footer.icon_url !== 'string') {
      return { ok: false, error: 'embed.footer.icon_url must be a string' }
    }
  }

  if (input.image != null) {
    if (typeof input.image !== 'object' || typeof input.image.url !== 'string') {
      return { ok: false, error: 'embed.image.url must be a string' }
    }
  }
  if (input.thumbnail != null) {
    if (typeof input.thumbnail !== 'object' || typeof input.thumbnail.url !== 'string') {
      return { ok: false, error: 'embed.thumbnail.url must be a string' }
    }
  }
  if (input.url != null && typeof input.url !== 'string') {
    return { ok: false, error: 'embed.url must be a string' }
  }
  if (input.timestamp != null) {
    if (typeof input.timestamp !== 'string' || isNaN(Date.parse(input.timestamp))) {
      return { ok: false, error: 'embed.timestamp must be an ISO 8601 string' }
    }
  }

  if (total > EMBED_TOTAL_MAX) {
    return { ok: false, error: `embed total ${total} chars > ${EMBED_TOTAL_MAX}` }
  }

  const eb = new EmbedBuilder()
  if (input.title != null) eb.setTitle(input.title)
  if (input.description != null) eb.setDescription(input.description)
  if (input.color != null) eb.setColor(input.color)
  if (fields.length > 0) {
    eb.addFields(...fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })))
  }
  // §42 attachments / metadata
  if (input.url != null) eb.setURL(input.url)
  if (input.timestamp != null) eb.setTimestamp(new Date(input.timestamp))
  if (input.author != null) {
    eb.setAuthor({
      name: input.author.name,
      ...(input.author.icon_url != null ? { iconURL: input.author.icon_url } : {}),
      ...(input.author.url != null ? { url: input.author.url } : {}),
    })
  }
  if (input.footer != null) {
    eb.setFooter({
      text: input.footer.text,
      ...(input.footer.icon_url != null ? { iconURL: input.footer.icon_url } : {}),
    })
  }
  if (input.image != null) eb.setImage(input.image.url)
  if (input.thumbnail != null) eb.setThumbnail(input.thumbnail.url)
  return { ok: true, embed: eb, totalChars: total }
}

export type ToolContext = {
  gateway: DiscordGateway
  ringBuffers: RingBufferMap
  paths: Paths
  workspace: string
  /** §33: stopped on successful reply/edit_message/thread_reply so the
   *  "typing…" indicator doesn't outlive CC's response. */
  typingHeartbeat?: TypingHeartbeat
  /** §55 (issue #136): on a reply-tool file/send failure, post a short ⚠️
   *  notice to the source channel so the user sees the failure even if
   *  Claude Code doesn't relay the tool error itself. */
  errorNotifier?: ErrorNotifier
  /** §35: notified on successful reply-class tool call. Daemon wires this to
   *  the workspace conn's `startSunset()` so the turn moves from active →
   *  sunset, and after the tail timer fires → idle (defers subsequent
   *  permission/trace from CC's terminal-driven prompts to TUI). */
  onReplyDelivered?: () => void
}

export type ToolOutcome =
  | { ok: true; result: string }
  | { ok: false; error: string }

const fail = (error: string): ToolOutcome => ({ ok: false, error })

/**
 * Fetch a Discord channel + assert the daemon is allowed to send to it.
 *
 * Symmetry with the inbound gate (architecture §17.2 — patched after the
 * upstream deep-dive at docs/research/upstream-architecture-deep-dive.md
 * §3.1). Even though the inbound gate would have dropped a Discord message
 * from a non-allowlisted user, an outbound tool call could in principle
 * target *any* channel ID Claude Code knows about. This check ensures
 * Claude can only send to channels we'd accept inbound from:
 *   - DM channels: recipient must be in access.allowFrom
 *   - Guild channels: channel id (or parent if thread) must be in access.groups
 *
 * Returns null on either "not text-based" or "not in access list", with a
 * stderr warn naming the reason. Caller's generic error message is fine
 * because callers already wrap null in a tool fail() — the daemon log has
 * the real reason for ops to see.
 */
async function fetchTextChannel(ctx: ToolContext, channelId: string): Promise<Channel | null> {
  let ch: Channel | null
  try {
    ch = await ctx.gateway.client.channels.fetch(channelId)
  } catch {
    return null
  }
  if (!ch || !ch.isTextBased()) return null

  const access = readAccessFile(ctx.paths.accessFile)
  if (ch.type === ChannelType.DM) {
    const recipient =
      (ch as unknown as { recipientId?: string }).recipientId ??
      ctx.gateway.getDmRecipient(channelId)
    if (!recipient || !access.allowFrom.includes(recipient)) {
      log.warn(`outbound deny: DM channel ${channelId} → recipient ${recipient ?? '<unknown>'} not in allowFrom`)
      return null
    }
  } else {
    const key = ch.isThread() ? (ch.parentId ?? ch.id) : ch.id
    // Architecture deltas §38: outbound mirrors the inbound gate's groupPolicy
    // semantics — explicit entry in `access.groups` always passes; otherwise
    // `groupPolicy: 'open'` + `groupPolicyDefaults` set → also passes (parity
    // with inbound default after §17). Unset defaults / `disabled` → still
    // deny (back-compat).
    if (!(key in access.groups)) {
      if (access.groupPolicy === 'open' && access.groupPolicyDefaults) {
        // pass via defaults — symmetric with inbound
      } else {
        log.warn(`outbound deny: guild channel ${key} not opted-in via /discord:access group add`)
        return null
      }
    }
  }

  return ch
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut =
        para > limit / 2
          ? para
          : line > limit / 2
            ? line
            : space > 0
              ? space
              : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export async function toolReply(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const chatId = args.chat_id as string
  const text = (args.text as string | undefined) ?? ''
  const replyTo = args.reply_to as string | undefined
  const files = (args.files as string[] | undefined) ?? []
  // §42: accept either legacy `embed` (single) or `embeds` (array). Normalize
  // to a single array path so the send logic is uniform.
  const singleEmbedInput = args.embed as ReplyEmbedInput | undefined
  const arrayEmbedInput = args.embeds as ReplyEmbedInput[] | undefined

  if (typeof chatId !== 'string' || chatId.length === 0) return fail('chat_id required')
  if (files.length > MAX_FILES_PER_MESSAGE) {
    return fail(`max ${MAX_FILES_PER_MESSAGE} attachments per message`)
  }

  if (singleEmbedInput != null && arrayEmbedInput != null) {
    return fail('reply: pass either `embed` OR `embeds`, not both')
  }
  const embedInputs: ReplyEmbedInput[] = arrayEmbedInput
    ? arrayEmbedInput
    : singleEmbedInput
      ? [singleEmbedInput]
      : []
  if (embedInputs.length > MAX_EMBEDS_PER_MESSAGE) {
    return fail(`max ${MAX_EMBEDS_PER_MESSAGE} embeds per message (got ${embedInputs.length})`)
  }

  // §32 / §42: validate each embed up-front so a malformed input doesn't burn
  // a round-trip and partial send. Discord's 6000-char total cap applies
  // **across** all embeds in the message, so sum totalChars and reject early.
  const embeds: EmbedBuilder[] = []
  let combinedChars = 0
  for (let i = 0; i < embedInputs.length; i++) {
    const e = embedInputs[i]!
    if (typeof e !== 'object' || e == null) return fail(`embeds[${i}] must be an object`)
    const res = validateEmbed(e)
    if (!res.ok) return fail(`embeds[${i}]: ${res.error}`)
    embeds.push(res.embed)
    combinedChars += res.totalChars
  }
  if (combinedChars > EMBED_TOTAL_MAX) {
    return fail(
      `combined embeds total ${combinedChars} chars > ${EMBED_TOTAL_MAX} (Discord caps the sum across all embeds in one message)`,
    )
  }

  const ch = await fetchTextChannel(ctx, chatId)
  if (!ch || !('send' in ch)) return fail(`channel ${chatId} not text-based`)

  const attachments: AttachmentBuilder[] = []
  for (const f of files) {
    try {
      assertSendable(f, ctx.paths)
      const st = statSync(f)
      if (st.size > MAX_FILE_BYTES) {
        const msg = `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB)`
        void ctx.errorNotifier?.notify(chatId, 'file', msg) // §55
        return fail(msg)
      }
      attachments.push(new AttachmentBuilder(f))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      void ctx.errorNotifier?.notify(chatId, 'file', msg) // §55
      return fail(msg)
    }
  }

  const sentIds: string[] = []

  if (embeds.length > 0) {
    // §32 + §42: embed mode is single-message — embeds (up to 10) carry up
    // to 6000 chars of structured content combined, so we don't chunk the
    // (short) `text` companion. If text > HARD_CHUNK_LIMIT we still send it
    // but Discord may reject; surface that as a normal send error.
    const opts: MessageCreateOptions = {
      ...(text.length > 0 ? { content: text } : {}),
      embeds,
      ...(attachments.length > 0 ? { files: attachments } : {}),
      ...(replyTo != null
        ? ({ reply: { messageReference: replyTo, failIfNotExists: false } } as MessageReplyOptions)
        : {}),
    }
    try {
      const sent = (await (ch as { send: (o: MessageCreateOptions) => Promise<Message> }).send(opts)) as Message
      sentIds.push(sent.id)
    } catch (e) {
      // §33: stop typing on send failure too — CC won't retry through us,
      // and a stale dot until the 5min cap is worse than no dot.
      ctx.typingHeartbeat?.stop(chatId)
      const msg = e instanceof Error ? e.message : String(e)
      void ctx.errorNotifier?.notify(chatId, 'send', msg) // §55
      return fail(`reply (embed) failed: ${msg}`)
    }
  } else {
    const access = readAccessFile(ctx.paths.accessFile)
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? HARD_CHUNK_LIMIT, HARD_CHUNK_LIMIT))
    const mode = access.chunkMode ?? 'length'
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunk(text, limit, mode)

    for (let i = 0; i < chunks.length; i++) {
      const shouldReplyTo =
        replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      const opts: MessageCreateOptions = {
        content: chunks[i]!,
        ...(i === 0 && attachments.length > 0 ? { files: attachments } : {}),
        ...(shouldReplyTo
          ? ({ reply: { messageReference: replyTo!, failIfNotExists: false } } as MessageReplyOptions)
          : {}),
      }
      try {
        const sent = (await (ch as { send: (o: MessageCreateOptions) => Promise<Message> }).send(opts)) as Message
        sentIds.push(sent.id)
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        ctx.typingHeartbeat?.stop(chatId) // §33
        void ctx.errorNotifier?.notify(chatId, 'send', err) // §55
        return fail(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s): ${err}`)
      }
    }
  }

  ctx.ringBuffers.for(ctx.workspace).push({
    channelId: chatId,
    direction: 'out',
    text: text,
  })

  // §33: a real reply landed — drop the typing indicator.
  ctx.typingHeartbeat?.stop(chatId)
  // §35: enter the sunset tail so subsequent terminal-driven tool calls
  // (after this turn winds down) get deferred to TUI / dropped from trace.
  ctx.onReplyDelivered?.()

  const summary =
    sentIds.length === 1
      ? `sent (id: ${sentIds[0]})`
      : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
  return { ok: true, result: summary }
}

export async function toolReact(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const chatId = args.chat_id as string
  const messageId = args.message_id as string
  const emoji = args.emoji as string
  if (!chatId || !messageId || !emoji) return fail('chat_id, message_id, emoji required')

  const ch = await fetchTextChannel(ctx, chatId)
  if (!ch) return fail(`channel ${chatId} not found`)
  try {
    const msg = await (ch as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(
      messageId,
    )
    await msg.react(emoji)
    return { ok: true, result: 'reacted' }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export async function toolEditMessage(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const chatId = args.chat_id as string
  const messageId = args.message_id as string
  const text = args.text as string
  if (!chatId || !messageId || typeof text !== 'string') {
    return fail('chat_id, message_id, text required')
  }

  const ch = await fetchTextChannel(ctx, chatId)
  if (!ch) return fail(`channel ${chatId} not found`)
  try {
    const msg = await (ch as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(
      messageId,
    )
    const edited = await msg.edit(text)
    // §33: edit also counts as "CC responded".
    ctx.typingHeartbeat?.stop(chatId)
    ctx.onReplyDelivered?.() // §35
    return { ok: true, result: `edited (id: ${edited.id})` }
  } catch (e) {
    ctx.typingHeartbeat?.stop(chatId) // §33: also stop on edit failure
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export async function toolFetchMessages(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const channelId = args.channel as string
  const limitArg = (args.limit as number | undefined) ?? 20
  const limit = Math.min(Math.max(1, limitArg), 100)

  const ch = await fetchTextChannel(ctx, channelId)
  if (!ch) return fail(`channel ${channelId} not found`)

  try {
    const me = ctx.gateway.client.user?.id
    const msgs = await (ch as {
      messages: { fetch: (o: { limit: number }) => Promise<Map<string, Message>> }
    }).messages.fetch({ limit })
    const arr = [...msgs.values()].reverse()
    if (arr.length === 0) return { ok: true, result: '(no messages)' }

    const lines = arr.map(m => {
      const who = m.author.id === me ? 'me' : m.author.username
      const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
      const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
      return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
    })
    return { ok: true, result: lines.join('\n') }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export async function toolDownloadAttachment(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const chatId = args.chat_id as string
  const messageId = args.message_id as string
  if (!chatId || !messageId) return fail('chat_id, message_id required')

  const ch = await fetchTextChannel(ctx, chatId)
  if (!ch) return fail(`channel ${chatId} not found`)

  try {
    const msg = await (ch as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(
      messageId,
    )
    if (msg.attachments.size === 0) return { ok: true, result: 'message has no attachments' }

    mkdirSync(ctx.paths.inboxDir, { recursive: true })
    const lines: string[] = []
    for (const att of msg.attachments.values()) {
      if (att.size > MAX_FILE_BYTES) {
        return fail(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB`)
      }
      const res = await fetch(att.url)
      const buf = Buffer.from(await res.arrayBuffer())
      const rawName = att.name ?? `${att.id}`
      const rawExt = rawName.includes('.') ? rawName.slice(rawName.lastIndexOf('.') + 1) : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const path = join(ctx.paths.inboxDir, `${Date.now()}-${att.id}.${ext}`)
      writeFileSync(path, buf)
      const kb = (att.size / 1024).toFixed(0)
      lines.push(`  ${path}  (${safeAttName(att.name)}, ${att.contentType ?? 'unknown'}, ${kb}KB)`)
    }
    return { ok: true, result: `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}` }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Architecture deltas §23: start a thread under a bot message, post initial
 * content. CC uses this for long reasoning / tool traces in guild channels.
 * DM channels don't support threads → return error.
 */
export async function toolThreadReply(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const chatId = args.chat_id as string
  const parentId = args.parent_message_id as string
  const name = args.name as string
  const content = args.content as string
  if (!chatId || !parentId || !name || typeof content !== 'string') {
    return fail('chat_id, parent_message_id, name, content required')
  }

  const ch = await fetchTextChannel(ctx, chatId)
  if (!ch) return fail(`channel ${chatId} not text-based or not opted-in`)
  if (ch.type === ChannelType.DM) {
    return fail('DM channels do not support threads — use inline reply with markdown folding')
  }
  if (!('threads' in ch) || !(ch as { threads?: unknown }).threads) {
    return fail(`channel ${chatId} does not support threads`)
  }

  try {
    const msg = await (ch as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(
      parentId,
    )
    const thread = await (msg as unknown as {
      startThread: (opts: { name: string }) => Promise<{ id: string; send: (s: string) => Promise<Message> }>
    }).startThread({ name })
    const first = await thread.send(content)
    // §33: thread_reply also counts as "CC responded".
    ctx.typingHeartbeat?.stop(chatId)
    ctx.onReplyDelivered?.() // §35
    return {
      ok: true,
      result: JSON.stringify({ thread_id: thread.id, message_id: first.id }),
    }
  } catch (e) {
    ctx.typingHeartbeat?.stop(chatId) // §33: also stop on thread_reply failure
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export async function dispatchToolCall(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  switch (tool) {
    case 'reply':
      return toolReply(ctx, args)
    case 'react':
      return toolReact(ctx, args)
    case 'edit_message':
      return toolEditMessage(ctx, args)
    case 'fetch_messages':
      return toolFetchMessages(ctx, args)
    case 'download_attachment':
      return toolDownloadAttachment(ctx, args)
    case 'thread_reply':
      return toolThreadReply(ctx, args)
    default:
      log.warn(`unknown tool: ${tool}`)
      return fail(`unknown tool: ${tool}`)
  }
}

// silence unused import warning for ChannelType in some configs
void ChannelType
