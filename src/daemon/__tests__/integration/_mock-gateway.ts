/**
 * Test-only fakes for daemon-side integration tests.
 *
 * NOT a fully-faithful discord.js Client mock. Just enough surface for:
 *   - inbound-router (client.user, mentions.has)
 *   - tool dispatchers (channel.send / fetch)
 *   - approval-watcher (gateway.send)
 *
 * Use in isolated tests; for full e2e coverage use the live-test suite
 * (which requires a real Discord token).
 */

import { ChannelType } from 'discord.js'
import type { DiscordGateway } from '../../discord-gateway.ts'

let nextMessageId = 100

export type SentMessage = { channelId: string; content: string }

export type MockGateway = DiscordGateway & {
  sentMessages: SentMessage[]
}

export function makeMockGateway(): MockGateway {
  const sentMessages: SentMessage[] = []
  const recentSent = new Set<string>()
  const dmRecipients = new Map<string, string>()
  const noteSent = (id: string) => recentSent.add(id)

  const fakeClient = {
    user: { id: 'BOT_USER', tag: 'mock-bot#0000' },
    channels: {
      fetch: async (_id: string) => null,
    },
    guilds: { cache: new Map() },
  } as unknown as DiscordGateway['client']

  return {
    client: fakeClient,
    sentMessages,
    async send(channelId: string, content: string) {
      const id = `msg-${nextMessageId++}`
      sentMessages.push({ channelId, content })
      noteSent(id)
      return { id }
    },
    isRecentSent: (id: string) => recentSent.has(id),
    getDmRecipient: (channelId: string) => dmRecipients.get(channelId) ?? null,
    noteDmRecipient: (channelId: string, userId: string) => {
      dmRecipients.set(channelId, userId)
    },
    async shutdown() {
      /* noop */
    },
  }
}

/**
 * Minimal Message-like object accepted by inbound-router. Marks itself as
 * a DM by default; override `channel.type` for guild scenarios.
 */
export function makeFakeMessage(opts: {
  channelId: string
  authorId: string
  authorName?: string
  content?: string
  isDM?: boolean
  parentId?: string
  isThread?: boolean
  mentionsBot?: boolean
  referenceMessageId?: string
  attachments?: Array<{ id: string; name?: string; contentType?: string; size: number }>
}): {
  id: string
  channelId: string
  author: { id: string; username: string; bot: boolean }
  channel: {
    type: ChannelType
    isThread: () => boolean
    parentId: string | null
  }
  createdAt: Date
  content: string
  attachments: Map<string, { id: string; name?: string; contentType?: string; size: number }>
  mentions: { has: (u: { id: string }) => boolean }
  reference: { messageId?: string } | null
  client: { user: { id: string } }
} {
  const id = `msg-in-${nextMessageId++}`
  const isDM = opts.isDM ?? true
  const attsArr = opts.attachments ?? []
  const attMap = new Map(attsArr.map(a => [a.id, a]))
  return {
    id,
    channelId: opts.channelId,
    author: {
      id: opts.authorId,
      username: opts.authorName ?? opts.authorId,
      bot: false,
    },
    channel: {
      type: isDM ? ChannelType.DM : ChannelType.GuildText,
      isThread: () => opts.isThread ?? false,
      parentId: opts.parentId ?? null,
    },
    createdAt: new Date(),
    content: opts.content ?? '',
    attachments: attMap,
    mentions: {
      has: (u: { id: string }) => Boolean(opts.mentionsBot && u.id === 'BOT_USER'),
    },
    reference: opts.referenceMessageId ? { messageId: opts.referenceMessageId } : null,
    client: { user: { id: 'BOT_USER' } },
  }
}
