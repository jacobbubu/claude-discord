/**
 * `claude-discord-bot stop` — stop the installed service without uninstalling.
 *
 * macOS: `launchctl bootout` (same as uninstall's first step, but we don't
 * delete the plist).
 * Linux: `systemctl --user stop`.
 */

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_LABEL, SYSTEMD_UNIT, detectPlatform } from '../installer/plan.ts'

export function stop(): void {
  const plat = detectPlatform()
  const uid = process.getuid?.() ?? -1

  if (plat === 'macos') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`)
    const r = spawnSync('launchctl', ['bootout', `gui/${uid}`, plist], {
      encoding: 'utf8',
    })
    process.stdout.write(`launchctl bootout exit ${r.status}\n`)
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    return
  }
  if (plat === 'linux') {
    const r = spawnSync('systemctl', ['--user', 'stop', SYSTEMD_UNIT], { encoding: 'utf8' })
    process.stdout.write(`systemctl stop exit ${r.status}\n`)
    if (r.stderr) process.stderr.write(r.stderr)
    return
  }
  process.stderr.write(`[error] unsupported platform: ${process.platform}\n`)
  process.exit(1)
}
