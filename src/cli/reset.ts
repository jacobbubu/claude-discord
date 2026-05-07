/**
 * `claude-discord-bot reset [--routing] [--inbox] [--pending] [--all] [--including-token]`
 *
 * Clears local state files in scoped batches. Never touches allowFrom / groups
 * / mentionPatterns unless --including-acl is added. Token only goes when
 * --including-token is explicit.
 */

import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultAccess,
  readAccessFile,
  writeAccessFile,
} from '../daemon/access-control.ts'
import { resolvePaths } from '../shared/paths.ts'

export type ResetOpts = {
  routing?: boolean
  inbox?: boolean
  pending?: boolean
  all?: boolean
  includingToken?: boolean
  includingAcl?: boolean
}

export function reset(opts: ResetOpts): void {
  const paths = resolvePaths()
  const want = (k: keyof ResetOpts) => Boolean(opts[k] || opts.all)

  const cleared: string[] = []

  if (want('routing') && existsSync(paths.routingFile)) {
    unlinkSync(paths.routingFile)
    cleared.push('routing.json')
  }

  if (want('inbox') && existsSync(paths.inboxDir)) {
    for (const f of readdirSync(paths.inboxDir)) {
      try {
        unlinkSync(join(paths.inboxDir, f))
      } catch {}
    }
    cleared.push('inbox/*')
  }

  if ((want('pending') || want('all')) && existsSync(paths.accessFile)) {
    const a = readAccessFile(paths.accessFile)
    if (Object.keys(a.pending).length > 0) {
      a.pending = {}
      writeAccessFile(paths.accessFile, a)
      cleared.push('access.json pending')
    }
  }

  if (opts.includingAcl && existsSync(paths.accessFile)) {
    writeAccessFile(paths.accessFile, defaultAccess())
    cleared.push('access.json (acl reset)')
  }

  if (opts.includingToken && existsSync(paths.envFile)) {
    unlinkSync(paths.envFile)
    cleared.push('.env')
  }

  // Always sweep approved/ — it's never long-term state
  if (existsSync(paths.approvedDir)) {
    for (const f of readdirSync(paths.approvedDir)) {
      try {
        unlinkSync(join(paths.approvedDir, f))
      } catch {}
    }
    cleared.push('approved/*')
  }

  if (cleared.length === 0) {
    process.stdout.write('Nothing to reset (no flags given or no matching state).\n')
    process.stdout.write('Flags: --routing | --inbox | --pending | --all | --including-token | --including-acl\n')
    return
  }

  process.stdout.write('Cleared:\n')
  for (const c of cleared) process.stdout.write(`  • ${c}\n`)
  // We rely on the caller to restart the daemon; reset doesn't auto-start.
}
