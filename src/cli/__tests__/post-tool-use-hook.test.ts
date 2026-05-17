import { describe, expect, it } from 'vitest'
import {
  compactToolResponse,
  detectStatus,
  shouldSkip,
  truncate,
} from '../post-tool-use-hook.ts'

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

describe('compactToolResponse (§40-fix #110)', () => {
  it('passes short strings through', () => {
    expect(compactToolResponse('hi')).toBe('hi')
  })

  it('truncates long strings', () => {
    const big = 'x'.repeat(2000)
    const out = compactToolResponse(big, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out).toContain('truncated')
  })

  it('keeps JSON valid when long stdout is truncated (Bash shape)', () => {
    const big = 'src/foo:1: hit\n'.repeat(400) // ~6000 chars
    const out = compactToolResponse({ stdout: big, stderr: '', exitCode: 0 })
    const parsed = JSON.parse(out) as { stdout: string; stderr: string; exitCode: number }
    expect(parsed.stdout.length).toBeLessThanOrEqual(1800)
    expect(parsed.stdout).toContain('truncated')
    expect(parsed.stderr).toBe('')
    expect(parsed.exitCode).toBe(0)
  })

  it('truncates string fields recursively (Read shape)', () => {
    const big = 'line\n'.repeat(2000)
    const out = compactToolResponse({
      type: 'text',
      file: { filePath: '/x', content: big },
    })
    const parsed = JSON.parse(out) as {
      type: string
      file: { filePath: string; content: string }
    }
    expect(parsed.type).toBe('text')
    expect(parsed.file.filePath).toBe('/x')
    expect(parsed.file.content.length).toBeLessThanOrEqual(1800)
    expect(parsed.file.content).toContain('truncated')
  })

  it('handles arrays of objects', () => {
    const big = 'y'.repeat(2000)
    const out = compactToolResponse({
      content: [{ type: 'text', text: big }],
    })
    const parsed = JSON.parse(out) as { content: { type: string; text: string }[] }
    expect(parsed.content[0]!.type).toBe('text')
    expect(parsed.content[0]!.text.length).toBeLessThanOrEqual(1800)
  })

  it('preserves non-string scalars (numbers / booleans / null)', () => {
    const out = compactToolResponse({
      stdout: 'short',
      exitCode: 1,
      interrupted: false,
      meta: null,
    })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed.exitCode).toBe(1)
    expect(parsed.interrupted).toBe(false)
    expect(parsed.meta).toBeNull()
  })

  it('null / undefined → empty string', () => {
    expect(compactToolResponse(null)).toBe('')
    expect(compactToolResponse(undefined)).toBe('')
  })
})
