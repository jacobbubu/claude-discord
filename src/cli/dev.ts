/**
 * `claude-discord-bot dev` — foreground daemon with file watch (auto-restart
 * on .ts changes during development).
 *
 * Implementation: re-spawn ourselves as `bun --watch ${this script} start`.
 * We don't import & re-call runDaemon directly because then file changes to
 * runDaemon's deps wouldn't take effect (Bun's watch mode is process-level).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export function dev(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const cliEntry = resolve(here, 'index.ts')
  const child = spawn('bun', ['--watch', 'run', cliEntry, 'start'], {
    stdio: 'inherit',
  })
  child.on('exit', code => process.exit(code ?? 0))
  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
}
