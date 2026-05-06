/**
 * Daemon entry — slice 2.
 *
 * Initializes state directory, starts socket-server, then idles until
 * SIGTERM/SIGINT/stdin EOF. Discord client lands in slice 3.
 */

import { chmodSync, existsSync } from 'node:fs'
import { initStateDir } from '../shared/init-state-dir.ts'
import { log } from '../shared/logger.ts'
import { resolvePaths } from '../shared/paths.ts'
import { WorkspaceRegistry } from './registry.ts'
import { startSocketServer } from './socket-server.ts'

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths()
  initStateDir(paths)

  if (existsSync(paths.envFile)) {
    try {
      chmodSync(paths.envFile, 0o600)
    } catch (e) {
      log.warn(`could not chmod .env: ${e}`)
    }
  }

  const registry = new WorkspaceRegistry()
  const sockServer = startSocketServer(paths, registry)

  log.info(`daemon started — state dir: ${paths.stateDir}`)
  log.info(`pid=${process.pid} uid=${process.getuid?.()}`)
  if (existsSync(paths.envFile)) {
    log.info('.env present')
  } else {
    log.warn('.env not present — run "claude-discord-bot configure <token>" first')
  }

  let resolveExit: () => void
  const exitPromise = new Promise<void>(r => {
    resolveExit = r
  })

  let shuttingDown = false
  const onShutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${signal}, shutting down`)
    void sockServer
      .close()
      .catch(e => log.error(`socket server close failed: ${e}`))
      .finally(() => resolveExit())
  }
  process.on('SIGTERM', () => onShutdown('SIGTERM'))
  process.on('SIGINT', () => onShutdown('SIGINT'))
  process.stdin.on('end', () => onShutdown('stdin EOF'))
  process.stdin.on('close', () => onShutdown('stdin close'))

  process.on('unhandledRejection', err => log.error(`unhandled rejection: ${err}`))
  process.on('uncaughtException', err => log.error(`uncaught exception: ${err}`))

  await exitPromise
  log.info('daemon exited cleanly')
}
