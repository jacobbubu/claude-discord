import { describe, expect, it } from 'vitest'
import { detectStatus, shouldSkip, truncate } from '../post-tool-use-hook.ts'

describe('shouldSkip', () => {
  it('skips TodoWrite (internal CC tracker)', () => {
    expect(shouldSkip('TodoWrite')).toBe(true)
  })

  it('skips plugin\'s own MCP tools to avoid echo loop', () => {
    expect(shouldSkip('mcp__plugin_claude-discord_reply')).toBe(true)
    expect(shouldSkip('mcp__plugin_claude-discord_thread_reply')).toBe(true)
  })

  it('does not skip user-relevant tools', () => {
    expect(shouldSkip('Bash')).toBe(false)
    expect(shouldSkip('Read')).toBe(false)
    expect(shouldSkip('Edit')).toBe(false)
    expect(shouldSkip('Grep')).toBe(false)
  })

  it('does not skip other plugins\' MCP tools — only ours', () => {
    expect(shouldSkip('mcp__plugin_oh-my-claudecode_t__lsp_hover')).toBe(false)
  })
})

describe('truncate', () => {
  it('returns input unchanged when under limit', () => {
    expect(truncate('hi')).toBe('hi')
  })

  it('truncates with suffix noting how much was cut', () => {
    const big = 'x'.repeat(2000)
    const out = truncate(big, 1800)
    expect(out.length).toBeLessThanOrEqual(1800)
    expect(out).toContain('truncated')
    expect(out).toContain('chars')
  })

  it('truncation count reflects actual omitted length, not original size', () => {
    const big = 'x'.repeat(3000)
    const out = truncate(big, 100)
    const m = out.match(/truncated (\d+) chars/)
    expect(m).toBeTruthy()
    const cut = Number(m![1])
    // head kept = 100 - 30 = 70 chars; omitted = 3000 - 70 = 2930
    expect(cut).toBe(2930)
  })
})

describe('detectStatus', () => {
  it('returns "ok" for plain string responses', () => {
    expect(detectStatus('command output')).toBe('ok')
  })

  it('returns "error" when response.is_error is true', () => {
    expect(detectStatus({ is_error: true, stderr: 'boom' })).toBe('error')
  })

  it('returns "error" when response.status is "error" (case-insensitive)', () => {
    expect(detectStatus({ status: 'error' })).toBe('error')
    expect(detectStatus({ status: 'ERROR' })).toBe('error')
  })

  it('returns "ok" for healthy object responses', () => {
    expect(detectStatus({ stdout: 'ok', exitCode: 0 })).toBe('ok')
  })

  it('returns "ok" for null/undefined (no signal of error)', () => {
    expect(detectStatus(null)).toBe('ok')
    expect(detectStatus(undefined)).toBe('ok')
  })
})
