/**
 * Integration: full pairing IPC chain.
 *
 *   1. seed access.json with a pending entry
 *   2. cmdPair(code) — CLI mutates allowFrom, deletes pending, writes
 *      approved/<senderId> with the DM channel id
 *   3. startApprovalWatcher (with intervalMs small) — picks up the file,
 *      calls handler, deletes file
 *   4. handler is mock gateway.send → "Paired! Say hi to Claude."
 *
 * Verifies that the file IPC works end-to-end without spawning daemon.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { startApprovalWatcher, type ApprovalWatcher } from '../../approval-watcher.ts'
import { cmdPair, defaultAccess } from '../../../cli/access-mutate.ts'
import { makeMockGateway } from './_mock-gateway.ts'

describe('pairing IPC integration', () => {
  let stateDir: string
  let savedExit: typeof process.exit
  let savedEnv: string | undefined
  let watcher: ApprovalWatcher

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pair-'))
    mkdirSync(join(stateDir, 'approved'), { recursive: true, mode: 0o700 })
    savedExit = process.exit
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`)
    }) as typeof process.exit
    savedEnv = process.env.CLAUDE_DISCORD_STATE_DIR
    process.env.CLAUDE_DISCORD_STATE_DIR = stateDir
  })

  afterEach(() => {
    watcher?.stop()
    process.exit = savedExit
    if (savedEnv === undefined) delete process.env.CLAUDE_DISCORD_STATE_DIR
    else process.env.CLAUDE_DISCORD_STATE_DIR = savedEnv
  })

  it('seed pending → cmdPair → approved file → watcher → gateway.send "Paired!"', async () => {
    // 1. Seed access.json with a fresh pending entry
    const now = Date.now()
    writeAccessFile(join(stateDir, 'access.json'), {
      ...defaultAccess(),
      pending: {
        abc123: {
          senderId: 'u1',
          chatId: 'cdm1',
          createdAt: now,
          expiresAt: now + 60_000,
          replies: 1,
        },
      },
    })

    // 2. Run cmdPair — mutates access.json + writes approved/u1
    cmdPair('abc123')
    const access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8'))
    expect(access.allowFrom).toContain('u1')
    expect(access.pending.abc123).toBeUndefined()
    expect(existsSync(join(stateDir, 'approved', 'u1'))).toBe(true)
    expect(readFileSync(join(stateDir, 'approved', 'u1'), 'utf8')).toBe('cdm1')

    // 3. Start approval-watcher with mock gateway
    const gateway = makeMockGateway()
    watcher = startApprovalWatcher(
      join(stateDir, 'approved'),
      async ({ chatId }) => {
        await gateway.send(chatId, 'Paired! Say hi to Claude.')
      },
      50,
    )

    // wait for the initial tick + handler to flush
    await new Promise(r => setTimeout(r, 100))

    // 4. Verify gateway.send was called with the right chatId + content,
    //    and the approved file was deleted
    expect(gateway.sentMessages.length).toBe(1)
    expect(gateway.sentMessages[0]!.channelId).toBe('cdm1')
    expect(gateway.sentMessages[0]!.content).toMatch(/Paired!/)
    expect(existsSync(join(stateDir, 'approved', 'u1'))).toBe(false)
  })
})
