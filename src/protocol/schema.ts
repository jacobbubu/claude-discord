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
])
export type WireMsg = z.infer<typeof WireSchema>
