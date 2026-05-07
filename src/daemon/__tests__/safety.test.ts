import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePaths } from '../../shared/paths.ts'
import { assertSendable, safeAttName } from '../safety.ts'

describe('assertSendable', () => {
  it('rejects access.json inside STATE_DIR', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'safety-'))
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    writeFileSync(join(stateDir, 'access.json'), '{}')
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    expect(() => assertSendable(paths.accessFile, paths)).toThrow(/refusing to send/)
  })

  it('allows files in STATE_DIR/inbox', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'safety-'))
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    const inboxFile = join(stateDir, 'inbox', 'cat.png')
    writeFileSync(inboxFile, 'fake')
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    expect(() => assertSendable(inboxFile, paths)).not.toThrow()
  })

  it('allows random external files', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'safety-'))
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    const f = join(outside, 'hello.txt')
    writeFileSync(f, 'hi')
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    expect(() => assertSendable(f, paths)).not.toThrow()
  })

  it('does not throw on dangling path (caller will hit ENOENT later)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'safety-'))
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    expect(() => assertSendable('/nope/does/not/exist', paths)).not.toThrow()
  })
})

describe('safeAttName', () => {
  it('replaces brackets, semicolons, and newlines', () => {
    expect(safeAttName('foo[bad];name\r\n.png')).toBe('foo_bad__name__.png')
  })
  it('null/undefined → "attachment"', () => {
    expect(safeAttName(null)).toBe('attachment')
    expect(safeAttName(undefined)).toBe('attachment')
  })
  it('empty after sanitize → "attachment"', () => {
    expect(safeAttName(';;;')).toBe('attachment')
  })
  it('plain name passes through', () => {
    expect(safeAttName('hello.png')).toBe('hello.png')
  })
})
