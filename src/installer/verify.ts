/**
 * Post-install verification — checks that the service is actually registered
 * and (if possible) running.
 */

import { spawnSync } from 'node:child_process'
import type { InstallPlan } from './plan.ts'
import { DAEMON_LABEL, SYSTEMD_UNIT } from './plan.ts'

export type VerifyResult = {
  ok: boolean
  detail: string
}

export function verifyInstall(plan: InstallPlan): VerifyResult {
  if (plan.platform === 'macos') return verifyLaunchd()
  return verifySystemd()
}

function verifyLaunchd(): VerifyResult {
  const uid = process.getuid?.() ?? -1
  const out = spawnSync('launchctl', ['print', `gui/${uid}/${DAEMON_LABEL}`], {
    encoding: 'utf8',
  })
  if (out.status === 0) {
    const pidLine = (out.stdout || '').split('\n').find(l => l.includes('pid '))
    return { ok: true, detail: pidLine?.trim() ?? 'service registered' }
  }
  return { ok: false, detail: `launchctl print failed: ${out.stderr}` }
}

function verifySystemd(): VerifyResult {
  const out = spawnSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], {
    encoding: 'utf8',
  })
  const status = (out.stdout || '').trim()
  if (status === 'active') return { ok: true, detail: 'service active' }
  return { ok: false, detail: `systemctl is-active: ${status}` }
}
