import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addCodexEntry,
  removeCodexEntry,
  resolveCodexConfigPath,
} from '../install-codex.ts'

const EXISTING_USER_CONFIG = `model = "gpt-5.5"
sandbox_mode = "workspace-write"

[projects."/Users/x/foo"]
trust_level = "trusted"
`

describe('resolveCodexConfigPath', () => {
  it('honors CODEX_HOME when set', () => {
    expect(resolveCodexConfigPath({ CODEX_HOME: '/custom/codex' })).toBe('/custom/codex/config.toml')
  })

  it('falls back to ~/.codex/config.toml', () => {
    expect(resolveCodexConfigPath({})).toBe(join(homedir(), '.codex', 'config.toml'))
  })

  it('treats empty string CODEX_HOME as unset', () => {
    expect(resolveCodexConfigPath({ CODEX_HOME: '' })).toBe(join(homedir(), '.codex', 'config.toml'))
  })
})

describe('addCodexEntry (§49)', () => {
  it('appends a marked block when section is absent', () => {
    const { text, changed } = addCodexEntry(EXISTING_USER_CONFIG, 'bun', ['run', '/abs/plugin/index.ts'])
    expect(changed).toBe(true)
    expect(text).toContain('[mcp_servers.claude-discord]')
    expect(text).toContain('command = "bun"')
    expect(text).toContain('args = ["run","/abs/plugin/index.ts"]')
    expect(text).toContain('# claude-discord-bot install-codex (managed')
    // Preserves all user content verbatim
    expect(text.startsWith(EXISTING_USER_CONFIG.trimEnd())).toBe(true)
  })

  it('is idempotent — second add no-ops', () => {
    const first = addCodexEntry(EXISTING_USER_CONFIG, 'bun', ['run', '/abs/x.ts'])
    expect(first.changed).toBe(true)
    const second = addCodexEntry(first.text, 'bun', ['run', '/abs/x.ts'])
    expect(second.changed).toBe(false)
    expect(second.text).toBe(first.text)
  })

  it('detects an existing section even without our markers (user-installed)', () => {
    const userInstalled = `${EXISTING_USER_CONFIG}\n[mcp_servers.claude-discord]\ncommand = "bun"\nargs = ["run","/x.ts"]\n`
    const { changed } = addCodexEntry(userInstalled, 'bun', ['run', '/y.ts'])
    expect(changed).toBe(false)
  })

  it('handles a config without trailing newline', () => {
    const noNewline = 'model = "gpt-5"'
    const { text } = addCodexEntry(noNewline, 'bun', ['run', '/x.ts'])
    expect(text.startsWith('model = "gpt-5"\n')).toBe(true)
    expect(text).toContain('[mcp_servers.claude-discord]')
  })
})

describe('removeCodexEntry (§49)', () => {
  it('strips a marked block cleanly', () => {
    const added = addCodexEntry(EXISTING_USER_CONFIG, 'bun', ['run', '/x.ts']).text
    const { text, changed } = removeCodexEntry(added)
    expect(changed).toBe(true)
    // Back to original (modulo trailing newline behavior)
    expect(text.replace(/\n+$/, '')).toBe(EXISTING_USER_CONFIG.replace(/\n+$/, ''))
  })

  it('idempotent — second remove no-ops', () => {
    const added = addCodexEntry(EXISTING_USER_CONFIG, 'bun', ['run', '/x.ts']).text
    const first = removeCodexEntry(added)
    const second = removeCodexEntry(first.text)
    expect(second.changed).toBe(false)
  })

  it('removes a legacy section without markers (user-installed by hand)', () => {
    const legacy = `${EXISTING_USER_CONFIG}\n[mcp_servers.claude-discord]\ncommand = "bun"\nargs = ["run","/x.ts"]\n`
    const { text, changed } = removeCodexEntry(legacy)
    expect(changed).toBe(true)
    expect(text).not.toContain('[mcp_servers.claude-discord]')
    expect(text).not.toContain('command = "bun"')
    // Other sections preserved
    expect(text).toContain('[projects."/Users/x/foo"]')
  })

  it('no-op when section absent', () => {
    const { changed } = removeCodexEntry(EXISTING_USER_CONFIG)
    expect(changed).toBe(false)
  })

  it('legacy section followed by another section: only strips ours', () => {
    const before = `${EXISTING_USER_CONFIG}
[mcp_servers.claude-discord]
command = "bun"
args = ["run","/x.ts"]

[mcp_servers.other]
command = "node"
`
    const { text, changed } = removeCodexEntry(before)
    expect(changed).toBe(true)
    expect(text).not.toContain('[mcp_servers.claude-discord]')
    expect(text).toContain('[mcp_servers.other]')
    expect(text).toContain('command = "node"')
  })
})
