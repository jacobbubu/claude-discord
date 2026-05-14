/**
 * `claude-discord-bot logs [-f]` — show daemon logs.
 *
 * Preference order (deltas §31):
 *   1. `daemon.log` (daemon-owned, size-rotated; `.1..N` are previous slices)
 *   2. fallback: `daemon.out.log` + `daemon.err.log` (launchd/systemd plist
 *      target, used when the daemon-owned file isn't present — e.g. older
 *      daemon versions, or installs where the daemon never ran locally).
 *
 * Default: last 200 lines. `-f / --follow`: `tail -F`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolvePaths } from '../shared/paths.ts'

export type LogsOpts = { follow?: boolean }

export function logs(opts: LogsOpts = {}): void {
  const paths = resolvePaths()

  const present = (path: string): string =>
    existsSync(path) ? path : ''

  // Prefer the daemon-owned rotating log if it exists.
  const dlog = present(paths.daemonLog)
  const out = present(paths.outLog)
  const err = present(paths.errLog)
  const sources = dlog ? [dlog] : [out, err].filter(Boolean)

  if (sources.length === 0) {
    process.stdout.write(
      `No daemon logs found at ${paths.daemonLog}, ${paths.outLog}, or ${paths.errLog}\n`,
    )
    process.stdout.write(
      `If the daemon is running via launchctl/systemctl, those services write logs there per the install plist/unit.\n`,
    )
    return
  }

  if (opts.follow) {
    const child = spawn('tail', ['-F', ...sources], { stdio: 'inherit' })
    process.on('SIGINT', () => child.kill('SIGINT'))
    process.on('SIGTERM', () => child.kill('SIGTERM'))
    return
  }

  const r = spawnSync('tail', ['-n', '200', ...sources], { encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
}
