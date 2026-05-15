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
import type { RingBufferMap } from './ring-buffer.ts'
import type { RoutingTable } from './routing.ts'
import type { TypingHeartbeat } from './typing-heartbeat.ts'

export type InboundRouterDeps = {
  accessFile: string
  gateway: DiscordGateway
  registry: WorkspaceRegistry
  routing: RoutingTable
  ringBuffers: RingBufferMap
  /**
   * Optional intercept for permission Q&A text replies (`yes XXXXX` / `no XXXXX`).
   * Returns true if the text was consumed as a permission response — the
   * router then drops the message without going through the access gate.
   * Caller (permission-relay) is responsible for verifying sender is in
   * allowFrom before claiming the message.
   */
  permissionTextIntercept?: (senderId: string, text: string) => boolean
  /**
   * §33: when provided, the router starts a typing-indicator heartbeat for
   * the source channel on each inbound. Tool handlers stop it when CC replies.
   * Backward compat: when omitted, falls back to a single sendTyping() (old
   * behavior — Discord auto-decays the dot after ~10s).
   */
  typingHeartbeat?: TypingHeartbeat
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

  // Permission Q&A text intercept — runs BEFORE gate so already-allowed users
  // can answer with `yes XXXXX` / `no XXXXX` without their reply being routed
  // to a workspace as chat. The intercept itself checks allowFrom.
  if (deps.permissionTextIntercept?.(msg.author.id, msg.content)) {
    void msg
      .react(msg.content.toLowerCase().includes('yes') ? '✅' : '❌')
      .catch(() => {})
    return
  }

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
  const workspace = route?.workspace ?? null

  if (!workspace) {
    // Architecture deltas §13: removed silent fallback to most-recent
    // workspace. Pre-#45 console-only CCs polluted the registry, so
    // fallback often hit the wrong CC. Now explicit binding required —
    // user must `/use` first, or the daemon prompts them with a hint.
    const live = deps.registry.list()
    if (live.length === 0) {
      await deps.gateway.send(
        msg.channelId,
        'no workspace online — start one with `claude --channels plugin:claude-discord@<marketplace>` from a project directory',
      )
    } else {
      const names = live.map(c => c.workspace).filter(Boolean).slice(0, 5).join(', ')
      await deps.gateway.send(
        msg.channelId,
        `this channel has no workspace bound. run \`/use <workspace>\` to bind. active workspaces: ${names}${live.length > 5 ? ', ...' : ''}`,
      )
    }
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

  // Architecture deltas §35: enter the 'active' turn state. This also takes
  // care of the §16 lastInboundChatId + §27 lastInboundTs fields kept for
  // back-compat with isInboundFresh() callers.
  conn.startTurn(msg.channelId)
  // Architecture deltas §24: store a short content preview for trace-thread
  // naming, and reset the per-turn active trace thread so the next
  // PostToolUse fire starts a fresh thread under this turn's reply.
  conn.lastInboundPreview = msg.content.slice(0, 40)
  conn.activeTraceThreadId = null

  // UX: tell the user we're processing. §33: when a TypingHeartbeat is
  // wired, keep the indicator alive across the whole CC turn (re-typing
  // every ~8s) so long tasks don't look hung — stopped by reply/edit/thread
  // tool handlers. Without one, fall back to a single sendTyping (~10s decay).
  if (deps.typingHeartbeat) {
    deps.typingHeartbeat.start(msg.channelId, conn.workspace ?? undefined)
  } else if ('sendTyping' in msg.channel) {
    void (msg.channel as { sendTyping: () => Promise<void> })
      .sendTyping()
      .catch(() => {})
  }

  // UX: optional ack reaction (e.g. 👀 / 🔨). Set via
  // `claude-discord-bot set ackReaction <emoji>`; empty string disables.
  if (access.ackReaction) {
    void msg.react(access.ackReaction).catch(() => {})
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

  // Track inbound message in workspace's ring buffer for /recent.
  deps.ringBuffers.for(workspace).push({
    channelId: msg.channelId,
    direction: 'in',
    text: msg.content || '(attachment)',
    ts: msg.createdAt.getTime(),
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
