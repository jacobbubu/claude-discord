import { describe, expect, it } from 'vitest'
import { decideConnect } from '../connect-policy.ts'

describe('decideConnect', () => {
  const baseInput = {
    forceConnect: false,
    pluginRoot: '/Users/x/.claude/plugins/cache/jacobbubu/claude-discord/0.0.3',
    manifest: { name: 'claude-discord' },
    cmdline: 'claude --channels plugin:claude-discord@jacobbubu',
  }

  it('parent CC referencing this plugin → connect', () => {
    expect(decideConnect(baseInput)).toEqual({
      connect: true,
      reason: 'parent CC --channels references plugin:claude-discord@*',
    })
  })

  it('parent cmdline has no plugin: ref → skip', () => {
    expect(decideConnect({ ...baseInput, cmdline: 'claude' })).toEqual({
      connect: false,
      reason: 'parent CC has no plugin:claude-discord@* in cmdline',
    })
  })

  it('referencing a different plugin → skip', () => {
    expect(decideConnect({
      ...baseInput,
      cmdline: 'claude --channels plugin:something-else@org',
    })).toEqual({
      connect: false,
      reason: 'parent CC has no plugin:claude-discord@* in cmdline',
    })
  })

  it('--dangerously-load-development-channels also matches', () => {
    expect(decideConnect({
      ...baseInput,
      cmdline:
        'claude --dangerously-load-development-channels plugin:claude-discord@jacobbubu --channels plugin:claude-discord@jacobbubu',
    }).connect).toBe(true)
  })

  it('CLAUDE_DISCORD_FORCE_CONNECT=1 overrides absent plugin ref', () => {
    expect(decideConnect({
      ...baseInput,
      forceConnect: true,
      cmdline: 'claude',
    })).toEqual({
      connect: true,
      reason: 'CLAUDE_DISCORD_FORCE_CONNECT=1 override',
    })
  })

  it('CLAUDE_PLUGIN_ROOT unset → connect (dev/manual launch)', () => {
    expect(decideConnect({
      ...baseInput,
      pluginRoot: undefined,
    })).toEqual({
      connect: true,
      reason: 'CLAUDE_PLUGIN_ROOT unset (dev/manual launch)',
    })
  })

  it('manifest unreadable (null) → connect (conservative)', () => {
    expect(decideConnect({
      ...baseInput,
      manifest: null,
    })).toEqual({
      connect: true,
      reason: 'plugin.json missing or no name field',
    })
  })

  it('manifest has no name field → connect (conservative)', () => {
    expect(decideConnect({
      ...baseInput,
      manifest: { name: '' },
    })).toEqual({
      connect: true,
      reason: 'plugin.json missing or no name field',
    })
  })

  it('cmdline probe failed (null) → connect (conservative)', () => {
    expect(decideConnect({
      ...baseInput,
      cmdline: null,
    })).toEqual({
      connect: true,
      reason: 'parent cmdline probe failed',
    })
  })

  it('plugin name with hyphens / digits matches in cmdline', () => {
    expect(decideConnect({
      ...baseInput,
      manifest: { name: 'foo-bar2' },
      cmdline: 'claude --channels plugin:foo-bar2@org',
    }).connect).toBe(true)
  })

  it('substring match on plugin name does NOT mistakenly trigger', () => {
    // Looking for `plugin:claude-discord@`; cmdline has `plugin:claude-disco@` (different plugin)
    expect(decideConnect({
      ...baseInput,
      manifest: { name: 'claude-discord' },
      cmdline: 'claude --channels plugin:claude-disco@some-mp',
    }).connect).toBe(false)
  })

  it('forceConnect overrides even when no pluginRoot', () => {
    expect(decideConnect({
      forceConnect: true,
      pluginRoot: undefined,
      manifest: null,
      cmdline: null,
    })).toEqual({
      connect: true,
      reason: 'CLAUDE_DISCORD_FORCE_CONNECT=1 override',
    })
  })
})
