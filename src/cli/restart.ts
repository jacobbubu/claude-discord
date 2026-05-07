/**
 * `claude-discord-bot restart` — stop then start the installed service.
 *
 * Implementation defers to launchctl/systemctl (they handle the start side).
 */

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_LABEL, SYSTEMD_UNIT, detectPlatform } from '../installer/plan.ts'

export function restart(): void {
  const plat = detectPlatform()
  const uid = process.getuid?.() ?? -1

  if (plat === 'macos') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`)
    spawnSync('launchctl', ['bootout', `gui/${uid}`, plist], { encoding: 'utf8' })
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' })
    if (r.status !== 0) {
      process.stderr.write(`[error] launchctl bootstrap failed: ${r.stderr}\n`)
      process.exit(1)
    }
    process.stdout.write('✓ Restarted (launchctl bootstrap)\n')
    return
  }
  if (plat === 'linux') {
    const r = spawnSync('systemctl', ['--user', 'restart', SYSTEMD_UNIT], { encoding: 'utf8' })
    if (r.status !== 0) {
      process.stderr.write(`[error] systemctl restart failed: ${r.stderr}\n`)
      process.exit(1)
    }
    process.stdout.write('✓ Restarted (systemctl --user restart)\n')
    return
  }
  process.stderr.write(`[error] unsupported platform: ${process.platform}\n`)
  process.exit(1)
}
