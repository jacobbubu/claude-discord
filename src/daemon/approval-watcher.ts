/**
 * Watches the `approved/` directory for pairing-approval IPC files.
 *
 * Flow:
 *   1. CLI `claude-discord-bot pair <code>` mutates access.json + writes
 *      `approved/<senderId>` whose contents = the DM channel id
 *   2. This watcher polls every 5s, sees the file, calls onApproved(senderId, chatId)
 *      so the daemon can send "Paired! Say hi" to that DM
 *   3. The watcher deletes the file regardless of whether the DM send succeeded
 *
 * Why polling instead of fs.watch: spike #6 / upstream both use polling — it's
 * resilient to filesystem watcher dropouts and the 5s lag is acceptable for a
 * one-time approval action.
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../shared/logger.ts'

export type Approval = { senderId: string; chatId: string }
export type ApprovalHandler = (a: Approval) => Promise<void> | void

export type ApprovalWatcher = {
  stop(): void
}

export function startApprovalWatcher(
  approvedDir: string,
  onApproved: ApprovalHandler,
  intervalMs = 5_000,
): ApprovalWatcher {
  const tick = () => {
    let files: string[]
    try {
      files = readdirSync(approvedDir)
    } catch {
      return
    }
    for (const senderId of files) {
      const path = join(approvedDir, senderId)
      let chatId: string
      try {
        chatId = readFileSync(path, 'utf8').trim()
      } catch (e) {
        log.warn(`approval-watcher: read ${path} failed: ${e}`)
        try {
          rmSync(path, { force: true })
        } catch {}
        continue
      }
      if (!chatId) {
        try {
          rmSync(path, { force: true })
        } catch {}
        continue
      }
      void Promise.resolve(onApproved({ senderId, chatId }))
        .catch(e => log.warn(`approval-watcher: handler failed for ${senderId}: ${e}`))
        .finally(() => {
          try {
            rmSync(path, { force: true })
          } catch {}
        })
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref()
  // Run once immediately so a freshly written file is delivered without 5s lag
  // when daemon just started.
  tick()
  return { stop: () => clearInterval(timer) }
}
