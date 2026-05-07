/**
 * `claude-discord-bot status`
 *
 * Reports daemon health by:
 *   - Checking the socket file exists
 *   - Trying to connect to the socket (proves the daemon is actively listening)
 *   - Querying launchd / systemd for service registration state
 *   - Showing where state lives + whether .env is present
 *
 * Slice 5 keeps this lean — Discord-side connection state and active workspace
 * counts require an in-band protocol message daemon→cli, deferred to slice 6.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { resolvePaths } from '../shared/paths.ts'
import { DAEMON_LABEL, SYSTEMD_UNIT, detectPlatform } from '../installer/plan.ts'

const probeSocket = (path: string, timeoutMs = 500): Promise<boolean> =>
  new Promise(resolve => {
    if (!existsSync(path)) {
      resolve(false)
      return
    }
    const sock = connect(path)
    const t = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(t)
      sock.end()
      resolve(true)
    })
    sock.once('error', () => {
      clearTimeout(t)
      resolve(false)
    })
  })

function serviceState(): string {
  const plat = detectPlatform()
  if (plat === 'macos') {
    const uid = process.getuid?.() ?? -1
    const out = spawnSync('launchctl', ['print', `gui/${uid}/${DAEMON_LABEL}`], {
      encoding: 'utf8',
    })
    if (out.status === 0) {
      const pidLine = (out.stdout || '').split('\n').find(l => l.includes('pid '))
      return `installed (${pidLine?.trim() ?? 'launchd registered'})`
    }
    return 'not installed'
  }
  if (plat === 'linux') {
    const out = spawnSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], {
      encoding: 'utf8',
    })
    return `systemd: ${(out.stdout || '').trim() || 'unknown'}`
  }
  return `unsupported (${process.platform})`
}

export async function status(): Promise<void> {
  const paths = resolvePaths()
  process.stdout.write(`State dir:   ${paths.stateDir}\n`)
  process.stdout.write(`.env:        ${existsSync(paths.envFile) ? 'present' : 'absent'}\n`)
  process.stdout.write(`access.json: ${existsSync(paths.accessFile) ? 'present' : 'absent'}\n`)
  process.stdout.write(`Socket:      ${paths.socketPath}\n`)

  const sockOk = await probeSocket(paths.socketPath)
  process.stdout.write(`  → ${sockOk ? 'listening' : 'not reachable (daemon may not be running)'}\n`)

  process.stdout.write(`Service:     ${serviceState()}\n`)
}
