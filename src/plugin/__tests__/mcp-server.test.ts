/**
 * Regression guards for MCP instructions content.
 *
 * The instructions string shapes CC's runtime behavior (Discord-bound output,
 * intent-before-tools, thread routing). Each clause below was added to fix a
 * specific UX issue — losing one re-opens the corresponding regression. Tests
 * pin the existence of those clauses without asserting exact wording.
 */

import { describe, expect, it } from 'vitest'
import { INSTRUCTIONS } from '../mcp-server.ts'

const joined = INSTRUCTIONS.join('\n')

describe('mcp-server instructions', () => {
  it('reminds CC that the user reads Discord, not this session', () => {
    expect(joined).toMatch(/reads Discord, not this session/i)
  })

  it('tells CC how inbound is shaped and to pass chat_id back', () => {
    expect(joined).toMatch(/<channel source="discord"/)
    expect(joined).toMatch(/pass chat_id back/i)
  })

  it('§25: requires intent reply BEFORE tool calls', () => {
    // The auto-thread (§24) shows tool I/O — the user can't see thinking,
    // so CC must surface a short intent line in the channel first.
    expect(joined).toMatch(/FIRST send a short reply/)
    expect(joined).toMatch(/(intent|plan)/i)
    expect(joined).toMatch(/THEN run the tools/)
  })

  it('§23: directs long reasoning into a thread via thread_reply', () => {
    expect(joined).toMatch(/thread_reply/)
  })

  it('DM channels keep long content inline (no thread support)', () => {
    expect(joined).toMatch(/DM channels/)
    expect(joined).toMatch(/(inline|markdown)/i)
  })
})
