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

const TOOL_DEFS = [
  {
    name: 'reply',
    description: 'Send a reply on Discord. Pass chat_id from the inbound message.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
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
      instructions: [
        'The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
        'Messages from Discord arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">. Reply with the reply tool — pass chat_id back.',
      ].join('\n'),
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
