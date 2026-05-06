import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configure } from '../configure.ts'

describe('configure subcommand (smoke)', () => {
  let stateDir: string
  let savedExit: typeof process.exit
  let savedEnv: string | undefined

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cfg-'))
    savedExit = process.exit
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`)
    }) as typeof process.exit
    savedEnv = process.env.CLAUDE_DISCORD_STATE_DIR
    process.env.CLAUDE_DISCORD_STATE_DIR = stateDir
  })

  afterEach(() => {
    process.exit = savedExit
    if (savedEnv === undefined) delete process.env.CLAUDE_DISCORD_STATE_DIR
    else process.env.CLAUDE_DISCORD_STATE_DIR = savedEnv
  })

  it('writes token to .env with mode 0o600', () => {
    configure('MTIzfake-token')
    const envPath = join(stateDir, '.env')
    expect(readFileSync(envPath, 'utf8')).toContain('DISCORD_BOT_TOKEN=MTIzfake-token')
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })

  it('preserves other env keys when token already set', () => {
    const envPath = join(stateDir, '.env')
    writeFileSync(envPath, 'DISCORD_BOT_TOKEN=old\nFOO=bar\n', { mode: 0o600 })
    configure('newtoken')
    const content = readFileSync(envPath, 'utf8')
    expect(content).toContain('DISCORD_BOT_TOKEN=newtoken')
    expect(content).toContain('FOO=bar')
    expect(content).not.toContain('DISCORD_BOT_TOKEN=old')
  })

  it('rejects token containing newlines', () => {
    expect(() => configure('bad\ntoken')).toThrow(/process\.exit\(1\)/)
  })
})
