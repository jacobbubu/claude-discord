/**
 * Unit tests for workspace-indicator (§54).
 *
 * Mocks the discord.js channels.fetch surface with an in-memory channel that
 * tracks topic edits + pinned-message send/edit/pin/delete, so we can assert
 * the right branch fires per channel type (guild → topic, DM → pinned).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscordGateway } from '../discord-gateway.ts'
import { RoutingTable } from '../routing.ts'
import {
  applyWorkspaceIndicator,
  clearWorkspaceIndicator,
  INDICATOR_PREFIX,
  reconcileWorkspaceIndicators,
  TOPIC_PREFIX,
} from '../workspace-indicator.ts'

type StoredMsg = { id: string; content: string; author: { id: string } }
type ChannelMock = ReturnType<typeof makeChannelMock>

function makeChannelMock(opts: { dm?: boolean; selfId?: string; topic?: string | null } = {}) {
  const selfId = opts.selfId ?? 'bot-self'
  const stored = new Map<string, StoredMsg>()
  const pinned = new Set<string>()
  const deleted = new Set<string>()
  let topic: string | null = opts.topic ?? null
  let nextId = 1

  const wrapMsg = (m: StoredMsg) => ({
    get id() { return m.id },
    get content() { return m.content },
    get author() { return m.author },
    edit: vi.fn(async (c: string) => { m.content = c }),
    pin: vi.fn(async () => { pinned.add(m.id) }),
    delete: vi.fn(async () => { deleted.add(m.id); pinned.delete(m.id); stored.delete(m.id) }),
  })

  const channel = {
    isDMBased: () => !!opts.dm,
    get topic() { return topic },
    setTopic: vi.fn(async (t: string | null) => { topic = t }),
    send: vi.fn(async (content: string) => {
      const id = `m-${nextId++}`
      const m: StoredMsg = { id, content, author: { id: selfId } }
      stored.set(id, m)
      return wrapMsg(m)
    }),
    messages: {
      fetch: vi.fn(async (id: string) => {
        if (deleted.has(id) || !stored.has(id)) throw new Error(`Unknown Message: ${id}`)
        return wrapMsg(stored.get(id)!)
      }),
      fetchPins: vi.fn(async () => ({
        items: [...pinned]
          .map(id => stored.get(id))
          .filter((m): m is StoredMsg => !!m)
          .map(m => ({ message: wrapMsg(m) })),
      })),
    },
  }

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
    get currentTopic() { return topic },
    get pinnedIds() { return [...pinned] },
    get deletedIds() { return [...deleted] },
    get sentCount() { return channel.send.mock.calls.length },
    get storedById() { return stored },
  }
}

function makeGateway(channelsById: Map<string, ChannelMock>): DiscordGateway {
  const fetch = vi.fn(async (id: string) => channelsById.get(id)?.channel ?? null)
  const selfId = channelsById.size > 0 ? [...channelsById.values()][0]!.selfId : 'bot-self'
  return {
    client: { channels: { fetch }, user: { id: selfId } } as never,
    send: vi.fn(),
    isRecentSent: () => false,
    getDmRecipient: () => null,
    noteDmRecipient: () => {},
    shutdown: async () => {},
  }
}

describe('workspace-indicator', () => {
  let routing: RoutingTable

  beforeEach(() => {
    routing = new RoutingTable(join(mkdtempSync(join(tmpdir(), 'ws-ind-')), 'routing.json'))
  })
  afterEach(() => routing.stopWatching())

  describe('guild channel → topic', () => {
    it('sets the channel topic with our prefix on bind', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock({ dm: false })
      const gw = makeGateway(new Map([['c-1', ch]]))

      await applyWorkspaceIndicator({ gateway: gw, routing }, 'c-1')

      expect(ch.currentTopic).toBe(`${TOPIC_PREFIX}foo`)
      expect(ch.sentCount).toBe(0) // no pinned message on guild
    })

    it('migrates a §53-era pinned message off guild channels (deletes it, then sets topic)', async () => {
      routing.set('c-1', 'foo', 1)
      const ch = makeChannelMock({ dm: false })
      // Simulate §53: a pinned indicator already exists + id recorded
      const oldPin = ch.plantPinned(`${INDICATOR_PREFIX}foo\` · switched <t:1:R>`)
      routing.setIndicatorMessageId('c-1', oldPin)
      const gw = makeGateway(new Map([['c-1', ch]]))

      await applyWorkspaceIndicator({ gateway: gw, routing }, 'c-1')

      expect(ch.deletedIds).toContain(oldPin)
      expect(routing.get('c-1')?.indicator_message_id).toBeUndefined()
      expect(ch.currentTopic).toBe(`${TOPIC_PREFIX}foo`)
    })

    it('clearWorkspaceIndicator clears our topic but leaves a user-set topic', async () => {
      routing.set('c-1', 'foo', 1)
      const ours = makeChannelMock({ dm: false, topic: `${TOPIC_PREFIX}foo` })
      const gwOurs = makeGateway(new Map([['c-1', ours]]))
      await clearWorkspaceIndicator({ gateway: gwOurs, routing }, 'c-1')
      expect(ours.currentTopic).toBeNull()

      routing.set('c-2', 'bar', 1)
      const userSet = makeChannelMock({ dm: false, topic: 'my own topic' })
      const gwUser = makeGateway(new Map([['c-2', userSet]]))
      await clearWorkspaceIndicator({ gateway: gwUser, routing }, 'c-2')
      expect(userSet.currentTopic).toBe('my own topic') // untouched
    })
  })

  describe('DM channel → pinned message', () => {
    it('sends + pins on bind and stores the id', async () => {
      routing.set('d-1', 'foo', 1700000000_000)
      const ch = makeChannelMock({ dm: true })
      const gw = makeGateway(new Map([['d-1', ch]]))

      await applyWorkspaceIndicator({ gateway: gw, routing }, 'd-1')

      expect(ch.sentCount).toBe(1)
      expect(ch.channel.send.mock.calls[0]![0]).toContain('foo')
      expect(ch.pinnedIds).toHaveLength(1)
      expect(routing.get('d-1')?.indicator_message_id).toBe(ch.pinnedIds[0])
      expect(ch.channel.setTopic).not.toHaveBeenCalled() // DM never sets topic
    })

    it('edits the same pinned message on switch', async () => {
      routing.set('d-1', 'foo', 1)
      const ch = makeChannelMock({ dm: true })
      const gw = makeGateway(new Map([['d-1', ch]]))
      await applyWorkspaceIndicator({ gateway: gw, routing }, 'd-1')
      const id = routing.get('d-1')?.indicator_message_id

      routing.set('d-1', 'bar', 2)
      await applyWorkspaceIndicator({ gateway: gw, routing }, 'd-1')

      expect(routing.get('d-1')?.indicator_message_id).toBe(id)
      expect(ch.sentCount).toBe(1) // edited, not re-sent
      expect(ch.storedById.get(id!)?.content).toContain('bar')
    })

    it('reuses a prior pinned indicator via fetchPins when stored id is missing', async () => {
      routing.set('d-1', 'foo', 1)
      const ch = makeChannelMock({ dm: true })
      const planted = ch.plantPinned(`${INDICATOR_PREFIX}old\` · switched <t:1:R>`)
      const gw = makeGateway(new Map([['d-1', ch]]))

      await applyWorkspaceIndicator({ gateway: gw, routing }, 'd-1')

      expect(ch.sentCount).toBe(0)
      expect(routing.get('d-1')?.indicator_message_id).toBe(planted)
      expect(ch.storedById.get(planted)?.content).toContain('foo')
    })

    it('clearWorkspaceIndicator deletes the DM pin and clears the id', async () => {
      routing.set('d-1', 'foo', 1)
      const ch = makeChannelMock({ dm: true })
      const gw = makeGateway(new Map([['d-1', ch]]))
      await applyWorkspaceIndicator({ gateway: gw, routing }, 'd-1')
      const id = routing.get('d-1')?.indicator_message_id!

      await clearWorkspaceIndicator({ gateway: gw, routing }, 'd-1')

      expect(ch.deletedIds).toContain(id)
      expect(routing.get('d-1')?.indicator_message_id).toBeUndefined()
    })
  })

  describe('no-ops / safety', () => {
    it('does nothing when channel has no routing entry', async () => {
      const ch = makeChannelMock({ dm: false })
      const gw = makeGateway(new Map([['c-1', ch]]))
      await applyWorkspaceIndicator({ gateway: gw, routing }, 'c-1')
      expect(ch.channel.setTopic).not.toHaveBeenCalled()
      expect(ch.sentCount).toBe(0)
    })

    it('does nothing when channel fetch returns null', async () => {
      routing.set('c-1', 'foo', 1)
      const gw = makeGateway(new Map()) // fetch → null
      await expect(applyWorkspaceIndicator({ gateway: gw, routing }, 'c-1')).resolves.toBeUndefined()
    })
  })

  describe('reconcileWorkspaceIndicators', () => {
    it('routes each channel by type (guild→topic, DM→pin)', async () => {
      routing.set('c-1', 'foo', 1) // guild
      routing.set('d-1', 'bar', 2) // dm
      const guild = makeChannelMock({ dm: false })
      const dm = makeChannelMock({ dm: true })
      const gw = makeGateway(new Map([['c-1', guild], ['d-1', dm]]))

      await reconcileWorkspaceIndicators({ gateway: gw, routing })

      expect(guild.currentTopic).toBe(`${TOPIC_PREFIX}foo`)
      expect(dm.pinnedIds).toHaveLength(1)
    })

    it('one channel failure does not break the rest', async () => {
      routing.set('c-1', 'foo', 1)
      routing.set('c-2', 'bar', 2)
      const bad = makeChannelMock({ dm: false })
      bad.channel.setTopic = vi.fn(async () => { throw new Error('boom') }) as never
      const good = makeChannelMock({ dm: false })
      const gw = makeGateway(new Map([['c-1', bad], ['c-2', good]]))

      await reconcileWorkspaceIndicators({ gateway: gw, routing })

      expect(good.currentTopic).toBe(`${TOPIC_PREFIX}bar`)
    })
  })
})
