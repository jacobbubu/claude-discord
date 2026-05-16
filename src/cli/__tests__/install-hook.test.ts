import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addHookToSettings, removeHookFromSettings, resolveSettingsPath } from '../install-hook.ts'

const CMD = 'bun run /tmp/permission-hook.ts'

describe('resolveSettingsPath (deltas #69: honor CLAUDE_CONFIG_DIR)', () => {
  it('uses CLAUDE_CONFIG_DIR/settings.json when the env var is set', () => {
    expect(resolveSettingsPath({ CLAUDE_CONFIG_DIR: '/Users/x/.claude-yolo2' }))
      .toBe('/Users/x/.claude-yolo2/settings.json')
  })

  it('falls back to ~/.claude/settings.json when the env var is unset', () => {
    expect(resolveSettingsPath({})).toBe(join(homedir(), '.claude', 'settings.json'))
  })

  it('falls back when CLAUDE_CONFIG_DIR is an empty string', () => {
    expect(resolveSettingsPath({ CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude', 'settings.json'))
  })
})

describe('addHookToSettings', () => {
  it('creates hooks.PreToolUse with empty matcher block when settings empty', () => {
    const { settings, changed } = addHookToSettings({}, CMD)
    expect(changed).toBe(true)
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: CMD, timeout: 3700 }] },
    ])
  })

  it('appends to existing matcher="" block', () => {
    const before = {
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'something-else' }] },
        ],
      },
    }
    const { settings, changed } = addHookToSettings(before, CMD)
    expect(changed).toBe(true)
    const block = settings.hooks!.PreToolUse![0]!
    expect(block.hooks.length).toBe(2)
    expect(block.hooks[1]!.command).toBe(CMD)
  })

  it('idempotent — re-install with same command does nothing', () => {
    const first = addHookToSettings({}, CMD)
    const second = addHookToSettings(first.settings, CMD)
    expect(second.changed).toBe(false)
    expect(second.settings.hooks!.PreToolUse![0]!.hooks.length).toBe(1)
  })

  it('does not touch other hook events (Stop, SessionStart, etc)', () => {
    const before = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'unrelated' }] }],
      },
    }
    const { settings } = addHookToSettings(before, CMD)
    expect(settings.hooks!.SessionStart).toEqual(before.hooks.SessionStart)
    expect(settings.hooks!.PreToolUse).toBeDefined()
  })

  it('preserves unrelated top-level keys', () => {
    const before = { enabledPlugins: { foo: true }, model: 'opus' }
    const { settings } = addHookToSettings(before, CMD)
    expect(settings.enabledPlugins).toEqual({ foo: true })
    expect(settings.model).toBe('opus')
  })

  it('coexists with cmux PermissionRequest hook (different event name)', () => {
    const before = {
      hooks: {
        PermissionRequest: [{ matcher: '', hooks: [{ type: 'command', command: 'cmux hook' }] }],
      },
    }
    const { settings } = addHookToSettings(before, CMD)
    expect(settings.hooks!.PermissionRequest).toEqual(before.hooks.PermissionRequest)
    expect(settings.hooks!.PreToolUse).toBeDefined()
  })
})

describe('removeHookFromSettings', () => {
  it('returns changed=false when hooks unset', () => {
    const { changed } = removeHookFromSettings({}, CMD)
    expect(changed).toBe(false)
  })

  it('returns changed=false when our command not present', () => {
    const before = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'other' }] }],
      },
    }
    const { settings, changed } = removeHookFromSettings(before, CMD)
    expect(changed).toBe(false)
    expect(settings).toEqual(before)
  })

  it('removes our hook entry; prunes empty block; deletes empty PreToolUse', () => {
    const before = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: CMD }] }],
      },
    }
    const { settings, changed } = removeHookFromSettings(before, CMD)
    expect(changed).toBe(true)
    expect(settings.hooks).toBeUndefined()
  })

  it('keeps other hooks in same block intact', () => {
    const before = {
      hooks: {
        PreToolUse: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: CMD },
              { type: 'command', command: 'other' },
            ],
          },
        ],
      },
    }
    const { settings, changed } = removeHookFromSettings(before, CMD)
    expect(changed).toBe(true)
    expect(settings.hooks!.PreToolUse![0]!.hooks).toEqual([
      { type: 'command', command: 'other' },
    ])
  })

  it('does not touch unrelated hook events', () => {
    const before = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: CMD }] }],
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'session' }] }],
      },
    }
    const { settings } = removeHookFromSettings(before, CMD)
    expect(settings.hooks!.SessionStart).toEqual(before.hooks.SessionStart)
    expect(settings.hooks!.PreToolUse).toBeUndefined()
  })

  it('install then uninstall round-trips to a settings.json without our hook', () => {
    const initial = { enabledPlugins: { x: true } }
    const installed = addHookToSettings(initial, CMD).settings
    const removed = removeHookFromSettings(installed, CMD).settings
    expect(removed).toEqual(initial)
  })
})

describe('addHookToSettings — PostToolUse event (deltas §24)', () => {
  const PRE = 'bun run /tmp/permission-hook.ts'
  const POST = 'bun run /tmp/post-tool-use-hook.ts'

  it('creates PostToolUse block without touching PreToolUse', () => {
    const afterPre = addHookToSettings({}, PRE).settings
    const { settings, changed } = addHookToSettings(afterPre, POST, 5, 'PostToolUse')
    expect(changed).toBe(true)
    expect(settings.hooks!.PreToolUse![0]!.hooks[0]!.command).toBe(PRE)
    expect(settings.hooks!.PostToolUse![0]!.hooks[0]!.command).toBe(POST)
    expect(settings.hooks!.PostToolUse![0]!.hooks[0]!.timeout).toBe(5)
  })

  it('is idempotent within PostToolUse event', () => {
    const first = addHookToSettings({}, POST, 5, 'PostToolUse')
    const second = addHookToSettings(first.settings, POST, 5, 'PostToolUse')
    expect(second.changed).toBe(false)
  })

  it('uninstall PostToolUse leaves PreToolUse intact', () => {
    let s = addHookToSettings({}, PRE).settings
    s = addHookToSettings(s, POST, 5, 'PostToolUse').settings
    const { settings, changed } = removeHookFromSettings(s, POST, 'PostToolUse')
    expect(changed).toBe(true)
    expect(settings.hooks!.PreToolUse).toBeDefined()
    expect(settings.hooks!.PostToolUse).toBeUndefined()
  })
})

describe('addHookToSettings — Stop event (deltas §36)', () => {
  const PRE = 'bun run /tmp/permission-hook.ts'
  const STOP = 'bun run /tmp/stop-hook.ts'

  it('creates Stop block without touching PreToolUse', () => {
    const afterPre = addHookToSettings({}, PRE).settings
    const { settings, changed } = addHookToSettings(afterPre, STOP, 5, 'Stop')
    expect(changed).toBe(true)
    expect(settings.hooks!.PreToolUse![0]!.hooks[0]!.command).toBe(PRE)
    expect(settings.hooks!.Stop![0]!.hooks[0]!.command).toBe(STOP)
    expect(settings.hooks!.Stop![0]!.hooks[0]!.timeout).toBe(5)
  })

  it('is idempotent within Stop event', () => {
    const first = addHookToSettings({}, STOP, 5, 'Stop')
    const second = addHookToSettings(first.settings, STOP, 5, 'Stop')
    expect(second.changed).toBe(false)
  })

  it('coexists with other Stop hooks (e.g. cmux)', () => {
    const before = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'cmux stop' }] }],
      },
    }
    const { settings } = addHookToSettings(before, STOP, 5, 'Stop')
    const stopBlock = settings.hooks!.Stop![0]!
    expect(stopBlock.hooks.length).toBe(2)
    expect(stopBlock.hooks[0]!.command).toBe('cmux stop')
    expect(stopBlock.hooks[1]!.command).toBe(STOP)
  })

  it('uninstall Stop leaves PreToolUse + PostToolUse intact', () => {
    const POST = 'bun run /tmp/post-tool-use-hook.ts'
    let s = addHookToSettings({}, PRE).settings
    s = addHookToSettings(s, POST, 5, 'PostToolUse').settings
    s = addHookToSettings(s, STOP, 5, 'Stop').settings
    const { settings, changed } = removeHookFromSettings(s, STOP, 'Stop')
    expect(changed).toBe(true)
    expect(settings.hooks!.PreToolUse).toBeDefined()
    expect(settings.hooks!.PostToolUse).toBeDefined()
    expect(settings.hooks!.Stop).toBeUndefined()
  })
})
