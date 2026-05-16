/**
 * Unit tests for tool-handlers.ts (react / edit_message / fetch_messages /
 * download_attachment). reply is already covered by controlled-e2e #3.
 *
 * Drives `dispatchToolCall` directly with hand-rolled minimal Channel /
 * Message mocks — mirrors the slash-commands.test.ts pattern.
 */

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeAccessFile } from '../access-control.ts'
import type { DiscordGateway } from '../discord-gateway.ts'
import { RingBufferMap } from '../ring-buffer.ts'
import { dispatchToolCall, validateEmbed, type ToolContext, type ToolOutcome } from '../tool-handlers.ts'
import { TypingHeartbeat } from '../typing-heartbeat.ts'

// Narrowing helpers — `expect(r.ok).toBe(false)` doesn't propagate to TS,
// so we throw and narrow manually before reading discriminated-union fields.
const expectOk = (r: ToolOutcome): { ok: true; result: string } => {
  if (!r.ok) throw new Error(`expected ok, got fail: ${r.error}`)
  return r
}
const expectFail = (r: ToolOutcome): { ok: false; error: string } => {
  if (r.ok) throw new Error(`expected fail, got ok: ${r.result}`)
  return r
}
import { initStateDir } from '../../shared/init-state-dir.ts'
import { resolvePaths, type Paths } from '../../shared/paths.ts'

type MockMsg = {
  id: string
  content: string
  author: { id: string; username: string }
  attachments: Map<string, { id: string; name?: string; size: number; contentType?: string; url: string }>
  createdAt: Date
  react: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
}

function makeMockMessage(opts: {
  id?: string
  content?: string
  authorId?: string
  authorName?: string
  attachments?: Array<{ id: string; name?: string; size: number; contentType?: string; url: string }>
}): MockMsg {
  const msg: MockMsg = {
    id: opts.id ?? 'm-1',
    content: opts.content ?? 'hello',
    author: { id: opts.authorId ?? 'u-bot', username: opts.authorName ?? 'bot' },
    attachments: new Map(),
    createdAt: new Date('2026-05-09T00:00:00Z'),
    react: vi.fn().mockResolvedValue(undefined),
    edit: vi.fn().mockImplementation(async (text: string) => {
      msg.content = text
      return msg
    }),
  }
  for (const a of opts.attachments ?? []) {
    msg.attachments.set(a.id, a)
  }
  return msg
}

describe('tool-handlers', () => {
  let paths: Paths
  let gateway: DiscordGateway
  let ctx: ToolContext

  beforeEach(() => {
    const stateDir = mkdtempSync(join(tmpdir(), 'tools-test-'))
    paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    initStateDir(paths)
    writeAccessFile(paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1'],
      groups: {},
      pending: {},
    })

    gateway = {
      client: {
        user: { id: 'u-bot' },
        channels: { fetch: vi.fn() },
      } as never,
      send: vi.fn(),
      isRecentSent: () => false,
      getDmRecipient: () => null,
      noteDmRecipient: () => {},
      shutdown: async () => {},
    }

    ctx = {
      gateway,
      ringBuffers: new RingBufferMap(),
      paths,
      workspace: 'foo',
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Mock a DM channel where allowFrom includes 'u-1' (so fetchTextChannel passes).
  function mockDmChannel(opts: {
    chatId?: string
    messages?: MockMsg[]
  }): {
    chatId: string
    fetched: ReturnType<typeof vi.fn>
    sendCalls: unknown[][]
  } {
    const chatId = opts.chatId ?? 'dm-u-1'
    const messages = new Map((opts.messages ?? []).map(m => [m.id, m]))
    const sendCalls: unknown[][] = []
    const channel = {
      id: chatId,
      type: ChannelType.DM,
      isTextBased: () => true,
      isThread: () => false,
      recipientId: 'u-1',
      send: vi.fn().mockImplementation((arg: unknown) => {
        sendCalls.push([arg])
        return { id: `sent-${sendCalls.length}` }
      }),
      messages: {
        fetch: vi.fn().mockImplementation((arg: unknown) => {
          if (typeof arg === 'string') {
            const m = messages.get(arg)
            if (!m) throw new Error(`message ${arg} not found`)
            return Promise.resolve(m)
          }
          return Promise.resolve(messages)
        }),
      },
    }
    const fetched = vi.fn().mockResolvedValue(channel)
    ;(gateway.client.channels as unknown as { fetch: typeof fetched }).fetch = fetched
    return { chatId, fetched, sendCalls }
  }

  describe('react', () => {
    it('fails on missing required args', async () => {
      const r = await dispatchToolCall(ctx, 'react', { chat_id: 'x' })
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/required/)
    })

    it('reacts to message with emoji', async () => {
      const msg = makeMockMessage({ id: 'm-1' })
      mockDmChannel({ messages: [msg] })
      const r = await dispatchToolCall(ctx, 'react', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
        emoji: '👍',
      })
      expect(r.ok).toBe(true)
      expect(msg.react).toHaveBeenCalledWith('👍')
      expect(expectOk(r).result).toMatch(/reacted/)
    })

    it('fails when message not found', async () => {
      mockDmChannel({})
      const r = await dispatchToolCall(ctx, 'react', {
        chat_id: 'dm-u-1',
        message_id: 'nonexistent',
        emoji: '👍',
      })
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/not found/)
    })

    it('fails when channel cannot be fetched', async () => {
      ;(gateway.client.channels as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
        .fn()
        .mockResolvedValue(null)
      const r = await dispatchToolCall(ctx, 'react', {
        chat_id: 'ghost',
        message_id: 'm-1',
        emoji: '👍',
      })
      expect(r.ok).toBe(false)
    })
  })

  describe('edit_message', () => {
    it('fails on missing required args', async () => {
      const r = await dispatchToolCall(ctx, 'edit_message', { chat_id: 'x', message_id: 'y' })
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/required/)
    })

    it('edits message and returns id', async () => {
      const msg = makeMockMessage({ id: 'm-1', content: 'old' })
      mockDmChannel({ messages: [msg] })
      const r = await dispatchToolCall(ctx, 'edit_message', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
        text: 'new content',
      })
      expect(r.ok).toBe(true)
      expect(expectOk(r).result).toMatch(/edited.*m-1/)
      expect(msg.content).toBe('new content')
    })

    it('accepts empty string text (clearing content)', async () => {
      const msg = makeMockMessage({ id: 'm-1', content: 'old' })
      mockDmChannel({ messages: [msg] })
      const r = await dispatchToolCall(ctx, 'edit_message', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
        text: '',
      })
      expect(r.ok).toBe(true)
    })
  })

  describe('fetch_messages', () => {
    it('returns "(no messages)" when channel empty', async () => {
      mockDmChannel({})
      const r = await dispatchToolCall(ctx, 'fetch_messages', { channel: 'dm-u-1' })
      expect(r.ok).toBe(true)
      expect(expectOk(r).result).toMatch(/no messages/)
    })

    it('formats messages with timestamps and "me" alias for bot', async () => {
      const m1 = makeMockMessage({ id: 'm-1', authorId: 'u-1', authorName: 'alice', content: 'hi' })
      const m2 = makeMockMessage({ id: 'm-2', authorId: 'u-bot', authorName: 'bot', content: 'hello' })
      mockDmChannel({ messages: [m1, m2] })
      const r = await dispatchToolCall(ctx, 'fetch_messages', { channel: 'dm-u-1' })
      expect(r.ok).toBe(true)
      // Newest-first reverse: arr.reverse(), so first-in is m1, displayed last
      expect(expectOk(r).result).toContain('alice: hi')
      expect(expectOk(r).result).toContain('me: hello')
      expect(expectOk(r).result).toContain('id: m-1')
      expect(expectOk(r).result).toContain('id: m-2')
    })

    it('formats attachments with +Natt suffix', async () => {
      const msg = makeMockMessage({
        id: 'm-1',
        authorId: 'u-1',
        attachments: [
          { id: 'a-1', name: 'pic.png', size: 1000, contentType: 'image/png', url: 'http://x' },
          { id: 'a-2', name: 'doc.pdf', size: 2000, contentType: 'application/pdf', url: 'http://y' },
        ],
      })
      mockDmChannel({ messages: [msg] })
      const r = await dispatchToolCall(ctx, 'fetch_messages', { channel: 'dm-u-1' })
      expect(r.ok).toBe(true)
      expect(expectOk(r).result).toContain('+2att')
    })

    it('clamps limit to [1, 100]', async () => {
      mockDmChannel({})
      // First call resolves the channel via gateway.client.channels.fetch,
      // which then exposes messages.fetch. Capture the spy after first call.
      await dispatchToolCall(ctx, 'fetch_messages', { channel: 'dm-u-1', limit: 0 })
      const fetched = (gateway.client.channels as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      const channel = await fetched.mock.results[0]!.value
      const fetchSpy = channel.messages.fetch as ReturnType<typeof vi.fn>
      expect(fetchSpy).toHaveBeenLastCalledWith({ limit: 1 })
      await dispatchToolCall(ctx, 'fetch_messages', { channel: 'dm-u-1', limit: 999 })
      expect(fetchSpy).toHaveBeenLastCalledWith({ limit: 100 })
    })

    it('replaces newlines with ⏎ inline marker', async () => {
      const msg = makeMockMessage({ id: 'm-1', authorId: 'u-1', content: 'line1\nline2\nline3' })
      mockDmChannel({ messages: [msg] })
      const r = await dispatchToolCall(ctx, 'fetch_messages', { channel: 'dm-u-1' })
      expect(expectOk(r).result).toContain('line1 ⏎ line2 ⏎ line3')
    })
  })

  describe('download_attachment', () => {
    let originalFetch: typeof globalThis.fetch

    beforeEach(() => {
      originalFetch = globalThis.fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it('fails on missing required args', async () => {
      const r = await dispatchToolCall(ctx, 'download_attachment', { chat_id: 'x' })
      expect(r.ok).toBe(false)
    })

    it('returns "no attachments" when message has none', async () => {
      const msg = makeMockMessage({ id: 'm-1' })
      mockDmChannel({ messages: [msg] })
      const r = await dispatchToolCall(ctx, 'download_attachment', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
      })
      expect(r.ok).toBe(true)
      expect(expectOk(r).result).toMatch(/no attachments/)
    })

    it('downloads attachments to inbox dir', async () => {
      const buf = Buffer.from('fake-image-bytes')
      globalThis.fetch = vi.fn().mockResolvedValue({
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as never) as never

      const msg = makeMockMessage({
        id: 'm-1',
        attachments: [
          { id: 'a-1', name: 'photo.png', size: buf.length, contentType: 'image/png', url: 'http://x/photo.png' },
        ],
      })
      mockDmChannel({ messages: [msg] })

      const r = await dispatchToolCall(ctx, 'download_attachment', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
      })
      expect(r.ok).toBe(true)
      const files = readdirSync(paths.inboxDir).filter(f => f.includes('a-1'))
      expect(files.length).toBe(1)
      expect(files[0]).toMatch(/\.png$/)
      const written = readFileSync(join(paths.inboxDir, files[0]!))
      expect(written.equals(buf)).toBe(true)
    })

    it('rejects attachment exceeding MAX_FILE_BYTES', async () => {
      const msg = makeMockMessage({
        id: 'm-1',
        attachments: [
          { id: 'a-1', name: 'huge.bin', size: 100 * 1024 * 1024, url: 'http://x/huge' },
        ],
      })
      mockDmChannel({ messages: [msg] })
      const r = await dispatchToolCall(ctx, 'download_attachment', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
      })
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/too large/)
    })

    it('sanitizes extension from suspicious filename', async () => {
      const buf = Buffer.from('x')
      globalThis.fetch = vi.fn().mockResolvedValue({
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as never) as never

      const msg = makeMockMessage({
        id: 'm-1',
        attachments: [
          { id: 'a-1', name: 'evil..//hack.png', size: buf.length, url: 'http://x' },
        ],
      })
      mockDmChannel({ messages: [msg] })

      const r = await dispatchToolCall(ctx, 'download_attachment', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
      })
      expect(r.ok).toBe(true)
      const files = readdirSync(paths.inboxDir)
      // No path-separator chars in filename, only sanitized ext
      for (const f of files) {
        expect(f).not.toContain('/')
        expect(f).not.toContain('..')
      }
      // extension should be alphanumeric only
      const ext = files[0]?.split('.').pop()
      expect(ext).toMatch(/^[a-zA-Z0-9]+$/)
    })
  })

  describe('thread_reply (§23)', () => {
    function mockGuildChannelWithThread(opts: {
      chatId?: string
      parentMessage: MockMsg
      threadId?: string
    }) {
      const chatId = opts.chatId ?? 'cg-1'
      const threadId = opts.threadId ?? 'thread-1'
      const threadSends: unknown[][] = []
      const threadChannel = {
        id: threadId,
        send: vi.fn().mockImplementation((s: unknown) => {
          threadSends.push([s])
          return { id: `t-msg-${threadSends.length}` }
        }),
      }
      const parentMsg = {
        ...opts.parentMessage,
        startThread: vi.fn().mockResolvedValue(threadChannel),
      }
      const channel = {
        id: chatId,
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isThread: () => false,
        threads: { create: vi.fn() }, // truthy
        messages: {
          fetch: vi.fn().mockResolvedValue(parentMsg),
        },
      }
      const fetched = vi.fn().mockResolvedValue(channel)
      ;(gateway.client.channels as unknown as { fetch: typeof fetched }).fetch = fetched
      writeAccessFile(paths.accessFile, {
        dmPolicy: 'pairing',
        allowFrom: ['u-1'],
        groups: { [chatId]: { requireMention: false, allowFrom: [] } },
        pending: {},
      })
      return { chatId, threadId, threadSends, parentMsg, channel }
    }

    it('fails on missing args', async () => {
      const r = await dispatchToolCall(ctx, 'thread_reply', { chat_id: 'x' })
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/required/)
    })

    it('rejects DM channels', async () => {
      mockDmChannel({})
      const r = await dispatchToolCall(ctx, 'thread_reply', {
        chat_id: 'dm-u-1',
        parent_message_id: 'm-x',
        name: 'reasoning',
        content: 'long',
      })
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/DM/i)
    })

    it('starts thread under parent message and sends initial content', async () => {
      const parent = makeMockMessage({ id: 'main-1' })
      const { threadId, parentMsg, threadSends } = mockGuildChannelWithThread({
        parentMessage: parent,
      })
      const r = await dispatchToolCall(ctx, 'thread_reply', {
        chat_id: 'cg-1',
        parent_message_id: 'main-1',
        name: 'reasoning',
        content: 'detailed reasoning here',
      })
      expect(r.ok).toBe(true)
      const out = JSON.parse(expectOk(r).result)
      expect(out.thread_id).toBe(threadId)
      expect(out.message_id).toBe('t-msg-1')
      expect(parentMsg.startThread).toHaveBeenCalledWith({ name: 'reasoning' })
      expect(threadSends.length).toBe(1)
      expect(threadSends[0]![0]).toBe('detailed reasoning here')
    })

    it('returns thread_id usable as chat_id for subsequent calls', async () => {
      const parent = makeMockMessage({ id: 'main-1' })
      const { threadId } = mockGuildChannelWithThread({
        parentMessage: parent,
        threadId: 'thread-xyz',
      })
      const r = await dispatchToolCall(ctx, 'thread_reply', {
        chat_id: 'cg-1',
        parent_message_id: 'main-1',
        name: 'r',
        content: 'x',
      })
      const out = JSON.parse(expectOk(r).result)
      // Critical contract: thread_id is what CC will pass as chat_id later
      expect(out.thread_id).toBe(threadId)
    })
  })

  describe('reply (§32: embed)', () => {
    it('embed mode sends exactly one message (no chunking), embed content round-trips', async () => {
      const { sendCalls } = mockDmChannel({})
      // 3000 chars fits in description (≤ 4096) — and proves we don't chunk
      // even at sizes that would split a plain-text reply at the 2000 cap.
      const longDesc = 'x'.repeat(3_000)
      const r = await dispatchToolCall(ctx, 'reply', {
        chat_id: 'dm-u-1',
        text: 'see embed',
        embed: {
          title: 'Summary',
          description: longDesc,
          fields: [{ name: 'A', value: 'one' }, { name: 'B', value: 'two' }],
        },
      })
      expectOk(r)
      expect(sendCalls.length).toBe(1)
      const opts = sendCalls[0]![0] as { content?: string; embeds?: unknown[] }
      expect(opts.content).toBe('see embed')
      expect(opts.embeds).toHaveLength(1)
      // EmbedBuilder serializes via .data — title/description/fields round-trip.
      const built = opts.embeds![0] as { data: { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }
      expect(built.data.title).toBe('Summary')
      expect(built.data.description).toBe(longDesc)
      expect(built.data.fields?.length).toBe(2)
    })

    it('omits content when text is empty (embed-only message)', async () => {
      const { sendCalls } = mockDmChannel({})
      const r = await dispatchToolCall(ctx, 'reply', {
        chat_id: 'dm-u-1',
        text: '',
        embed: { title: 'Only embed' },
      })
      expectOk(r)
      const opts = sendCalls[0]![0] as { content?: string; embeds?: unknown[] }
      expect(opts.content).toBeUndefined()
      expect(opts.embeds).toHaveLength(1)
    })

    it('rejects oversize total before sending (no round-trip wasted)', async () => {
      const { sendCalls, fetched } = mockDmChannel({})
      const oversized = 'y'.repeat(4096)
      const r = await dispatchToolCall(ctx, 'reply', {
        chat_id: 'dm-u-1',
        text: 'hi',
        embed: {
          description: oversized,
          // 4096 + many field values to push total well past 6000
          fields: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, value: 'v'.repeat(200) })),
        },
      })
      expectFail(r)
      expect(expectFail(r).error).toMatch(/6000/)
      // Validation happens before fetchTextChannel — saves a Discord round-trip.
      expect(fetched).not.toHaveBeenCalled()
      expect(sendCalls.length).toBe(0)
    })

    it('rejects too-many fields', async () => {
      mockDmChannel({})
      const r = await dispatchToolCall(ctx, 'reply', {
        chat_id: 'dm-u-1',
        text: '',
        embed: {
          fields: Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: 'v' })),
        },
      })
      expectFail(r)
      expect(expectFail(r).error).toMatch(/max 25/)
    })

    it('text-only (no embed) keeps existing chunking behavior', async () => {
      const { sendCalls } = mockDmChannel({})
      const r = await dispatchToolCall(ctx, 'reply', {
        chat_id: 'dm-u-1',
        text: 'a'.repeat(4_500),
      })
      expectOk(r)
      // 4500 / 2000 chunks → 3 sends
      expect(sendCalls.length).toBe(3)
      // No embeds field smuggled in
      const opts = sendCalls[0]![0] as { embeds?: unknown[] }
      expect(opts.embeds).toBeUndefined()
    })
  })

  describe('reply (§33: typing heartbeat stop)', () => {
    function withHeartbeat() {
      const send = vi.fn()
      const hb = new TypingHeartbeat(send, { intervalMs: 1_000, maxMs: 60_000 })
      ctx = { ...ctx, typingHeartbeat: hb }
      return { send, hb }
    }

    it('stops typing on successful reply', async () => {
      const { hb } = withHeartbeat()
      mockDmChannel({})
      hb.start('dm-u-1', 'foo')
      expect(hb.activeCount).toBe(1)
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'dm-u-1', text: 'hi' })
      expectOk(r)
      expect(hb.activeCount).toBe(0)
    })

    it('stops typing when reply send throws (not only on success)', async () => {
      const { hb } = withHeartbeat()
      const chatId = 'dm-u-1'
      const channel = {
        id: chatId,
        type: ChannelType.DM,
        isTextBased: () => true,
        isThread: () => false,
        recipientId: 'u-1',
        send: vi.fn().mockRejectedValue(new Error('discord 500')),
      }
      ;(gateway.client.channels as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch =
        vi.fn().mockResolvedValue(channel)

      hb.start(chatId, 'foo')
      expect(hb.activeCount).toBe(1)
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: chatId, text: 'hi' })
      expectFail(r)
      expect(hb.activeCount).toBe(0)
    })

    it('stops typing on edit_message success', async () => {
      const { hb } = withHeartbeat()
      const m = makeMockMessage({ id: 'm-1', authorId: 'u-bot' })
      mockDmChannel({ messages: [m] })
      hb.start('dm-u-1', 'foo')
      const r = await dispatchToolCall(ctx, 'edit_message', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
        text: 'new',
      })
      expectOk(r)
      expect(hb.activeCount).toBe(0)
    })

    it('stops typing on edit_message failure (message not found)', async () => {
      const { hb } = withHeartbeat()
      mockDmChannel({}) // no messages — fetch will throw
      hb.start('dm-u-1', 'foo')
      const r = await dispatchToolCall(ctx, 'edit_message', {
        chat_id: 'dm-u-1',
        message_id: 'ghost',
        text: 'x',
      })
      expectFail(r)
      expect(hb.activeCount).toBe(0)
    })

    it('react does NOT stop typing (not a real reply)', async () => {
      const { hb } = withHeartbeat()
      const m = makeMockMessage({ id: 'm-1', authorId: 'u-bot' })
      mockDmChannel({ messages: [m] })
      hb.start('dm-u-1', 'foo')
      const r = await dispatchToolCall(ctx, 'react', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
        emoji: '👀',
      })
      expectOk(r)
      // still ticking — react is an ack, not a reply
      expect(hb.activeCount).toBe(1)
      hb.stopAll() // cleanup
    })
  })

  describe('reply (§35: onReplyDelivered)', () => {
    it('reply calls onReplyDelivered exactly once on success', async () => {
      const onReplyDelivered = vi.fn()
      ctx = { ...ctx, onReplyDelivered }
      mockDmChannel({})
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'dm-u-1', text: 'hi' })
      expectOk(r)
      expect(onReplyDelivered).toHaveBeenCalledTimes(1)
    })

    it('reply does NOT call onReplyDelivered when send throws', async () => {
      const onReplyDelivered = vi.fn()
      ctx = { ...ctx, onReplyDelivered }
      const channel = {
        id: 'dm-u-1',
        type: ChannelType.DM,
        isTextBased: () => true,
        isThread: () => false,
        recipientId: 'u-1',
        send: vi.fn().mockRejectedValue(new Error('boom')),
      }
      ;(gateway.client.channels as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch =
        vi.fn().mockResolvedValue(channel)
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'dm-u-1', text: 'x' })
      expectFail(r)
      expect(onReplyDelivered).not.toHaveBeenCalled()
    })

    it('edit_message calls onReplyDelivered on success but not on failure', async () => {
      const onReplyDelivered = vi.fn()
      ctx = { ...ctx, onReplyDelivered }
      const m = makeMockMessage({ id: 'm-1', authorId: 'u-bot' })
      mockDmChannel({ messages: [m] })
      const r = await dispatchToolCall(ctx, 'edit_message', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
        text: 'new',
      })
      expectOk(r)
      expect(onReplyDelivered).toHaveBeenCalledTimes(1)

      // Same ctx, second call with bogus id → no extra invocation
      mockDmChannel({}) // no messages → fetch will throw
      const r2 = await dispatchToolCall(ctx, 'edit_message', {
        chat_id: 'dm-u-1',
        message_id: 'ghost',
        text: 'x',
      })
      expectFail(r2)
      expect(onReplyDelivered).toHaveBeenCalledTimes(1) // unchanged
    })

    it('react does NOT call onReplyDelivered (not a reply-class tool)', async () => {
      const onReplyDelivered = vi.fn()
      ctx = { ...ctx, onReplyDelivered }
      const m = makeMockMessage({ id: 'm-1', authorId: 'u-bot' })
      mockDmChannel({ messages: [m] })
      const r = await dispatchToolCall(ctx, 'react', {
        chat_id: 'dm-u-1',
        message_id: 'm-1',
        emoji: '👀',
      })
      expectOk(r)
      expect(onReplyDelivered).not.toHaveBeenCalled()
    })
  })

  describe('outbound gate (§38: groupPolicyDefaults symmetry)', () => {
    function mockGuildChannel(chatId: string): {
      sendCalls: unknown[][]
      fetched: ReturnType<typeof vi.fn>
    } {
      const sendCalls: unknown[][] = []
      const channel = {
        id: chatId,
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isThread: () => false,
        parentId: null,
        send: vi.fn().mockImplementation((arg: unknown) => {
          sendCalls.push([arg])
          return { id: `sent-${sendCalls.length}` }
        }),
      }
      const fetched = vi.fn().mockResolvedValue(channel)
      ;(gateway.client.channels as unknown as { fetch: typeof fetched }).fetch = fetched
      return { sendCalls, fetched }
    }

    it('passes when channel is in access.groups (regression)', async () => {
      writeAccessFile(paths.accessFile, {
        dmPolicy: 'pairing',
        groupPolicy: 'open',
        allowFrom: ['u-1'],
        groups: { 'cg-foo': { requireMention: false, allowFrom: [] } },
        pending: {},
      })
      const { sendCalls } = mockGuildChannel('cg-foo')
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'cg-foo', text: 'hi' })
      expect(r.ok).toBe(true)
      expect(sendCalls.length).toBe(1)
    })

    it('passes via groupPolicyDefaults when channel NOT in access.groups', async () => {
      writeAccessFile(paths.accessFile, {
        dmPolicy: 'pairing',
        groupPolicy: 'open',
        groupPolicyDefaults: { requireMention: false, allowFrom: [] },
        allowFrom: ['u-1'],
        groups: {},
        pending: {},
      })
      const { sendCalls } = mockGuildChannel('cg-new')
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'cg-new', text: 'hi' })
      expect(r.ok).toBe(true)
      expect(sendCalls.length).toBe(1)
    })

    it('denies when channel NOT in groups and no groupPolicyDefaults (back-compat)', async () => {
      writeAccessFile(paths.accessFile, {
        dmPolicy: 'pairing',
        groupPolicy: 'open',
        allowFrom: ['u-1'],
        groups: {},
        pending: {},
      })
      const { sendCalls } = mockGuildChannel('cg-new')
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'cg-new', text: 'hi' })
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/not text-based/)
      expect(sendCalls.length).toBe(0)
    })

    it('denies when groupPolicy is "disabled" regardless of defaults', async () => {
      writeAccessFile(paths.accessFile, {
        dmPolicy: 'pairing',
        groupPolicy: 'disabled',
        groupPolicyDefaults: { requireMention: false, allowFrom: [] },
        allowFrom: ['u-1'],
        groups: {},
        pending: {},
      })
      const { sendCalls } = mockGuildChannel('cg-new')
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'cg-new', text: 'hi' })
      expect(r.ok).toBe(false)
      expect(sendCalls.length).toBe(0)
    })

    it('explicit groups entry beats defaults (no behavior change for configured channels)', async () => {
      writeAccessFile(paths.accessFile, {
        dmPolicy: 'pairing',
        groupPolicy: 'open',
        groupPolicyDefaults: { requireMention: false, allowFrom: [] },
        allowFrom: ['u-1'],
        groups: { 'cg-explicit': { requireMention: false, allowFrom: [] } },
        pending: {},
      })
      const { sendCalls } = mockGuildChannel('cg-explicit')
      const r = await dispatchToolCall(ctx, 'reply', { chat_id: 'cg-explicit', text: 'hi' })
      expect(r.ok).toBe(true)
      expect(sendCalls.length).toBe(1)
    })
  })

  describe('dispatch unknown tool', () => {
    it('returns "unknown tool" failure', async () => {
      const r = await dispatchToolCall(ctx, 'nonsense', {})
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/unknown tool/)
    })
  })
})

describe('validateEmbed (§32 / FR-5.4) — pure unit', () => {
  it('accepts a minimal valid embed', () => {
    const r = validateEmbed({ title: 'hi' })
    if (!r.ok) throw new Error(r.error)
    expect(r.totalChars).toBe(2)
  })

  it('sums title + description + every field name & value', () => {
    const r = validateEmbed({
      title: 'AB', // 2
      description: 'CDE', // 3
      fields: [{ name: 'FG', value: 'HIJ' }], // 2 + 3
    })
    if (!r.ok) throw new Error(r.error)
    expect(r.totalChars).toBe(10)
  })

  it('rejects title > 256 chars', () => {
    const r = validateEmbed({ title: 'x'.repeat(257) })
    expect(r.ok).toBe(false)
  })

  it('rejects description > 4096 chars', () => {
    const r = validateEmbed({ description: 'x'.repeat(4097) })
    expect(r.ok).toBe(false)
  })

  it('rejects more than 25 fields', () => {
    const r = validateEmbed({
      fields: Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: 'v' })),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/25/)
  })

  it('rejects field name > 256', () => {
    const r = validateEmbed({ fields: [{ name: 'x'.repeat(257), value: 'v' }] })
    expect(r.ok).toBe(false)
  })

  it('rejects field value > 1024', () => {
    const r = validateEmbed({ fields: [{ name: 'n', value: 'x'.repeat(1025) }] })
    expect(r.ok).toBe(false)
  })

  it('rejects empty field name or value', () => {
    expect(validateEmbed({ fields: [{ name: '', value: 'v' }] }).ok).toBe(false)
    expect(validateEmbed({ fields: [{ name: 'n', value: '' }] }).ok).toBe(false)
  })

  it('rejects total > 6000 across all parts', () => {
    const r = validateEmbed({
      description: 'd'.repeat(4096), // 4096
      fields: [
        { name: 'a', value: 'v'.repeat(1024) }, // 1 + 1024
        { name: 'b', value: 'v'.repeat(1024) }, // 1 + 1024
      ],
      // total = 4096 + 1 + 1024 + 1 + 1024 = 6146 > 6000
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/6000/)
  })

  it('rejects color out of [0, 0xFFFFFF]', () => {
    expect(validateEmbed({ title: 't', color: -1 }).ok).toBe(false)
    expect(validateEmbed({ title: 't', color: 0x1000000 }).ok).toBe(false)
    expect(validateEmbed({ title: 't', color: 0x4287f5 }).ok).toBe(true)
  })
})
