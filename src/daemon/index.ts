/**
 * Daemon entry — slice 1 stub.
 *
 * Initializes state directory, then idles until SIGTERM/SIGINT/stdin EOF.
 * Discord client, socket server, registry, ring buffer all land in later
 * slices.
 */

import { chmodSync, existsSync } from 'node:fs'
import { initStateDir } from '../shared/init-state-dir.ts'
import { log } from '../shared/logger.ts'
import { resolvePaths } from '../shared/paths.ts'

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths()
  initStateDir(paths)

  // Strict mode on .env if it already exists; missing-file is OK in slice 1
  // (configure subcommand creates it).
  if (existsSync(paths.envFile)) {
    try {
      chmodSync(paths.envFile, 0o600)
    } catch (e) {
      log.warn(`could not chmod .env: ${e}`)
    }
  }

  log.info(`daemon started (slice 1 stub) — state dir: ${paths.stateDir}`)
  log.info(`pid=${process.pid} uid=${process.getuid?.()}`)
  if (existsSync(paths.envFile)) {
    log.info(`.env present`)
  } else {
    log.warn(`.env not present — run "claude-discord-bot configure <token>" first`)
  }

  // Slice 1 has no business loop. Idle until told to stop.
  let resolveExit: () => void
  const exitPromise = new Promise<void>(r => {
    resolveExit = r
  })

  const onShutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`)
    resolveExit()
  }
  process.on('SIGTERM', () => onShutdown('SIGTERM'))
  process.on('SIGINT', () => onShutdown('SIGINT'))
  // stdin EOF — happens when CC closes the MCP connection or the parent
  // pipes go away.
  process.stdin.on('end', () => onShutdown('stdin EOF'))
  process.stdin.on('close', () => onShutdown('stdin close'))

  // Global safety net: don't die on a single unhandled rejection.
  process.on('unhandledRejection', err => {
    log.error(`unhandled rejection: ${err}`)
  })
  process.on('uncaughtException', err => {
    log.error(`uncaught exception: ${err}`)
  })

  await exitPromise
  log.info(`daemon exited cleanly`)
}
