/**
 * Full-fidelity discord.js Client mock for controlled e2e tests (#22).
 *
 * Implements only the surface our daemon actually uses, but at high fidelity:
 *   - message_id auto-increment
 *   - reactions Map per message
 *   - channel.threads
 *   - DM and GuildText channels with distinct semantics
 *   - User.send for permission DMs
 *   - Interaction injection for slash commands + buttons
 *
 * The mock is a single test harness exposing both the "Discord client" view
 * (passed into startDiscordGateway as factory) and the "test driver" view
 * (injectMessage / injectButton / sentMessages capture).
 */

import { EventEmitter } from 'node:events'
import { ChannelType } from 'discord.js'

// Per-instance message id counter — accessed via `client.nextMessageId++`.
// Module-level state would leak across tests in the same file.
const seq = (client: MockClient) => `m-${client.nextMessageId++}`

export type MockMessage = {
  id: string
  channelId: string
  channel: MockChannel
  author: { id: string; username: string; bot: boolean; tag: string }
  content: string
  /** §32: captured discord.js embeds (typed as unknown[] — tests cast to JSON shape). */
  embeds: unknown[]
  attachments: Map<string, { id: string; name?: string; size: number; contentType?: string; url?: string }>
  reactions: Map<string, Set<string>>
  reference: { messageId?: string } | null
  createdAt: Date
  client: MockClient
  mentions: { has: (u: { id: string }) => boolean }
  react: (emoji: string) => Promise<void>
  edit: (text: string) => Promise<MockMessage>
  reply: (opts: { content: string }) => Promise<MockMessage>
  fetchReference: () => Promise<MockMessage>
  startThread: (opts: { name: string }) => Promise<MockChannel>
}

type SendOpts = {
  content?: string
  files?: unknown[]
  reply?: { messageReference?: string }
  components?: unknown[]
  /** §32: embeds sent via discord.js EmbedBuilder; mock records them verbatim. */
  embeds?: unknown[]
}

export type MockChannel = {
  id: string
  type: ChannelType
  isTextBased: () => boolean
  isThread: () => boolean
  parentId?: string | null
  recipientId?: string  // DM only
  recipient?: { id: string; username: string }
  topic?: string
  setTopic?: (s: string) => Promise<void>
  send: (textOrOpts: string | SendOpts) => Promise<MockMessage>
  sendTyping?: () => Promise<void>
  messages: {
    fetch: ((idOrOpts: string | { limit?: number }) => Promise<MockMessage | Map<string, MockMessage>>) & {
      // for the limit form returning Map<string, MockMessage>
    }
  }
  threads?: {
    create: (opts: { name: string; startMessage?: string }) => Promise<MockChannel>
  }
  /** Test introspection: history of messages in this channel */
  history: MockMessage[]
}

export type MockUser = {
  id: string
  tag: string
  username: string
  send: (opts: { content?: string; components?: unknown[] }) => Promise<MockMessage>
  /** Test introspection: DM messages we sent to this user */
  dmHistory: MockMessage[]
}

const makeMessage = (
  channel: MockChannel,
  author: MockMessage['author'],
  content: string,
  client: MockClient,
  reference?: { messageId?: string },
  embeds: unknown[] = [],
): MockMessage => {
  const msg: MockMessage = {
    id: seq(client),
    channelId: channel.id,
    channel,
    author,
    content,
    embeds,
    attachments: new Map(),
    reactions: new Map(),
    reference: reference ?? null,
    createdAt: new Date(),
    client,
    mentions: {
      has: (u: { id: string }) => content.includes(`<@${u.id}>`) || content.includes(`<@!${u.id}>`),
    },
    async react(emoji: string) {
      let bag = msg.reactions.get(emoji)
      if (!bag) {
        bag = new Set()
        msg.reactions.set(emoji, bag)
      }
      bag.add(client.user!.id)
    },
    async edit(text: string) {
      msg.content = text
      return msg
    },
    async reply(opts: { content: string }) {
      const replyMsg = makeMessage(channel, client.user as never, opts.content, client, { messageId: msg.id })
      channel.history.push(replyMsg)
      return replyMsg
    },
    async fetchReference() {
      const refId = msg.reference?.messageId
      if (!refId) throw new Error('no reference')
      const found = channel.history.find(m => m.id === refId)
      if (!found) throw new Error('reference not found')
      return found
    },
    async startThread(opts: { name: string }) {
      const thread = makeChannel(`thread-${seq(client)}`, ChannelType.PublicThread, client, { parentId: channel.id })
      thread.threads = undefined  // threads of threads not supported
      return thread
    },
  }
  return msg
}

const makeChannel = (
  id: string,
  type: ChannelType,
  client: MockClient,
  extra: { parentId?: string | null; recipientId?: string; recipient?: { id: string; username: string } } = {},
): MockChannel => {
  const ch: MockChannel = {
    id,
    type,
    parentId: extra.parentId ?? null,
    recipientId: extra.recipientId,
    recipient: extra.recipient,
    topic: undefined,
    history: [],
    isTextBased: () =>
      type === ChannelType.DM ||
      type === ChannelType.GuildText ||
      type === ChannelType.PublicThread ||
      type === ChannelType.PrivateThread,
    isThread: () => type === ChannelType.PublicThread || type === ChannelType.PrivateThread,
    async setTopic(s: string) {
      ch.topic = s
    },
    async sendTyping() {
      /* noop for mock */
    },
    async send(arg: string | SendOpts) {
      const opts: SendOpts = typeof arg === 'string' ? { content: arg } : arg
      const msg = makeMessage(
        ch,
        { id: client.user!.id, username: client.user!.username, bot: true, tag: client.user!.tag },
        opts.content ?? '',
        client,
        opts.reply?.messageReference ? { messageId: opts.reply.messageReference } : undefined,
        opts.embeds,
      )
      ch.history.push(msg)
      return msg
    },
    messages: {
      async fetch(arg: string | { limit?: number }) {
        if (typeof arg === 'string') {
          const found = ch.history.find(m => m.id === arg)
          if (!found) throw new Error(`message ${arg} not found`)
          return found
        }
        const limit = arg.limit ?? 50
        const slice = ch.history.slice(-limit)
        const map = new Map<string, MockMessage>()
        for (const m of slice) map.set(m.id, m)
        return map
      },
    },
    threads: type === ChannelType.GuildText
      ? {
          async create(opts: { name: string; startMessage?: string }) {
            const t = makeChannel(`thread-${seq(client)}`, ChannelType.PublicThread, client, { parentId: ch.id })
            return t
          },
        }
      : undefined,
  }
  return ch
}

export class MockClient extends EventEmitter {
  user: { id: string; username: string; tag: string } | null = null
  channels = {
    fetch: async (id: string) => {
      const ch = this.allChannels.get(id)
      if (!ch) throw new Error(`channel ${id} not found in mock`)
      return ch
    },
  }
  users = {
    fetch: async (id: string) => {
      let u = this.allUsers.get(id)
      if (!u) {
        u = makeUser(id, `user-${id.slice(-4)}`, this)
        this.allUsers.set(id, u)
      }
      return u
    },
  }
  guilds = {
    cache: new Map<string, { id: string; name: string }>(),
  }
  application: { id: string } | null = null

  /** Test-side introspection: every channel ever created. */
  readonly allChannels = new Map<string, MockChannel>()
  readonly allUsers = new Map<string, MockUser>()
  /** Auto-incrementing message id seed — fresh per MockClient instance. */
  nextMessageId = 1_000

  /**
   * Construct a DM channel between the bot and a given user. Returns the
   * channel (registered) and the user.
   */
  ensureDmChannel(userId: string, username = `user-${userId.slice(-4)}`): {
    channel: MockChannel
    user: MockUser
  } {
    const channelId = `dm-${userId}`
    let channel = this.allChannels.get(channelId)
    if (!channel) {
      channel = makeChannel(channelId, ChannelType.DM, this, {
        recipientId: userId,
        recipient: { id: userId, username },
      })
      this.allChannels.set(channelId, channel)
    }
    let user = this.allUsers.get(userId)
    if (!user) {
      user = makeUser(userId, username, this)
      this.allUsers.set(userId, user)
    }
    return { channel, user }
  }

  /** Construct a guild text channel. */
  ensureGuildChannel(guildId: string, channelId: string, name = 'general'): MockChannel {
    if (!this.guilds.cache.has(guildId)) {
      this.guilds.cache.set(guildId, { id: guildId, name: `guild-${guildId.slice(-4)}` })
    }
    let ch = this.allChannels.get(channelId)
    if (!ch) {
      ch = makeChannel(channelId, ChannelType.GuildText, this)
      this.allChannels.set(channelId, ch)
    }
    return ch
  }

  /**
   * Mock login — sets bot user and emits clientReady. The real Client.login
   * is async but our test-driven version is synchronous-after-event-loop.
   */
  async login(): Promise<string> {
    this.user = { id: 'BOT_USER', username: 'mock-bot', tag: 'mock-bot#0000' }
    this.application = { id: 'APP_BOT' }
    // Defer to next tick so subscribers can register first.
    setImmediate(() => this.emit('clientReady', this))
    return 'mock-token'
  }

  async destroy(): Promise<void> {
    this.removeAllListeners()
  }

  /**
   * Test driver: simulate a Discord user sending a message in a channel.
   * Triggers `messageCreate` event which the daemon's inbound-router handles.
   */
  injectMessage(opts: {
    userId: string
    username?: string
    channelId?: string  // if omitted, uses DM channel auto-created for userId
    content: string
    isDM?: boolean
    referenceMessageId?: string
    attachments?: Array<{ id: string; name?: string; size: number; contentType?: string; url?: string }>
  }): MockMessage {
    let channel: MockChannel
    if (opts.isDM !== false && !opts.channelId) {
      ({ channel } = this.ensureDmChannel(opts.userId, opts.username))
    } else if (opts.channelId) {
      channel = this.allChannels.get(opts.channelId) ?? makeChannel(opts.channelId, ChannelType.GuildText, this)
      this.allChannels.set(channel.id, channel)
    } else {
      throw new Error('injectMessage: need channelId or isDM=true with userId')
    }
    const author: MockMessage['author'] = {
      id: opts.userId,
      username: opts.username ?? `user-${opts.userId.slice(-4)}`,
      bot: false,
      tag: `${opts.username ?? opts.userId}#0000`,
    }
    const msg = makeMessage(channel, author, opts.content, this, opts.referenceMessageId ? { messageId: opts.referenceMessageId } : undefined)
    if (opts.attachments) {
      for (const a of opts.attachments) msg.attachments.set(a.id, a)
    }
    channel.history.push(msg)
    this.emit('messageCreate', msg)
    return msg
  }
}

const makeUser = (id: string, username: string, client: MockClient): MockUser => {
  const dmHistory: MockMessage[] = []
  return {
    id,
    username,
    tag: `${username}#0000`,
    async send(opts: { content?: string; components?: unknown[]; embeds?: unknown[] }) {
      const { channel } = client.ensureDmChannel(id, username)
      const msg = makeMessage(
        channel,
        {
          id: client.user!.id,
          username: client.user!.username,
          bot: true,
          tag: client.user!.tag,
        },
        opts.content ?? '',
        client,
        undefined,
        opts.embeds,
      )
      channel.history.push(msg)
      dmHistory.push(msg)
      return msg
    },
    dmHistory,
  }
}
