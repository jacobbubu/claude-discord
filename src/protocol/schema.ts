/**
 * Plugin↔Daemon NDJSON wire format. Every message is a JSON object on its
 * own line with `type` + `v` (protocol version). See architecture §6.
 *
 * Slice 2 implements 9 message types. permission_request / permission land
 * in slice 4 alongside Discord wiring.
 */

import { z } from 'zod'
import { PROTOCOL_VERSION } from './version.ts'

const versionField = z.literal(PROTOCOL_VERSION)

export const RegisterSchema = z.object({
  type: z.literal('register'),
  v: versionField,
  agent: z.string().min(1),
  cwd: z.string(),
  pid: z.number().int().positive(),
  capabilities: z.array(z.string()),
})
export type RegisterMsg = z.infer<typeof RegisterSchema>

export const RegisterAckSchema = z.object({
  type: z.literal('register_ack'),
  v: versionField,
  workspace: z.string().min(1),
  server_capabilities: z.array(z.string()),
})
export type RegisterAckMsg = z.infer<typeof RegisterAckSchema>

export const RegisterRejectSchema = z.object({
  type: z.literal('register_reject'),
  v: versionField,
  reason: z.enum(['protocol_mismatch', 'unknown_agent', 'capacity', 'invalid']),
  expected_version: z.number().int().optional(),
  detail: z.string().optional(),
})
export type RegisterRejectMsg = z.infer<typeof RegisterRejectSchema>

export const HeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  v: versionField,
})
export type HeartbeatMsg = z.infer<typeof HeartbeatSchema>

export const AttachmentSchema = z.object({
  name: z.string(),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative(),
})

export const InboundSchema = z.object({
  type: z.literal('inbound'),
  v: versionField,
  chat_id: z.string(),
  message_id: z.string(),
  user: z.string(),
  user_id: z.string(),
  ts: z.string(),
  content: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
})
export type InboundMsg = z.infer<typeof InboundSchema>

export const ToolCallSchema = z.object({
  type: z.literal('tool_call'),
  v: versionField,
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
})
export type ToolCallMsg = z.infer<typeof ToolCallSchema>

export const ToolResultSchema = z.object({
  type: z.literal('tool_result'),
  v: versionField,
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
})
export type ToolResultMsg = z.infer<typeof ToolResultSchema>

export const EvictedSchema = z.object({
  type: z.literal('evicted'),
  v: versionField,
  reason: z.string().optional(),
})
export type EvictedMsg = z.infer<typeof EvictedSchema>

export const ByeSchema = z.object({
  type: z.literal('bye'),
  v: versionField,
  reason: z.string().optional(),
})
export type ByeMsg = z.infer<typeof ByeSchema>

/**
 * Permission relay (upstream's `claude/channel/permission` protocol).
 *
 * - permission_request: plugin → daemon when CC asks for permission to use
 *   a tool. Daemon then prompts the user (Discord buttons + text).
 * - permission: daemon → plugin once the user decides. Plugin emits the
 *   matching MCP notification back to CC.
 *
 * `request_id` is a 5-letter [a-km-z] code (skips 'l'), matching upstream's
 * mobile-autocorrect-friendly format.
 */
export const PermissionRequestSchema = z.object({
  type: z.literal('permission_request'),
  v: versionField,
  request_id: z.string().regex(/^[a-km-z]{5}$/),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
})
export type PermissionRequestMsg = z.infer<typeof PermissionRequestSchema>

export const PermissionSchema = z.object({
  type: z.literal('permission'),
  v: versionField,
  request_id: z.string().regex(/^[a-km-z]{5}$/),
  behavior: z.enum(['allow', 'deny']),
})
export type PermissionMsg = z.infer<typeof PermissionSchema>

/**
 * Architecture deltas §15: CC built-in tool permission request, sent by
 * `claude-discord-permission-hook` subprocess that CC spawns via the
 * `hooks.PermissionRequest` config in settings.json.
 *
 * Identical shape to PermissionRequestSchema except for `type` discriminator
 * and the conn lifecycle on the daemon side: hook conns are anonymous (no
 * register), one-shot (close after permission response).
 */
export const CcPermissionRequestSchema = z.object({
  type: z.literal('cc_permission_request'),
  v: versionField,
  request_id: z.string().regex(/^[a-km-z]{5}$/),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
  // Architecture deltas §16: hook reports its parent CC's cwd. daemon uses
  // it to find the matching workspace conn and route the button DM to that
  // workspace's last-inbound chat_id instead of fan-out to allowFrom DMs.
  cwd: z.string().optional(),
})
export type CcPermissionRequestMsg = z.infer<typeof CcPermissionRequestSchema>

/**
 * Architecture deltas §24: PostToolUse hook forwards every CC tool invocation
 * to the daemon, which pushes a formatted embed into the per-turn Discord
 * thread. Like cc_permission_request, this comes from an anonymous hook conn
 * (no register). Daemon does NOT reply on the conn — it's fire-and-forget.
 *
 * tool_input / tool_response are pre-stringified (hook truncates to 1800
 * chars). status is 'error' when CC's tool_response is an error object.
 */
export const CcToolTraceSchema = z.object({
  type: z.literal('cc_tool_trace'),
  v: versionField,
  tool_name: z.string(),
  tool_input: z.string(),
  tool_response: z.string(),
  status: z.enum(['ok', 'error']),
  cwd: z.string().optional(),
})
export type CcToolTraceMsg = z.infer<typeof CcToolTraceSchema>

/**
 * Architecture deltas §27: daemon → hook reply telling the hook to give up on
 * Discord and let CC's own TUI prompt handle this permission. Sent when the
 * target workspace hasn't received a Discord inbound recently (`isInboundFresh`
 * is false) — i.e. the user is plausibly at the terminal, not on Discord, so
 * routing the button DM there would just hang. The hook responds by emitting
 * `permissionDecision: 'ask'`. Anonymous hook conn, one-shot.
 */
export const CcPermissionDeferSchema = z.object({
  type: z.literal('cc_permission_defer'),
  v: versionField,
  request_id: z.string().regex(/^[a-km-z]{5}$/),
})
export type CcPermissionDeferMsg = z.infer<typeof CcPermissionDeferSchema>

/**
 * Discriminated union of every message type. Use this for parsing arbitrary
 * NDJSON lines into typed messages.
 */
export const WireSchema = z.discriminatedUnion('type', [
  RegisterSchema,
  RegisterAckSchema,
  RegisterRejectSchema,
  HeartbeatSchema,
  InboundSchema,
  ToolCallSchema,
  ToolResultSchema,
  EvictedSchema,
  ByeSchema,
  PermissionRequestSchema,
  PermissionSchema,
  CcPermissionRequestSchema,
  CcToolTraceSchema,
  CcPermissionDeferSchema,
])
export type WireMsg = z.infer<typeof WireSchema>
