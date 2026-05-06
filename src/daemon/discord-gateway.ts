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

export async function startDiscordGateway(paths: Paths): Promise<DiscordGateway | null> {
  loadEnvFile(paths.envFile)

  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) {
    log.error(`DISCORD_BOT_TOKEN missing — set in ${paths.envFile} or shell env`)
    return null
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })

  const recentSent = new Set<string>()
  const dmChannelUsers = new Map<string, string>()

  client.on('error', err => log.warn(`discord client error: ${err}`))
  client.once('ready', c => log.info(`discord gateway connected as ${c.user.tag}`))

  await client.login(token)

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
        await Promise.race([
          client.destroy(),
          new Promise<void>(r => setTimeout(r, 2_000)),
        ])
      } catch (e) {
        log.warn(`gateway shutdown: ${e}`)
      }
    },
  }
}

export { ChannelType }
export type { Message }
