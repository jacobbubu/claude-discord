/**
 * `claude-discord-bot configure <token>`
 *
 * Writes the Discord bot token to the .env file with strict 0o600 mode.
 * Preserves any other env vars already in the file.
 */

import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { atomicWrite } from '../shared/atomic-write.ts'
import { initStateDir } from '../shared/init-state-dir.ts'
import { log } from '../shared/logger.ts'
import { resolvePaths } from '../shared/paths.ts'

export function configure(token: string): void {
  const trimmed = token.trim()
  if (!trimmed) {
    log.error('configure: token is empty')
    process.exit(1)
  }
  if (/[\r\n]/.test(trimmed)) {
    log.error('configure: token contains newlines (cannot be a valid Discord token)')
    process.exit(1)
  }

  const paths = resolvePaths()
  initStateDir(paths)

  // Read existing .env (if any), update DISCORD_BOT_TOKEN, preserve others.
  const lines: string[] = []
  let updated = false

  if (existsSync(paths.envFile)) {
    try {
      chmodSync(paths.envFile, 0o600) // tighten any pre-existing relaxed mode
    } catch {}
    for (const line of readFileSync(paths.envFile, 'utf8').split('\n')) {
      if (line.startsWith('DISCORD_BOT_TOKEN=')) {
        lines.push(`DISCORD_BOT_TOKEN=${trimmed}`)
        updated = true
      } else if (line.length > 0) {
        lines.push(line)
      }
    }
  }
  if (!updated) lines.push(`DISCORD_BOT_TOKEN=${trimmed}`)

  atomicWrite(paths.envFile, lines.join('\n') + '\n', 0o600)
  // Re-assert mode in case rename inherited a different one.
  chmodSync(paths.envFile, 0o600)

  // Don't echo the token. Use the first 6 chars as a fingerprint.
  const fp = trimmed.slice(0, 6)
  process.stdout.write(`Configured Discord bot token (starts with "${fp}…").\n`)
  process.stdout.write(`Wrote: ${paths.envFile} (mode 0o600)\n`)
  process.stdout.write(`Restart the daemon to pick up the new token.\n`)
}
