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
  type Channel,
  type Message,
  type MessageReplyOptions,
  type MessageCreateOptions,
} from 'discord.js'
import { readAccessFile } from './access-control.ts'
import type { DiscordGateway } from './discord-gateway.ts'
import type { RingBufferMap } from './ring-buffer.ts'
import { assertSendable, safeAttName } from './safety.ts'
import { log } from '../shared/logger.ts'
import type { Paths } from '../shared/paths.ts'

const HARD_CHUNK_LIMIT = 2000
const MAX_FILES_PER_MESSAGE = 10
const MAX_FILE_BYTES = 25 * 1024 * 1024

export type ToolContext = {
  gateway: DiscordGateway
  ringBuffers: RingBufferMap
  paths: Paths
  workspace: string
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
    if (!(key in access.groups)) {
      log.warn(`outbound deny: guild channel ${key} not opted-in via /discord:access group add`)
      return null
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

  if (typeof chatId !== 'string' || chatId.length === 0) return fail('chat_id required')
  if (files.length > MAX_FILES_PER_MESSAGE) {
    return fail(`max ${MAX_FILES_PER_MESSAGE} attachments per message`)
  }

  const ch = await fetchTextChannel(ctx, chatId)
  if (!ch || !('send' in ch)) return fail(`channel ${chatId} not text-based`)

  const attachments: AttachmentBuilder[] = []
  for (const f of files) {
    try {
      assertSendable(f, ctx.paths)
      const st = statSync(f)
      if (st.size > MAX_FILE_BYTES) {
        return fail(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB)`)
      }
      attachments.push(new AttachmentBuilder(f))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }

  const access = readAccessFile(ctx.paths.accessFile)
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? HARD_CHUNK_LIMIT, HARD_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'length'
  const replyMode = access.replyToMode ?? 'first'
  const chunks = chunk(text, limit, mode)
  const sentIds: string[] = []

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
      return fail(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s): ${err}`)
    }
  }

  ctx.ringBuffers.for(ctx.workspace).push({
    channelId: chatId,
    direction: 'out',
    text: text,
  })

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
    return { ok: true, result: `edited (id: ${edited.id})` }
  } catch (e) {
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
    return {
      ok: true,
      result: JSON.stringify({ thread_id: thread.id, message_id: first.id }),
    }
  } catch (e) {
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
