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
import { dispatchToolCall, type ToolContext, type ToolOutcome } from '../tool-handlers.ts'

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

  describe('dispatch unknown tool', () => {
    it('returns "unknown tool" failure', async () => {
      const r = await dispatchToolCall(ctx, 'nonsense', {})
      expect(r.ok).toBe(false)
      expect(expectFail(r).error).toMatch(/unknown tool/)
    })
  })
})
