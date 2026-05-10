import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sniffDangerouslySkipPermissions } from '../../plugin/connect-policy.ts'
import { buildToolDescription, settingsAllows } from '../permission-hook.ts'

describe('buildToolDescription', () => {
  it('Bash → command', () => {
    expect(buildToolDescription('Bash', { command: 'ls -la /tmp' })).toBe('ls -la /tmp')
  })

  it('Read → file_path', () => {
    expect(buildToolDescription('Read', { file_path: '/etc/hosts' })).toBe('/etc/hosts')
  })

  it('Write → "write <file_path>"', () => {
    expect(buildToolDescription('Write', { file_path: '/tmp/x.txt' })).toBe('write /tmp/x.txt')
  })

  it('Edit / MultiEdit → "edit <file_path>"', () => {
    expect(buildToolDescription('Edit', { file_path: '/a' })).toBe('edit /a')
    expect(buildToolDescription('MultiEdit', { file_path: '/b' })).toBe('edit /b')
  })

  it('Glob / Grep → "glob/grep <pattern>"', () => {
    expect(buildToolDescription('Glob', { pattern: '**/*.ts' })).toBe('glob **/*.ts')
    expect(buildToolDescription('Grep', { pattern: 'TODO' })).toBe('grep TODO')
  })

  it('WebFetch → "fetch <url>"', () => {
    expect(buildToolDescription('WebFetch', { url: 'https://x' })).toBe('fetch https://x')
  })

  it('WebSearch → "search <query>"', () => {
    expect(buildToolDescription('WebSearch', { query: 'discord channel' })).toBe('search discord channel')
  })

  it('truncates long arg to 200 chars', () => {
    const long = 'a'.repeat(500)
    const r = buildToolDescription('Bash', { command: long })
    expect(r.length).toBe(200)
  })

  it('unknown tool with preferred field name → "<tool>: <value>"', () => {
    expect(buildToolDescription('CustomTool', { command: 'foo' })).toBe('CustomTool: foo')
    expect(buildToolDescription('CustomTool', { url: 'x' })).toBe('CustomTool: x')
  })

  it('unknown tool with no preferred field → JSON-serialized', () => {
    const r = buildToolDescription('Mystery', { x: 1, y: 2 })
    expect(r).toContain('Mystery:')
    expect(r).toContain('"x":1')
  })

  it('non-object toolInput → "<tool>: <stringified>"', () => {
    expect(buildToolDescription('X', 'plain-string')).toBe('X: plain-string')
    expect(buildToolDescription('X', 42)).toBe('X: 42')
  })

  it('Bash with missing command falls back to generic preferred-field path', () => {
    // No command but has another arg
    expect(buildToolDescription('Bash', { something: 'else' })).toContain('Bash:')
  })

  it('extracted command preserved verbatim — including risky ones', () => {
    // We're just doing display; security gate is separate. Preserve content.
    expect(buildToolDescription('Bash', { command: 'rm -rf /' })).toBe('rm -rf /')
  })
})

describe('sniffDangerouslySkipPermissions (§21)', () => {
  it('detects flag in cmdline', () => {
    expect(
      sniffDangerouslySkipPermissions(
        'claude --session-id abc --dangerously-skip-permissions',
      ),
    ).toBe(true)
  })

  it('null cmdline → false', () => {
    expect(sniffDangerouslySkipPermissions(null)).toBe(false)
  })

  it('cmdline without flag → false', () => {
    expect(sniffDangerouslySkipPermissions('claude --channels plugin:foo@bar')).toBe(false)
  })

  it('flag as substring of another arg → still matches (acceptable false-positive risk is near-zero given flag uniqueness)', () => {
    // Just sanity: include exactly the flag string anywhere
    expect(sniffDangerouslySkipPermissions('--dangerously-skip-permissions')).toBe(true)
  })
})

describe('settingsAllows (§22)', () => {
  function tmpSettings(content: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), 'hook-settings-')), 'settings.json')
    writeFileSync(path, JSON.stringify(content))
    return path
  }

  it('exact tool name match', () => {
    const path = tmpSettings({ permissions: { allow: ['Bash', 'Edit'] } })
    expect(settingsAllows('Bash', path)).toBe(true)
    expect(settingsAllows('Edit', path)).toBe(true)
    expect(settingsAllows('Write', path)).toBe(false)
  })

  it('arg-pattern match `Bash(*)` style', () => {
    const path = tmpSettings({ permissions: { allow: ['Bash(git *)'] } })
    expect(settingsAllows('Bash', path)).toBe(true)
  })

  it('substring of another tool does not falsely match', () => {
    const path = tmpSettings({ permissions: { allow: ['BashWrap'] } })
    // 'Bash' not equal to 'BashWrap' and 'BashWrap' doesn't start with 'Bash('
    expect(settingsAllows('Bash', path)).toBe(false)
  })

  it('missing settings file → false', () => {
    expect(settingsAllows('Bash', '/nonexistent/path/settings.json')).toBe(false)
  })

  it('settings without permissions section → false', () => {
    const path = tmpSettings({ enabledPlugins: { x: true } })
    expect(settingsAllows('Bash', path)).toBe(false)
  })

  it('corrupted settings.json → false (graceful)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hook-settings-')), 'settings.json')
    writeFileSync(path, 'not valid json {{{')
    expect(settingsAllows('Bash', path)).toBe(false)
  })

  it('plugin MCP tool full name matches', () => {
    const path = tmpSettings({
      permissions: {
        allow: ['mcp__plugin_claude-discord_claude-discord__reply'],
      },
    })
    expect(
      settingsAllows('mcp__plugin_claude-discord_claude-discord__reply', path),
    ).toBe(true)
  })
})
