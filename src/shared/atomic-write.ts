/**
 * Atomic file write: write to .tmp, then rename. Avoids partial-write reads.
 */

import { renameSync, writeFileSync } from 'node:fs'

export function atomicWrite(path: string, content: string | Buffer, mode: number): void {
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, content, { mode })
  renameSync(tmp, path)
}
