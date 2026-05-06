/**
 * Daemon entry — slice 3.
 *
 * Pipeline at startup:
 *   initStateDir → start socket-server (plugin side) → start discord-gateway
 *   → wire inbound handler → start approval-watcher → idle until shutdown.
 *
 * Shutdown order (matters):
 *   socket-server bye-broadcast & close → discord-gateway destroy → exit.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { ChannelType } from 'discord.js'
import { initStateDir } from '../shared/init-state-dir.ts'
import { log } from '../shared/logger.ts'
import { resolvePaths } from '../shared/paths.ts'
import { startApprovalWatcher } from './approval-watcher.ts'
import { startDiscordGateway } from './discord-gateway.ts'
import { makeInboundHandler } from './inbound-router.ts'
import { WorkspaceRegistry } from './registry.ts'
import { RoutingTable } from './routing.ts'
import { startSocketServer } from './socket-server.ts'

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths()
  initStateDir(paths)
  mkdirSync(paths.approvedDir, { recursive: true, mode: 0o700 })

  if (existsSync(paths.envFile)) {
    try {
      chmodSync(paths.envFile, 0o600)
    } catch (e) {
      log.warn(`could not chmod .env: ${e}`)
    }
  }

  const registry = new WorkspaceRegistry()
  const routing = new RoutingTable(paths.routingFile)
  const sockServer = startSocketServer(paths, registry)

  const gateway = await startDiscordGateway(paths)

  if (gateway) {
    const handler = makeInboundHandler({
      accessFile: paths.accessFile,
      gateway,
      registry,
      routing,
    })
    gateway.client.on('messageCreate', msg => {
      if (msg.author.bot) return
      if (msg.channel.type === ChannelType.DM) {
        gateway.noteDmRecipient(msg.channelId, msg.author.id)
      }
      handler(msg)
    })
  } else {
    log.warn(
      'discord gateway not started — daemon runs without Discord (configure token to enable)',
    )
  }

  const approvalWatcher = startApprovalWatcher(paths.approvedDir, async ({ chatId }) => {
    if (gateway) {
      await gateway.send(chatId, 'Paired! Say hi to Claude.')
    } else {
      log.warn(`approval-watcher: no gateway, can't send Paired! confirmation for ${chatId}`)
    }
  })

  log.info(`daemon started — state dir: ${paths.stateDir}`)
  log.info(`pid=${process.pid} uid=${process.getuid?.()}`)

  let resolveExit: () => void
  const exitPromise = new Promise<void>(r => {
    resolveExit = r
  })

  let shuttingDown = false
  const onShutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${signal}, shutting down`)
    approvalWatcher.stop()
    void sockServer
      .close()
      .catch(e => log.error(`socket server close failed: ${e}`))
      .then(() => (gateway ? gateway.shutdown() : undefined))
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
