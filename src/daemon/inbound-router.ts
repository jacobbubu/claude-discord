/**
 * Inbound router: Discord message → access gate → routing lookup → push to
 * the right plugin via NDJSON `inbound`.
 *
 * Slice 3 fallback: if a DM channel has no routing.json entry but the sender
 * is in `allowFrom`, route to the most recently registered workspace. This
 * lets users get going before slice 4's `/use` slash command exists. With no
 * registered workspace, we reply "no workspace online".
 */

import { ChannelType, type Message } from 'discord.js'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import { log } from '../shared/logger.ts'
import {
  gate,
  matchesMentionPattern,
  pruneExpired,
  readAccessFile,
  writeAccessFile,
  type Access,
  type GateInput,
} from './access-control.ts'
import type { DiscordGateway } from './discord-gateway.ts'
import type { WorkspaceRegistry } from './registry.ts'
import type { RoutingTable } from './routing.ts'

export type InboundRouterDeps = {
  accessFile: string
  gateway: DiscordGateway
  registry: WorkspaceRegistry
  routing: RoutingTable
}

export function makeInboundHandler(deps: InboundRouterDeps): (msg: Message) => void {
  return msg => {
    void handle(deps, msg).catch(e => log.warn(`inbound-router: ${e}`))
  }
}

async function handle(deps: InboundRouterDeps, msg: Message): Promise<void> {
  // Hot read access.json on every message (matches upstream behavior).
  const access = readAccessFile(deps.accessFile)
  if (pruneExpired(access)) writeAccessFile(deps.accessFile, access)

  const isDM = msg.channel.type === ChannelType.DM
  const guildChannelKey = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId

  const isMentioned = computeIsMentioned(msg, access, deps.gateway)

  const input: GateInput = {
    isDM,
    senderId: msg.author.id,
    channelId: msg.channelId,
    dmChannelId: msg.channelId,
    guildChannelKey,
    isMentioned,
  }

  const decision = gate(access, input)

  if (decision.action === 'drop') return

  if (decision.action === 'pair') {
    // gate() may have mutated pending — persist that.
    writeAccessFile(deps.accessFile, access)
    const lead = decision.isResend ? 'Still pending' : 'Pairing required'
    await deps.gateway.send(
      msg.channelId,
      `${lead} — run in your terminal:\n\nclaude-discord-bot pair ${decision.code}`,
    )
    return
  }

  // deliver — find target workspace
  const route = deps.routing.get(msg.channelId)
  let workspace = route?.workspace ?? null

  if (!workspace) {
    // Slice 3 fallback: pick most-recently-registered active workspace
    const live = deps.registry.list()
    workspace = live.length > 0 ? live[live.length - 1]!.workspace : null
  }

  if (!workspace) {
    await deps.gateway.send(msg.channelId, 'no workspace online — start one with `claude --channels plugin:claude-discord` from a project directory')
    return
  }

  const conn = deps.registry.get(workspace)
  if (!conn) {
    await deps.gateway.send(
      msg.channelId,
      `${workspace} is currently offline — please start CC for that workspace`,
    )
    return
  }

  conn.send({
    type: 'inbound',
    v: PROTOCOL_VERSION,
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
    content: msg.content,
    ...(msg.attachments.size > 0
      ? {
          attachments: [...msg.attachments.values()].map(a => ({
            name: a.name ?? a.id,
            contentType: a.contentType ?? undefined,
            size: a.size,
          })),
        }
      : {}),
  })
}

function computeIsMentioned(msg: Message, access: Access, gateway: DiscordGateway): boolean {
  // 1. Structured @bot mention
  const me = msg.client.user
  if (me && msg.mentions.has(me)) return true

  // 2. Reply to one of bot's recent sent messages (covered without fetchReference)
  const refId = msg.reference?.messageId
  if (refId && gateway.isRecentSent(refId)) return true

  // 3. Regex match against mentionPatterns
  if (matchesMentionPattern(msg.content, access.mentionPatterns)) return true

  return false
}
