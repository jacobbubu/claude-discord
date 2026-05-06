import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startApprovalWatcher, type ApprovalWatcher } from '../approval-watcher.ts'

describe('startApprovalWatcher', () => {
  let dir: string
  let watcher: ApprovalWatcher

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-'))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  })

  afterEach(() => {
    watcher?.stop()
  })

  it('reads file, calls handler, deletes file', async () => {
    writeFileSync(join(dir, 'sender123'), 'channel456')
    let received: { senderId: string; chatId: string } | null = null
    watcher = startApprovalWatcher(dir, a => {
      received = a
    }, 200)

    // initial tick runs synchronously; allow handler microtask to settle
    await new Promise(r => setTimeout(r, 50))
    expect(received).toEqual({ senderId: 'sender123', chatId: 'channel456' })
    expect(existsSync(join(dir, 'sender123'))).toBe(false)
  })

  it('skips file with empty contents and deletes it', async () => {
    writeFileSync(join(dir, 'senderEmpty'), '')
    let called = false
    watcher = startApprovalWatcher(dir, () => {
      called = true
    }, 200)
    await new Promise(r => setTimeout(r, 50))
    expect(called).toBe(false)
    expect(existsSync(join(dir, 'senderEmpty'))).toBe(false)
  })
})
