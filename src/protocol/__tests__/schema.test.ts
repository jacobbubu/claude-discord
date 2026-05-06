import { describe, expect, it } from 'vitest'
import {
  HeartbeatSchema,
  InboundSchema,
  RegisterAckSchema,
  RegisterSchema,
  ToolCallSchema,
  ToolResultSchema,
  WireSchema,
} from '../schema.ts'
import { PROTOCOL_VERSION } from '../version.ts'

describe('protocol schemas', () => {
  it('parses a valid register message', () => {
    const msg = RegisterSchema.parse({
      type: 'register',
      v: PROTOCOL_VERSION,
      agent: 'claude-code',
      cwd: '/Users/x/proj',
      pid: 1234,
      capabilities: ['reply'],
    })
    expect(msg.agent).toBe('claude-code')
  })

  it('rejects register with wrong protocol version', () => {
    const result = RegisterSchema.safeParse({
      type: 'register',
      v: 999,
      agent: 'claude-code',
      cwd: '/Users/x',
      pid: 1,
      capabilities: [],
    })
    expect(result.success).toBe(false)
  })

  it('parses register_ack', () => {
    const msg = RegisterAckSchema.parse({
      type: 'register_ack',
      v: PROTOCOL_VERSION,
      workspace: 'foo',
      server_capabilities: ['reply'],
    })
    expect(msg.workspace).toBe('foo')
  })

  it('parses heartbeat', () => {
    const msg = HeartbeatSchema.parse({ type: 'heartbeat', v: PROTOCOL_VERSION })
    expect(msg.type).toBe('heartbeat')
  })

  it('parses inbound with attachments', () => {
    const msg = InboundSchema.parse({
      type: 'inbound',
      v: PROTOCOL_VERSION,
      chat_id: 'c1',
      message_id: 'm1',
      user: 'alice',
      user_id: 'u1',
      ts: '2026-05-06T08:50:00Z',
      content: 'hi',
      attachments: [{ name: 'a.png', contentType: 'image/png', size: 1024 }],
    })
    expect(msg.attachments?.[0]?.name).toBe('a.png')
  })

  it('parses tool_call + tool_result', () => {
    const call = ToolCallSchema.parse({
      type: 'tool_call',
      v: PROTOCOL_VERSION,
      id: 'tc-1',
      tool: 'reply',
      args: { chat_id: 'c1', text: 'hi' },
    })
    expect(call.tool).toBe('reply')

    const okRes = ToolResultSchema.parse({
      type: 'tool_result',
      v: PROTOCOL_VERSION,
      id: 'tc-1',
      ok: true,
      result: 'sent',
    })
    expect(okRes.ok).toBe(true)

    const errRes = ToolResultSchema.parse({
      type: 'tool_result',
      v: PROTOCOL_VERSION,
      id: 'tc-1',
      ok: false,
      error: 'failed',
    })
    expect(errRes.error).toBe('failed')
  })

  it('discriminated union picks correct variant', () => {
    const msg = WireSchema.parse({
      type: 'heartbeat',
      v: PROTOCOL_VERSION,
    })
    expect(msg.type).toBe('heartbeat')
  })

  it('discriminated union rejects unknown type', () => {
    const result = WireSchema.safeParse({ type: 'fake', v: PROTOCOL_VERSION })
    expect(result.success).toBe(false)
  })
})
