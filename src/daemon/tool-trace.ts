/**
 * Architecture deltas §24: PostToolUse hook → daemon → per-turn Discord
 * thread. Forwards every CC tool invocation (input + response) to a thread
 * attached to the current turn's reply, so the user can audit the full tool
 * chain without polluting the main channel timeline.
 *
 * Per-turn behavior:
 *   - inbound-router resets `activeTraceThreadId` on each new inbound
 *   - first cc_tool_trace after that creates a new thread (named after the
 *     inbound preview) under the parent channel, caches its id on the conn
 *   - subsequent traces in the same turn reuse the cached thread
 *   - DM channels don't support threads → drop the trace silently
 */

import { ChannelType, EmbedBuilder } from 'discord.js'
import type { CcToolTraceMsg } from '../protocol/schema.ts'
import { log } from '../shared/logger.ts'
import type { Connection } from './connection.ts'
import type { DiscordGateway } from './discord-gateway.ts'
import type { WorkspaceRegistry } from './registry.ts'

const EMBED_DESC_MAX = 4000 // Discord embed.description hard limit is 4096
const THREAD_AUTO_ARCHIVE_MIN = 60

export class ToolTraceRelay {
  constructor(
    private readonly gateway: DiscordGateway,
    private readonly registry: WorkspaceRegistry,
  ) {}

  async handle(msg: CcToolTraceMsg): Promise<void> {
    const conn = this.findConnection(msg.cwd)
    if (!conn) {
      log.debug(`cc_tool_trace: no workspace conn for cwd=${msg.cwd ?? '<none>'} — dropping`)
      return
    }
    const parentChatId = conn.lastInboundChatId
    if (!parentChatId) {
      log.debug(`cc_tool_trace: workspace ${conn.workspace} has no lastInboundChatId — dropping`)
      return
    }

    let threadId = conn.activeTraceThreadId
    if (!threadId) {
      threadId = await this.openTraceThread(conn, parentChatId)
      if (!threadId) return
      conn.activeTraceThreadId = threadId
    }

    await this.postTraceEmbed(threadId, msg)
  }

  private findConnection(cwd?: string): Connection | null {
    if (!cwd) return null
    // Same cwd can host multiple workspaces (auto-suffix on collision — e.g.
    // free-research + free-research-2 from two CCs opened in the same dir).
    // Prefer the one that has received an inbound (= the one actually bound
    // to a Discord channel); fall back to the first match if none has.
    let fallback: Connection | null = null
    for (const c of this.registry.list()) {
      if (c.cwd !== cwd) continue
      if (c.lastInboundChatId) return c
      fallback ??= c
    }
    return fallback
  }

  private async openTraceThread(conn: Connection, parentChatId: string): Promise<string | null> {
    try {
      const ch = await this.gateway.client.channels.fetch(parentChatId)
      if (!ch) return null
      // DM (and group DM) channels don't support threads — drop the trace.
      if (ch.type === ChannelType.DM || ch.type === ChannelType.GroupDM) {
        log.debug(`cc_tool_trace: parent ${parentChatId} is DM — no thread support, dropping`)
        return null
      }
      if (!('threads' in ch) || !(ch as { threads?: unknown }).threads) {
        log.debug(`cc_tool_trace: parent ${parentChatId} cannot host threads`)
        return null
      }
      const preview = (conn.lastInboundPreview ?? 'trace').trim() || 'trace'
      const name = `trace · ${preview}`.slice(0, 100)
      const threads = (ch as unknown as {
        threads: {
          create: (opts: { name: string; autoArchiveDuration: number }) => Promise<{ id: string }>
        }
      }).threads
      const thread = await threads.create({
        name,
        autoArchiveDuration: THREAD_AUTO_ARCHIVE_MIN,
      })
      return thread.id
    } catch (e) {
      log.warn(`cc_tool_trace: open thread failed for ${parentChatId}: ${e}`)
      return null
    }
  }

  private async postTraceEmbed(threadId: string, msg: CcToolTraceMsg): Promise<void> {
    try {
      const thread = await this.gateway.client.channels.fetch(threadId)
      if (!thread || !('send' in thread)) {
        log.warn(`cc_tool_trace: thread ${threadId} unfetchable or not text-based`)
        return
      }
      const icon = msg.status === 'error' ? '❌' : '🔧'
      const embed = new EmbedBuilder()
        .setTitle(`${icon} ${msg.tool_name}`)
        .setDescription(formatBody(msg))
        .setColor(msg.status === 'error' ? 0xed4245 : 0x5865f2)
        .setFooter({ text: new Date().toISOString() })
      await (thread as unknown as { send: (o: { embeds: unknown[] }) => Promise<unknown> }).send({
        embeds: [embed],
      })
    } catch (e) {
      log.warn(`cc_tool_trace: post embed to ${threadId} failed: ${e}`)
    }
  }
}

/**
 * Render input + output into a single embed description. Each side is already
 * truncated at the hook (1800 chars), but Discord's hard cap is 4096 across
 * the whole description — so we additionally trim the joined body if needed.
 */
export function formatBody(msg: CcToolTraceMsg): string {
  const body =
    '**Input**\n' +
    '```json\n' +
    msg.tool_input +
    '\n```\n' +
    '**Output**\n' +
    '```\n' +
    msg.tool_response +
    '\n```'
  if (body.length <= EMBED_DESC_MAX) return body
  const overflow = body.length - EMBED_DESC_MAX
  return body.slice(0, EMBED_DESC_MAX - 40) + `\n…(truncated ${overflow} chars)`
}
