/**
 * Safety helpers — must be called before sending data outbound.
 *
 * - assertSendable: refuse to send STATE_DIR-internal files (except inbox/)
 *   as attachments. Caller is the reply tool handler.
 * - safeAttName: scrub control characters from upload-controlled filenames
 *   so they can't forge meta-row delimiters in inbound notifications.
 */

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import type { Paths } from '../shared/paths.ts'

/**
 * Throws if `f` resolves to a path inside STATE_DIR but outside STATE_DIR/inbox.
 * Inbox attachments are explicitly OK to send (they came from Discord).
 *
 * Robust to dangling symlinks: if realpath fails, we don't pretend to know — we
 * fall through (statSync will fail later with a clearer error to the caller).
 */
export function assertSendable(f: string, paths: Paths): void {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(paths.stateDir)
  } catch {
    return
  }
  let inboxReal: string | null = null
  try {
    inboxReal = realpathSync(paths.inboxDir)
  } catch {
    inboxReal = null
  }
  if (
    real === stateReal ||
    (real.startsWith(stateReal + sep) &&
      !real.startsWith(paths.inboxDir + sep) &&
      (inboxReal === null || !real.startsWith(inboxReal + sep)))
  ) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

/**
 * Strip delimiter / control chars from upload-controlled file names.
 *
 * Replaces `[]`, `\r`, `\n`, `;` with `_`. Empty result falls back to a
 * placeholder so we never emit empty meta values.
 */
export function safeAttName(name: string | null | undefined): string {
  if (!name) return 'attachment'
  const cleaned = name.replace(/[\[\]\r\n;]/g, '_').trim()
  // If the result is empty or only the substitution character, that name
  // carries no useful info — fall back to a generic placeholder.
  if (cleaned.length === 0 || /^_+$/.test(cleaned)) return 'attachment'
  return cleaned
}
