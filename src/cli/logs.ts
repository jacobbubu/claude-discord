/**
 * `claude-discord-bot logs [-f]` — show daemon logs.
 *
 * Default: prints the last 200 lines of stdout + stderr.
 * -f / --follow: spawn `tail -f` on both files.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolvePaths } from '../shared/paths.ts'

export type LogsOpts = { follow?: boolean }

export function logs(opts: LogsOpts = {}): void {
  const paths = resolvePaths()

  const present = (path: string): string =>
    existsSync(path) ? path : ''

  const out = present(paths.outLog)
  const err = present(paths.errLog)

  if (!out && !err) {
    process.stdout.write(
      `No daemon logs found at ${paths.outLog} or ${paths.errLog}\n`,
    )
    process.stdout.write(
      `If the daemon is running via launchctl/systemctl, those services write logs there per the install plist/unit.\n`,
    )
    return
  }

  if (opts.follow) {
    const args = ['-F']
    if (out) args.push(out)
    if (err) args.push(err)
    const child = spawn('tail', args, { stdio: 'inherit' })
    process.on('SIGINT', () => child.kill('SIGINT'))
    process.on('SIGTERM', () => child.kill('SIGTERM'))
    return
  }

  const args = ['-n', '200']
  if (out) args.push(out)
  if (err) args.push(err)
  const r = spawnSync('tail', args, { encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
}
