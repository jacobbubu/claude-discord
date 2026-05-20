/**
 * Unit tests for pinned-indicator (§53).
 *
 * Mocks the discord.js channels.fetch surface — we keep an in-memory
 * "channel" that tracks send / edit / pin / unpin / delete so we can assert
 * the right branch fired without spinning up a real Client.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscordGateway } from '../discord-gateway.ts'
import {
  INDICATOR_PREFIX,
  reconcileIndicators,
  syncIndicator,
  unpinIndicator,
} from '../pinned-indicator.ts'
import { RoutingTable } from '../routing.ts'

type StoredMsg = { id: string; content: string; author: { id: string } }

type ChannelMock = ReturnType<typeof makeChannelMock>

function makeChannelMock(opts: { selfId?: string } = {}) {
  const selfId = opts.selfId ?? 'bot-self'
  const stored = new Map<string, StoredMsg>()
  const pinned = new Set<string>()
  const deleted = new Set<string>()
  let nextId = 1

  const wrapMsg = (m: StoredMsg) => ({
    get id() { return m.id },
    get content() { return m.content },
    get author() { return m.author },
    edit: vi.fn(async (newContent: string) => {
      m.content = newContent
    }),
    pin: vi.fn(async () => {
      pinned.add(m.id)
    }),
    delete: vi.fn(async () => {
      deleted.add(m.id)
      pinned.delete(m.id)
      stored.delete(m.id)
    }),
  })

  const messages = {
    fetch: vi.fn(async (id: string) => {
      if (deleted.has(id) || !stored.has(id)) {
        throw new Error(`Unknown Message: ${id}`)
      }
      return wrapMsg(stored.get(id)!)
    }),
    fetchPinned: vi.fn(async () => {
      const list = [...pinned]
        .map(id => stored.get(id))
        .filter((m): m is StoredMsg => !!m)
        .map(wrapMsg)
      return {
        find: (cb: (m: ReturnType<typeof wrapMsg>) => boolean) => list.find(cb),
        [Symbol.iterator]: function* () {
          yield* list
        },
      }
    }),
  }

  const channel = {
    isTextBased: () => true,
    messages,
    send: vi.fn(async (content: string) => {
      const id = `m-${nextId++}`
      const m: StoredMsg = { id, content, author: { id: selfId } }
      stored.set(id, m)
      return wrapMsg(m)
    }),
  }

  /** Helper for tests to plant a pre-existing pinned message. */
  function plantPinned(content: string, author = selfId): string {
    const id = `m-${nextId++}`
    stored.set(id, { id, content, author: { id: author } })
    pinned.add(id)
    return id
  }

  return {
    channel,
    selfId,
    plantPinned,
    get pinnedIds() { return [...pinned] },
    get sentCount() { return channel.send.mock.calls.length },
    get storedById() { return stored },
    get deletedIds() { return [...deleted] },
  }
}

function makeGateway(channelsById: Map<string, ChannelMock>): DiscordGateway {
  const fetch = vi.fn(async (id: string) => {
    const c = channelsById.get(id)
    return c ? c.channel : null
  })
  const selfId = channelsById.size > 0 ? [...channelsById.values()][0]!.selfId : 'bot-self'
  return {
    client: {
      channels: { fetch },
      user: { id: selfId },
    } as never,
    send: vi.fn(),
    isRecentSent: () => false,
    getDmRecipient: () => null,
    noteDmRecipient: () => {},
    shutdown: async () => {},
  }
}

function makeRouting(): RoutingTable {
  const dir = mkdtempSync(join(tmpdir(), 'pin-ind-'))
  return new RoutingTable(join(dir, 'routing.json'))
}

describe('pinned-indicator', () => {
  let routing: RoutingTable

  beforeEach(() => {
    routing = makeRouting()
  })

  afterEach(() => {
    routing.stopWatching()
  })

  describe('syncIndicator — create path', () => {
    it('sends + pins a new message and stores its id on first bind', async () => {
      routing.set('c-1', 'foo', 1700000000_000)
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))

      await syncIndicator({ gateway: gw, routing }, 'c-1')

      expect(ch.sentCount).toBe(1)
      const content = ch.channel.send.mock.calls[0]![0]!
      expect(content).toContain(INDICATOR_PREFIX)
      expect(content).toContain('foo')
      expect(content).toContain('<t:1700000000:R>')
      expect(ch.pinnedIds).toHaveLength(1)
      // routing now carries the indicator id
      expect(routing.get('c-1')?.indicator_message_id).toBe(ch.pinnedIds[0])
    })

    it('no-op when channel has no routing entry', async () => {
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))

      await syncIndicator({ gateway: gw, routing }, 'c-1')

      expect(ch.sentCount).toBe(0)
      expect(ch.pinnedIds).toHaveLength(0)
    })

    it('still stores message id when pin() fails (e.g. pin cap reached)', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock()
      // Override send to return a msg whose pin throws
      const realSend = ch.channel.send
      ch.channel.send = vi.fn(async (content: string) => {
        const wrapped = await realSend(content)
        return {
          ...wrapped,
          pin: vi.fn(async () => { throw new Error('Maximum number of pins reached') }),
        }
      }) as typeof ch.channel.send
      const gw = makeGateway(new Map([['c-1', ch]]))

      await syncIndicator({ gateway: gw, routing }, 'c-1')

      // id stored so next sync edits instead of duplicating
      expect(routing.get('c-1')?.indicator_message_id).toBeTruthy()
    })
  })

  describe('syncIndicator — edit-by-stored-id path', () => {
    it('edits the existing message and keeps the same id on workspace switch', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))
      await syncIndicator({ gateway: gw, routing }, 'c-1')
      const firstId = routing.get('c-1')?.indicator_message_id
      const sendCountBefore = ch.sentCount

      // Switch
      routing.set('c-1', 'bar', 1700000001_000)
      await syncIndicator({ gateway: gw, routing }, 'c-1')

      expect(routing.get('c-1')?.indicator_message_id).toBe(firstId)
      // No new send — we edited
      expect(ch.sentCount).toBe(sendCountBefore)
      // Content reflects new workspace
      const msg = ch.storedById.get(firstId!)
      expect(msg?.content).toContain('bar')
      expect(msg?.content).not.toContain('foo')
    })

    it('skips edit when content already matches (idempotent)', async () => {
      routing.set('c-1', 'foo', 1700000000_000)
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))
      await syncIndicator({ gateway: gw, routing }, 'c-1')
      const firstId = routing.get('c-1')?.indicator_message_id

      // Second call with same state — fetch.edit should NOT be called
      // (we can detect by checking edit calls on the fetched wrapper)
      const fetchSpy = ch.channel.messages.fetch
      const callsBefore = fetchSpy.mock.calls.length
      await syncIndicator({ gateway: gw, routing }, 'c-1')
      const fetched = await fetchSpy.mock.results[callsBefore]?.value
      expect(fetched?.edit).not.toHaveBeenCalled()
      expect(routing.get('c-1')?.indicator_message_id).toBe(firstId)
    })

    it('falls back to scan-and-create when stored id no longer exists', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))
      await syncIndicator({ gateway: gw, routing }, 'c-1')
      const firstId = routing.get('c-1')?.indicator_message_id!

      // User manually deleted the pinned message — stored id now 404s
      ch.storedById.delete(firstId)
      // Now switch
      routing.set('c-1', 'bar', 2)
      await syncIndicator({ gateway: gw, routing }, 'c-1')

      // New id stored, new message sent
      expect(routing.get('c-1')?.indicator_message_id).not.toBe(firstId)
      expect(ch.sentCount).toBe(2)
    })
  })

  describe('syncIndicator — scan-pins-and-reuse path', () => {
    it('finds a previously-pinned indicator and reuses it when stored id is missing', async () => {
      routing.set('c-1', 'foo', 1700000000_000)
      const ch = makeChannelMock()
      // Simulate prior daemon run leaving an old indicator pinned
      const plantedId = ch.plantPinned(`${INDICATOR_PREFIX}old-name\` · switched <t:1:R>`)
      const gw = makeGateway(new Map([['c-1', ch]]))

      await syncIndicator({ gateway: gw, routing }, 'c-1')

      // Reused planted message — no new send
      expect(ch.sentCount).toBe(0)
      expect(routing.get('c-1')?.indicator_message_id).toBe(plantedId)
      // Content updated to reflect current workspace
      expect(ch.storedById.get(plantedId)?.content).toContain('foo')
    })

    it("ignores pinned messages not authored by the bot", async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock()
      ch.plantPinned(`${INDICATOR_PREFIX}other\` · switched <t:1:R>`, 'someone-else')
      const gw = makeGateway(new Map([['c-1', ch]]))

      await syncIndicator({ gateway: gw, routing }, 'c-1')

      // Did not reuse — sent a fresh one
      expect(ch.sentCount).toBe(1)
    })
  })

  describe('unpinIndicator', () => {
    it('deletes the indicator message and clears the stored id', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))
      await syncIndicator({ gateway: gw, routing }, 'c-1')
      const id = routing.get('c-1')?.indicator_message_id!
      expect(ch.pinnedIds).toContain(id)

      await unpinIndicator({ gateway: gw, routing }, 'c-1')

      expect(ch.deletedIds).toContain(id)
      expect(routing.get('c-1')?.indicator_message_id).toBeUndefined()
    })

    it('no-op when no indicator is stored', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))

      await unpinIndicator({ gateway: gw, routing }, 'c-1')

      expect(ch.deletedIds).toHaveLength(0)
    })

    it('clears the stored id even when the message was already gone', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch]]))
      await syncIndicator({ gateway: gw, routing }, 'c-1')
      const id = routing.get('c-1')?.indicator_message_id!
      ch.storedById.delete(id) // simulate manual delete

      await unpinIndicator({ gateway: gw, routing }, 'c-1')

      expect(routing.get('c-1')?.indicator_message_id).toBeUndefined()
    })
  })

  describe('reconcileIndicators', () => {
    it('syncs every channel in routing.json on startup', async () => {
      routing.set('c-1', 'foo', 1)
      routing.set('c-2', 'bar', 2)
      const ch1 = makeChannelMock()
      const ch2 = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch1], ['c-2', ch2]]))

      await reconcileIndicators({ gateway: gw, routing })

      expect(ch1.sentCount).toBe(1)
      expect(ch2.sentCount).toBe(1)
      expect(routing.get('c-1')?.indicator_message_id).toBeTruthy()
      expect(routing.get('c-2')?.indicator_message_id).toBeTruthy()
    })

    it('one channel failure does not break the rest', async () => {
      routing.set('c-1', 'foo', 1)
      routing.set('c-2', 'bar', 2)
      const ch1 = makeChannelMock()
      ch1.channel.send = vi.fn(async () => { throw new Error('boom') }) as never
      const ch2 = makeChannelMock()
      const gw = makeGateway(new Map([['c-1', ch1], ['c-2', ch2]]))

      await reconcileIndicators({ gateway: gw, routing })

      expect(ch2.sentCount).toBe(1)
      expect(routing.get('c-2')?.indicator_message_id).toBeTruthy()
    })
  })
})
