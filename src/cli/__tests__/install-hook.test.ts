import { describe, expect, it } from 'vitest'
import { addHookToSettings, removeHookFromSettings } from '../install-hook.ts'

const CMD = 'bun run /tmp/permission-hook.ts'

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
