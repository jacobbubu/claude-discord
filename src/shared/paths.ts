/**
 * State directory + file paths for the daemon and CLI.
 *
 * Resolution order:
 *   1. CLAUDE_DISCORD_STATE_DIR env var (explicit override)
 *   2. ~/.claude/channels/discord/ (default, matches upstream)
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export type Paths = {
  stateDir: string
  envFile: string
  accessFile: string
  routingFile: string
  approvedDir: string
  inboxDir: string
  socketPath: string
  outLog: string
  errLog: string
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const stateDir = env.CLAUDE_DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
  return {
    stateDir,
    envFile: join(stateDir, '.env'),
    accessFile: join(stateDir, 'access.json'),
    routingFile: join(stateDir, 'routing.json'),
    approvedDir: join(stateDir, 'approved'),
    inboxDir: join(stateDir, 'inbox'),
    socketPath: join(stateDir, 'daemon.sock'),
    outLog: join(stateDir, 'daemon.out.log'),
    errLog: join(stateDir, 'daemon.err.log'),
  }
}
