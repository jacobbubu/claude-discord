/**
 * MCP server side of the plugin (towards CC).
 *
 * Registers the 5 tool definitions and forwards tool calls to the
 * ToolBridge → daemon. Inbound notifications from daemon are pushed
 * back to CC as `notifications/claude/channel`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import type { InboundMsg, ToolResultMsg } from '../protocol/schema.ts'

/**
 * §32 + §42 shared embed input schema. Used by both the legacy single
 * `embed` arg and the new `embeds[]` array. Discord per-embed caps: title ≤
 * 256, description ≤ 4096, ≤ 25 fields (name ≤ 256, value ≤ 1024),
 * author.name ≤ 256, footer.text ≤ 2048. The 6000-char total cap applies
 * across all embeds in a single message — daemon-side validateEmbed enforces.
 */
const EMBED_INPUT_SCHEMA = {
  type: 'object',
  description: 'Discord embed object.',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    color: { type: 'integer', description: 'RGB int (0..0xFFFFFF)' },
    url: { type: 'string', description: 'Clickable URL on the title' },
    timestamp: { type: 'string', description: 'ISO 8601; renders as relative time on hover' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          inline: { type: 'boolean' },
        },
        required: ['name', 'value'],
      },
    },
    author: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        icon_url: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['name'],
    },
    footer: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        icon_url: { type: 'string' },
      },
      required: ['text'],
    },
    image: {
      type: 'object',
      description: 'Large bottom image. URL may be `attachment://<name>` referencing a file uploaded in same message.',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    thumbnail: {
      type: 'object',
      description: 'Small top-right image. URL may be `attachment://<name>`.',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
} as const

const TOOL_DEFS = [
  {
    name: 'reply',
    description:
      'Send a reply on Discord. Pass chat_id from the inbound message. ' +
      'For structured summaries pass `embed` (single) or `embeds` (up to 10) ' +
      'with title / description / fields / author / image / etc.; keep `text` short as a teaser line.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        embed: EMBED_INPUT_SCHEMA,
        embeds: {
          type: 'array',
          description:
            'Up to 10 embeds in one message. Discord caps the **combined** ' +
            'character total across all embeds at 6000. Use this for ' +
            'meta + input + output trace-style layouts. Mutually exclusive with `embed`.',
          items: EMBED_INPUT_SCHEMA,
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Discord message.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: "Edit a message the bot previously sent.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'fetch_messages',
    description:
      "Fetch recent messages from a Discord channel. Discord doesn't expose search to bots; this is the only lookback.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download attachments from a specific Discord message to the local inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'whoami',
    description:
      'Return the current plugin runtime identity (workspace name, daemon socket, agent, plugin version, daemon connection status). No-args. Use to confirm which workspace this CC is registered as — useful when names auto-suffix on collision.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'thread_reply',
    description:
      'Start a Discord thread under a bot message and post initial content into it. Use for long reasoning, tool traces, or detailed explanations — keeps the main channel concise. Returns { thread_id, message_id }; use thread_id as chat_id for subsequent reply/edit_message calls in the thread. Fails on DM channels (Discord DMs do not support threads).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Guild text channel id (not DM)' },
        parent_message_id: { type: 'string', description: 'Bot message to attach thread to' },
        name: { type: 'string', description: 'Thread title (1-100 chars)' },
        content: { type: 'string', description: 'First message body in the thread' },
      },
      required: ['chat_id', 'parent_message_id', 'name', 'content'],
    },
  },
] as const

/**
 * MCP server `instructions` field — tells CC how to behave when this plugin
 * is active. Exported so unit tests can assert key directives are present
 * (regression guard against accidental deletion).
 */
export const INSTRUCTIONS: readonly string[] = [
  'The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
  'Messages from Discord arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">. Reply with the reply tool — pass chat_id back.',
  // §25: surface intent before tools so the auto-thread trace has context.
  'When answering needs tools (Bash / Read / Edit / Grep / WebFetch / ...), FIRST send a short reply (≤2 sentences) stating your intent or plan, THEN run the tools, THEN send a follow-up reply with the result (or edit_message the intent reply). The daemon auto-collects each tool call into a thread under your channel reply — without the intent line the user sees a thread of tool I/O with no "why".',
  'For LONG replies (multi-paragraph reasoning, code explanations) in a GUILD channel: first reply with a SHORT conclusion via reply (note the returned message_id), then call thread_reply(chat_id, message_id, name, full_detail). Use the returned thread_id as chat_id for any follow-up reply / edit_message calls that should land in the thread.',
  'For DM channels (chat_id starts with a DM channel id, threads not supported), keep long content inline; use markdown blockquotes or spoilers (||...||) to fold lengthy reasoning.',
] as const

/** What the MCP server needs from the rest of the plugin. */
export type ToolDispatcher = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<ToolResultMsg>

export function buildMcpServer(dispatch: ToolDispatcher): Server {
  const mcp = new Server(
    { name: 'claude-discord', version: '0.0.1' },
    {
      // 'claude/channel/permission' is the opt-in for the permission relay
      // protocol. Declaring it asserts we authenticate the responder, which
      // we do via access.allowFrom in permission-relay.ts. Without this
      // declaration CC may not route permission_request notifications here.
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
      instructions: INSTRUCTIONS.join('\n'),
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOL_DEFS] }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const result = await dispatch(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    )
    if (result.ok) {
      return { content: [{ type: 'text', text: result.result ?? '' }] }
    }
    return {
      content: [{ type: 'text', text: result.error ?? 'unknown error' }],
      isError: true,
    }
  })

  return mcp
}

export async function connectMcpStdio(mcp: Server): Promise<void> {
  const transport = new StdioServerTransport()
  // When parent CC dies its stdio pipes close — without an onclose handler
  // the plugin process keeps running orphaned (occasionally entering a high
  // CPU loop while reconnecting to a since-vanished daemon, see #26). Tie
  // process exit to transport close so plugin lifecycle follows parent.
  transport.onclose = () => process.exit(0)
  await mcp.connect(transport)
}

/**
 * Push a daemon-originated inbound message to CC as MCP notification.
 */
export function relayInbound(mcp: Server, msg: InboundMsg): void {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: msg.content,
      meta: {
        chat_id: msg.chat_id,
        message_id: msg.message_id,
        user: msg.user,
        user_id: msg.user_id,
        ts: msg.ts,
        ...(msg.attachments && msg.attachments.length > 0
          ? {
              attachment_count: String(msg.attachments.length),
              attachments: msg.attachments
                .map(a => `${a.name} (${a.contentType ?? 'unknown'}, ${a.size}B)`)
                .join('; '),
            }
          : {}),
      },
    },
  })
}

/** Stub result used while disconnected from daemon. */
export function disconnectedResult(): ToolResultMsg {
  return {
    type: 'tool_result',
    v: PROTOCOL_VERSION,
    id: 'noop',
    ok: false,
    error: 'plugin not connected to daemon',
  }
}
