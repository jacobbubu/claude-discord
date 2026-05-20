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
import { attachFileSink, log } from '../shared/logger.ts'
import { readPackageVersion } from '../shared/package-version.ts'
import { resolvePaths } from '../shared/paths.ts'
import { startApprovalWatcher } from './approval-watcher.ts'
import { startDiscordGateway } from './discord-gateway.ts'
import { makeInboundHandler } from './inbound-router.ts'
import { PermissionRelay } from './permission-relay.ts'
import { reconcileIndicators } from './pinned-indicator.ts'
import { WorkspaceRegistry } from './registry.ts'
import { RingBufferMap } from './ring-buffer.ts'
import { RoutingTable } from './routing.ts'
import {
  attachInteractionHandler,
  listWorkspacesByActivity,
  registerSlashCommands,
  workspaceListChanged,
} from './slash-commands.ts'
import {
  startSocketServer,
  type CcPermissionRequestHandler,
  type CcStopHandler,
  type CcToolTraceHandler,
  type PermissionRequestHandler,
  type ToolCallHandler,
} from './socket-server.ts'
import { dispatchToolCall, type ToolContext } from './tool-handlers.ts'
import { ToolTraceRelay } from './tool-trace.ts'
import { TypingHeartbeat } from './typing-heartbeat.ts'

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths()
  initStateDir(paths)
  mkdirSync(paths.approvedDir, { recursive: true, mode: 0o700 })

  // Deltas §31: daemon owns its log file with size-based rotation, so log
  // growth is bounded regardless of how the launcher redirects stdout/stderr.
  // Stderr still mirrors everything for foreground / nohup-redirected runs.
  attachFileSink({ path: paths.daemonLog })

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

  // §33: keep the "claude is typing…" dot alive between inbound and reply,
  // re-typing every ~8s so long CC tasks don't look hung. Started by
  // inbound-router on each inbound; stopped by reply/edit/thread tool handlers.
  const typingHeartbeat = gateway
    ? new TypingHeartbeat(async chatId => {
        try {
          const ch = await gateway.client.channels.fetch(chatId)
          if (ch && 'sendTyping' in ch) {
            await (ch as { sendTyping: () => Promise<void> }).sendTyping()
          }
        } catch {
          /* best-effort */
        }
      })
    : null

  // §33: plugin disconnects / cap-evictions clear that workspace's typing
  // dots instead of waiting for the 5min safety cap.
  if (typingHeartbeat) {
    registry.onWorkspaceRemoved(name => typingHeartbeat.stopByWorkspace(name))
  }

  // Build the real tool dispatcher (or echo fallback if gateway absent).
  const toolDispatcher: ToolCallHandler = gateway
    ? async (workspace, tool, args) => {
        const ctx: ToolContext = {
          gateway,
          ringBuffers,
          paths,
          workspace,
          typingHeartbeat: typingHeartbeat ?? undefined,
          // §35: on successful reply-class tool, slide the workspace's turn
          // into sunset (30s tail) so subsequent terminal-driven tool calls
          // get correctly deferred to TUI / dropped from trace.
          // §36: a delivered reply also ends any cancel obligation — user got
          // their response, /cancel doesn't need to keep denying tools.
          onReplyDelivered: () => {
            const c = registry.get(workspace)
            if (!c) return
            c.startSunset()
            c.cancelPending = false
          },
        }
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

  // Architecture deltas §15: anonymous hook-conn permission requests for
  // CC built-in tools (Read / Bash / Edit / ...). Same DM flow.
  const ccPermissionHandler: CcPermissionRequestHandler = permissionRelay
    ? async (conn, msg) => permissionRelay.handleCcRequest(conn, msg)
    : async () => {
        log.warn('cc_permission_request received but discord gateway not running — denying')
      }

  // Architecture deltas §24: PostToolUse trace relay. Needs gateway for
  // thread create + send; degraded mode (no gateway) drops traces silently.
  const traceRelay = gateway ? new ToolTraceRelay(gateway, registry) : null
  const ccToolTraceHandler: CcToolTraceHandler = traceRelay
    ? msg => traceRelay.handle(msg)
    : () => {
        /* no gateway — nothing we can do with a trace */
      }

  // Architecture deltas §36: Stop hook → end §35 turn lifecycle precisely
  // (skip the 30s sunset tail) and clear any /cancel flag now that the turn
  // has actually finished. cwd lookup mirrors cc_permission_request routing.
  // Architecture deltas §37: also archive the per-turn trace thread so it
  // drops out of Discord's "Active threads" list immediately (the shortest
  // autoArchiveDuration is 60min — too slow for rapid multi-turn use).
  const ccStopHandler: CcStopHandler = msg => {
    const wsConn = registry.list().find(c => c.cwd === msg.cwd)
    if (!wsConn) {
      log.debug(`cc_stop: no workspace matched cwd=${msg.cwd}`)
      return
    }
    if (typingHeartbeat) typingHeartbeat.stopByWorkspace(wsConn.workspace ?? '')
    const threadId = wsConn.activeTraceThreadId
    wsConn.clearTurn()
    wsConn.activeTraceThreadId = null
    if (threadId && traceRelay) {
      void traceRelay.archiveThread(threadId)
    }
  }

  const sockServer = startSocketServer(
    paths,
    registry,
    toolDispatcher,
    permissionHandler,
    ccPermissionHandler,
    ccToolTraceHandler,
    ccStopHandler,
  )

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
      typingHeartbeat: typingHeartbeat ?? undefined,
      // §41: lets the router redirect inbound from old daemon-created trace
      // threads back to the parent channel so new turn traces don't get
      // jammed into the old thread.
      isTraceThread: traceRelay
        ? threadId => traceRelay.isOurTraceThread(threadId)
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
    // §29: most-recently-active first — so mobile users see their relevant
    // workspace at the top of the /use dropdown, and >25 sets surface what
    // matters within the Discord choices cap.
    const currentWorkspaces = (): string[] => listWorkspacesByActivity(registry.list())
    // §30: small grace after clientReady so plugin processes that were
    // already running can reconnect + re-register *before* we publish the
    // first slash command set. Without this, the first PUT often has empty
    // choices (no plugin re-registered yet) — the debounced onChange catches
    // up in ~1s, but a mobile user who opens /use in that window sees an
    // empty dropdown until they refresh.
    const STARTUP_GRACE_MS = 2_000

    gateway.client.once('clientReady', async () => {
      const token = process.env.DISCORD_BOT_TOKEN
      if (!token) return

      // §53: catch up any channel whose indicator was lost across restarts
      // (manual pin delete, daemon crash mid-bind, upgrade from a version
      // that didn't track indicators). Fire-and-forget — slash registration
      // shouldn't wait on Discord API roundtrips for every bound channel.
      void reconcileIndicators({ gateway, routing }).catch(e =>
        log.warn(`pinned-indicator: startup reconcile failed: ${e}`),
      )

      // Note: registry.onChange isn't subscribed yet, so any plugin that
      // registers during this window just updates the registry — no PUT
      // is triggered. The post-grace snapshot below picks them up.
      await new Promise(r => setTimeout(r, STARTUP_GRACE_MS))

      let lastRegistered = currentWorkspaces()
      await registerSlashCommands(gateway.client, token, undefined, () => lastRegistered).catch(e =>
        log.warn(`slash registration failed: ${e}`),
      )

      // Architecture deltas §29: re-register slash commands when the workspace
      // set changes, so /use's static choices stay live. Debounce a flurry of
      // (un)registers; only PUT when the membership actually changed.
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      registry.onChange(() => {
        if (debounceTimer) return
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          const curr = currentWorkspaces()
          if (!workspaceListChanged(lastRegistered, curr)) return
          lastRegistered = curr
          log.info(`slash: workspaces changed (now ${curr.length}) — re-registering`)
          void registerSlashCommands(gateway.client, token, undefined, () => curr).catch(e =>
            log.warn(`slash re-registration failed: ${e}`),
          )
        }, 500)
        debounceTimer.unref?.()
      })
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

  log.info(`daemon started — claude-discord-bot v${readPackageVersion()}, state dir: ${paths.stateDir}`)
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
    permissionRelay?.stop()
    typingHeartbeat?.stopAll()
    routing.stopWatching()
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
