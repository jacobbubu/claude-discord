import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultAccess,
  gate,
  matchesMentionPattern,
  pruneExpired,
  readAccessFile,
  writeAccessFile,
  type Access,
  type GateInput,
} from '../access-control.ts'

const baseDM = (overrides: Partial<GateInput> = {}): GateInput => ({
  isDM: true,
  senderId: 'u1',
  channelId: 'c1',
  dmChannelId: 'c1',
  guildChannelKey: 'c1',
  isMentioned: false,
  ...overrides,
})

describe('access-control', () => {
  describe('gate — DM pairing policy', () => {
    it('first DM creates pending pairing entry', () => {
      const a = defaultAccess()
      const r = gate(a, baseDM())
      expect(r.action).toBe('pair')
      if (r.action === 'pair') expect(r.isResend).toBe(false)
      expect(Object.keys(a.pending)).toHaveLength(1)
    })

    it('second DM from same sender returns resend (isResend=true)', () => {
      const a = defaultAccess()
      gate(a, baseDM())
      const r2 = gate(a, baseDM())
      expect(r2.action).toBe('pair')
      if (r2.action === 'pair') expect(r2.isResend).toBe(true)
    })

    it('third DM from same sender drops (replies cap = 2)', () => {
      const a = defaultAccess()
      gate(a, baseDM())
      gate(a, baseDM())
      const r3 = gate(a, baseDM())
      expect(r3.action).toBe('drop')
    })

    it('drops once 3 pending in flight', () => {
      const a = defaultAccess()
      gate(a, baseDM({ senderId: 'u1' }))
      gate(a, baseDM({ senderId: 'u2' }))
      gate(a, baseDM({ senderId: 'u3' }))
      const r4 = gate(a, baseDM({ senderId: 'u4' }))
      expect(r4.action).toBe('drop')
    })

    it('delivers when sender already in allowFrom', () => {
      const a: Access = { ...defaultAccess(), allowFrom: ['u1'] }
      expect(gate(a, baseDM()).action).toBe('deliver')
    })
  })

  describe('gate — DM allowlist policy', () => {
    it('drops unknown sender silently', () => {
      const a: Access = { ...defaultAccess(), dmPolicy: 'allowlist' }
      expect(gate(a, baseDM()).action).toBe('drop')
    })

    it('delivers known sender', () => {
      const a: Access = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['u1'] }
      expect(gate(a, baseDM()).action).toBe('deliver')
    })
  })

  describe('gate — disabled policy', () => {
    it('drops everything regardless of allowFrom', () => {
      const a: Access = { ...defaultAccess(), dmPolicy: 'disabled', allowFrom: ['u1'] }
      expect(gate(a, baseDM()).action).toBe('drop')
    })
  })

  describe('gate — guild channels', () => {
    const baseGuild = (over: Partial<GateInput> = {}): GateInput => ({
      isDM: false,
      senderId: 'u1',
      channelId: 'cg1',
      dmChannelId: 'cg1',
      guildChannelKey: 'cg1',
      isMentioned: false,
      ...over,
    })

    it('drops if channel not opted in', () => {
      const a = defaultAccess()
      expect(gate(a, baseGuild()).action).toBe('drop')
    })

    it('drops without mention when requireMention=true', () => {
      const a: Access = {
        ...defaultAccess(),
        groups: { cg1: { requireMention: true, allowFrom: [] } },
      }
      expect(gate(a, baseGuild({ isMentioned: false })).action).toBe('drop')
    })

    it('delivers with mention when requireMention=true', () => {
      const a: Access = {
        ...defaultAccess(),
        groups: { cg1: { requireMention: true, allowFrom: [] } },
      }
      expect(gate(a, baseGuild({ isMentioned: true })).action).toBe('deliver')
    })

    it('delivers without mention when requireMention=false', () => {
      const a: Access = {
        ...defaultAccess(),
        groups: { cg1: { requireMention: false, allowFrom: [] } },
      }
      expect(gate(a, baseGuild({ isMentioned: false })).action).toBe('deliver')
    })

    it('respects per-channel allowFrom filter', () => {
      const a: Access = {
        ...defaultAccess(),
        groups: { cg1: { requireMention: false, allowFrom: ['u1'] } },
      }
      expect(gate(a, baseGuild({ senderId: 'u1' })).action).toBe('deliver')
      expect(gate(a, baseGuild({ senderId: 'u2' })).action).toBe('drop')
    })
  })

  describe('mention pattern matching', () => {
    it('returns false for missing patterns', () => {
      expect(matchesMentionPattern('hello', undefined)).toBe(false)
    })
    it('case-insensitive regex match', () => {
      expect(matchesMentionPattern('Hey Claude!', ['^hey claude\\b'])).toBe(true)
    })
    it('skips bad regex without throwing', () => {
      expect(matchesMentionPattern('test', ['(unclosed'])).toBe(false)
    })
  })

  describe('persistence', () => {
    it('round-trips access file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ac-'))
      const path = join(dir, 'access.json')
      const a: Access = { ...defaultAccess(), allowFrom: ['u1'], dmPolicy: 'allowlist' }
      writeAccessFile(path, a)
      const back = readAccessFile(path)
      expect(back.allowFrom).toEqual(['u1'])
      expect(back.dmPolicy).toBe('allowlist')
    })

    it('falls back to default for missing file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ac-'))
      const a = readAccessFile(join(dir, 'access.json'))
      expect(a.dmPolicy).toBe('pairing')
      expect(a.allowFrom).toEqual([])
    })

    it('moves corrupt file aside and returns default', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ac-'))
      const path = join(dir, 'access.json')
      writeFileSync(path, 'this is not json')
      const a = readAccessFile(path)
      expect(a.dmPolicy).toBe('pairing')
    })
  })

  describe('pruneExpired', () => {
    it('removes expired entries and returns true', () => {
      const a: Access = {
        ...defaultAccess(),
        pending: {
          old: { senderId: 'u', chatId: 'c', createdAt: 0, expiresAt: 1, replies: 1 },
          fresh: { senderId: 'u', chatId: 'c', createdAt: 0, expiresAt: 9_999_999_999_999, replies: 1 },
        },
      }
      expect(pruneExpired(a)).toBe(true)
      expect(a.pending.old).toBeUndefined()
      expect(a.pending.fresh).toBeDefined()
    })
  })
})
