/**
 * Daemon entry — slice 4.
 *
 * Pipeline at startup:
 *   initStateDir → start socket-server (with real tool dispatcher) →
 *   start discord-gateway → register slash commands on ready →
 *   wire inbound handler + slash interaction handler →
 *   start approval-watcher → idle until shutdown.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { ChannelType } from 'discord.js'
import { initStateDir } from '../shared/init-state-dir.ts'
import { log } from '../shared/logger.ts'
import { resolvePaths } from '../shared/paths.ts'
import { startApprovalWatcher } from './approval-watcher.ts'
import { startDiscordGateway } from './discord-gateway.ts'
import { makeInboundHandler } from './inbound-router.ts'
import { PermissionRelay } from './permission-relay.ts'
import { WorkspaceRegistry } from './registry.ts'
import { RingBufferMap } from './ring-buffer.ts'
import { RoutingTable } from './routing.ts'
import {
  attachInteractionHandler,
  registerSlashCommands,
} from './slash-commands.ts'
import {
  startSocketServer,
  type PermissionRequestHandler,
  type ToolCallHandler,
} from './socket-server.ts'
import { dispatchToolCall, type ToolContext } from './tool-handlers.ts'

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
  const ringBuffers = new RingBufferMap()
  // LRU eviction → drop the workspace's ring buffer too so memory doesn't
  // leak across an evict-then-reregister cycle.
  registry.onEviction(name => ringBuffers.delete(name))

  const gateway = await startDiscordGateway(paths)

  // Build the real tool dispatcher (or echo fallback if gateway absent).
  const toolDispatcher: ToolCallHandler = gateway
    ? async (workspace, tool, args) => {
        const ctx: ToolContext = { gateway, ringBuffers, paths, workspace }
        return await dispatchToolCall(ctx, tool, args)
      }
    : async () => ({ ok: false, error: 'discord gateway not running' })

  // Permission relay only makes sense when Discord is connected — otherwise
  // there's no UI for the user to approve/deny.
  const permissionRelay = gateway
    ? new PermissionRelay(gateway, registry, paths)
    : null

  const permissionHandler: PermissionRequestHandler = permissionRelay
    ? async (workspace, msg) => permissionRelay.handlePluginRequest(workspace, msg)
    : async () => {
        log.warn('permission_request received but discord gateway not running — denying')
      }

  const sockServer = startSocketServer(paths, registry, toolDispatcher, permissionHandler)

  if (gateway) {
    const inbound = makeInboundHandler({
      accessFile: paths.accessFile,
      gateway,
      registry,
      routing,
      ringBuffers,
      permissionTextIntercept: permissionRelay
        ? (senderId, text) => permissionRelay.handleTextResponse(senderId, text)
        : undefined,
    })
    gateway.client.on('messageCreate', msg => {
      if (msg.author.bot) return
      if (msg.channel.type === ChannelType.DM) {
        gateway.noteDmRecipient(msg.channelId, msg.author.id)
      }
      inbound(msg)
    })

    const interactionHandler = attachInteractionHandler({
      gateway,
      registry,
      routing,
      ringBuffers,
      paths,
      buttonIntercept: permissionRelay
        ? async i => permissionRelay.handleButton(i)
        : undefined,
    })
    gateway.client.on('interactionCreate', interactionHandler)

    // Register slash commands once the bot is ready (needs guild list).
    // 'clientReady' is the v15-forward name for what was 'ready' in v14.
    gateway.client.once('clientReady', async () => {
      const token = process.env.DISCORD_BOT_TOKEN
      if (token) {
        await registerSlashCommands(gateway.client, token).catch(e =>
          log.warn(`slash registration failed: ${e}`),
        )
      }
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
