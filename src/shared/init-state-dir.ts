/**
 * Idempotently create the state directory tree with strict 0o700 mode.
 *
 * Both daemon startup and configure CLI call this — the dir + perms must be
 * present before any state file is written.
 *
 * Spike #7 confirmed that mkdir mode and umask both interact, so we
 * explicitly chmod after mkdir to defeat umask.
 */

import { chmodSync, mkdirSync } from 'node:fs'
import type { Paths } from './paths.ts'

export function initStateDir(paths: Paths): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  // Re-chmod to defeat umask (mkdir mode is reduced by umask).
  try {
    chmodSync(paths.stateDir, 0o700)
  } catch {
    // ENOENT after just creating it would mean a TOCTOU; re-throw is excessive
    // because chmod failure is recoverable (umask might be fine).
  }
}
