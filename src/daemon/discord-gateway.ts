/**
 * discord.js wrapper. Owns the gateway connection.
 *
 * Responsibilities:
 *   - Load `DISCORD_BOT_TOKEN` from `.env` (sync, simple parser)
 *   - Configure intents (DirectMessages + Guilds + GuildMessages + MessageContent)
 *     and Partials.Channel (DM channels arrive as partial — without this
 *     `messageCreate` never fires for DMs, an upstream-known footgun)
 *   - Track recently sent message ids so guild reply-to-bot counts as a
 *     mention (matches upstream's recentSentIds + dmChannelUsers)
 *   - Expose `send(channelId, content)` for "Paired!" replies and inbound
 *     pairing-code replies
 *
 * Caller wires the messageCreate listener after construction (to avoid
 * placeholder/replace dance during daemon startup).
 */

import { chmodSync, existsSync, readFileSync } from 'node:fs'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js'
import { log } from '../shared/logger.ts'
import type { Paths } from '../shared/paths.ts'

const RECENT_SENT_CAP = 200

export type DiscordGateway = {
  client: Client
  /** Send a plain text reply (caller has already passed access gates). */
  send(channelId: string, content: string): Promise<{ id: string } | null>
  /** Did we recently send a message with this id? Used by mention detection. */
  isRecentSent(id: string): boolean
  /** Look up DM channel → user mapping (populated as DMs arrive). */
  getDmRecipient(channelId: string): string | null
  /** Note that a DM channel maps to a user (called from message handler). */
  noteDmRecipient(channelId: string, userId: string): void
  /** Stop the client and wait briefly for graceful disconnect. */
  shutdown(): Promise<void>
}

/**
 * Parse a simple KEY=VALUE .env into a flat map. Real env wins.
 */
function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return
  try {
    chmodSync(envPath, 0o600)
  } catch {}
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) {
      process.env[m[1]!] = m[2]
    }
  }
}

/**
 * Optional client factory — used by tests to inject a mock discord.js Client.
 * Production callers omit this and get the real Client.
 *
 * The factory is also responsible for a non-default token: when the factory
 * is provided, we don't load .env or read DISCORD_BOT_TOKEN (the mock
 * doesn't authenticate against real Discord).
 */
export type ClientFactory = () => Client

export async function startDiscordGateway(
  paths: Paths,
  factory?: ClientFactory,
): Promise<DiscordGateway | null> {
  let client: Client
  if (factory) {
    client = factory()
  } else {
    loadEnvFile(paths.envFile)
    const token = process.env.DISCORD_BOT_TOKEN
    if (!token) {
      log.error(`DISCORD_BOT_TOKEN missing — set in ${paths.envFile} or shell env`)
      return null
    }
    client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    })
  }

  const recentSent = new Set<string>()
  const dmChannelUsers = new Map<string, string>()

  client.on('error', err => log.warn(`discord client error: ${err}`))
  // discord.js 14 deprecated 'ready' in favor of 'clientReady' (effective in v15).
  client.once('clientReady', c => log.info(`discord gateway connected as ${c.user.tag}`))

  // NFR-2 / NFR-4: surface 429 rate-limit events. discord.js REST handles
  // retry/queue internally; this listener is observation only — no action.
  // Mock clients in tests don't have a `rest` manager — skip when absent.
  if (client.rest) {
    client.rest.on('rateLimited', info => {
      log.warn(
        `discord rate limit hit: route=${info.route} method=${info.method} ` +
        `timeToReset=${info.timeToReset}ms global=${info.global ?? false}`,
      )
    })
  }

  if (!factory) {
    // Real Discord — actually log in. Mock factory pre-emits clientReady on its own.
    await client.login(process.env.DISCORD_BOT_TOKEN)
  }

  const noteSent = (id: string): void => {
    recentSent.add(id)
    if (recentSent.size > RECENT_SENT_CAP) {
      const first = recentSent.values().next().value
      if (first) recentSent.delete(first)
    }
  }

  return {
    client,
    async send(channelId: string, content: string) {
      try {
        const ch = await client.channels.fetch(channelId)
        if (!ch || !ch.isTextBased() || !('send' in ch)) {
          log.warn(`send: channel ${channelId} not text-based`)
          return null
        }
        const sent = await ch.send(content)
        noteSent(sent.id)
        return { id: sent.id }
      } catch (e) {
        log.warn(`send to ${channelId} failed: ${e}`)
        return null
      }
    },
    isRecentSent: (id: string) => recentSent.has(id),
    getDmRecipient: (channelId: string) => dmChannelUsers.get(channelId) ?? null,
    noteDmRecipient: (channelId: string, userId: string) => {
      dmChannelUsers.set(channelId, userId)
    },
    async shutdown() {
      try {
        // Race destroy() against a 2s timeout, but unref the timer so it
        // doesn't keep the process alive after destroy() resolves.
        // (BH-4 in docs/reviews/code-review-mvp.md.)
        await Promise.race([
          client.destroy(),
          new Promise<void>(r => {
            const t = setTimeout(r, 2_000)
            t.unref()
          }),
        ])
      } catch (e) {
        log.warn(`gateway shutdown: ${e}`)
      }
    },
  }
}

export { ChannelType }
export type { Message }
