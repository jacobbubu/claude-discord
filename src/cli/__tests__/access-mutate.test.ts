import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile, type Access } from '../../daemon/access-control.ts'
import {
  cmdAllow,
  cmdDeny,
  cmdGroupAdd,
  cmdGroupRm,
  cmdPair,
  cmdPolicy,
  cmdRemove,
  cmdSet,
  defaultAccess,
} from '../access-mutate.ts'

describe('access-mutate CLI helpers', () => {
  let stateDir: string
  let savedExit: typeof process.exit
  let savedEnv: string | undefined

  const accessFile = () => join(stateDir, 'access.json')

  const readAccess = (): Access => JSON.parse(readFileSync(accessFile(), 'utf8'))

  const seedAccess = (a: Access) => writeAccessFile(accessFile(), a)

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cli-am-'))
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

  it('pair: moves pending → allowFrom + writes approved/<senderId>', () => {
    const now = Date.now()
    seedAccess({
      ...defaultAccess(),
      pending: {
        abc123: { senderId: 'u1', chatId: 'c1', createdAt: now, expiresAt: now + 60_000, replies: 1 },
      },
    })
    cmdPair('abc123')
    const a = readAccess()
    expect(a.allowFrom).toContain('u1')
    expect(a.pending.abc123).toBeUndefined()
    expect(existsSync(join(stateDir, 'approved', 'u1'))).toBe(true)
    expect(readFileSync(join(stateDir, 'approved', 'u1'), 'utf8')).toBe('c1')
  })

  it('pair: rejects expired code', () => {
    seedAccess({
      ...defaultAccess(),
      pending: {
        abc123: { senderId: 'u1', chatId: 'c1', createdAt: 0, expiresAt: 1, replies: 1 },
      },
    })
    expect(() => cmdPair('abc123')).toThrow(/process\.exit\(1\)/)
  })

  it('deny: removes pending entry', () => {
    seedAccess({
      ...defaultAccess(),
      pending: {
        abc123: { senderId: 'u1', chatId: 'c1', createdAt: 0, expiresAt: 9e15, replies: 1 },
      },
    })
    cmdDeny('abc123')
    expect(readAccess().pending.abc123).toBeUndefined()
  })

  it('allow / remove: add then remove', () => {
    cmdAllow('u1')
    expect(readAccess().allowFrom).toContain('u1')
    cmdRemove('u1')
    expect(readAccess().allowFrom).not.toContain('u1')
  })

  it('policy: validates and writes', () => {
    cmdPolicy('allowlist')
    expect(readAccess().dmPolicy).toBe('allowlist')
    expect(() => cmdPolicy('bogus')).toThrow(/process\.exit\(1\)/)
  })

  it('group add / rm', () => {
    cmdGroupAdd('cg1', { noMention: true, allow: ['u1', 'u2'] })
    const a = readAccess()
    expect(a.groups.cg1).toBeDefined()
    expect(a.groups.cg1!.requireMention).toBe(false)
    expect(a.groups.cg1!.allowFrom).toEqual(['u1', 'u2'])
    cmdGroupRm('cg1')
    expect(readAccess().groups.cg1).toBeUndefined()
  })

  it('set ackReaction (string + clear-with-empty)', () => {
    cmdSet('ackReaction', '🔨')
    expect(readAccess().ackReaction).toBe('🔨')
    cmdSet('ackReaction', '')
    expect(readAccess().ackReaction).toBeUndefined()
  })

  it('set replyToMode validates', () => {
    cmdSet('replyToMode', 'first')
    expect(readAccess().replyToMode).toBe('first')
    expect(() => cmdSet('replyToMode', 'bogus')).toThrow(/process\.exit\(1\)/)
  })

  it('set textChunkLimit validates positive integer', () => {
    cmdSet('textChunkLimit', '1500')
    expect(readAccess().textChunkLimit).toBe(1500)
    expect(() => cmdSet('textChunkLimit', '-1')).toThrow(/process\.exit\(1\)/)
    expect(() => cmdSet('textChunkLimit', 'abc')).toThrow(/process\.exit\(1\)/)
  })

  it('set mentionPatterns parses JSON array', () => {
    cmdSet('mentionPatterns', '["^hey claude\\\\b","\\\\bbot\\\\b"]')
    expect(readAccess().mentionPatterns?.length).toBe(2)
    expect(() => cmdSet('mentionPatterns', '[1,2]')).toThrow(/process\.exit\(1\)/)
  })
})
