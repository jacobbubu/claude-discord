/**
 * In-process test harness for controlled e2e tests.
 *
 * Composes the daemon's pieces (gateway / registry / routing / ring buffer /
 * inbound router / approval watcher / permission relay) wired to a MockClient
 * instead of real discord.js. Returns a handle the script can drive +
 * inspect.
 *
 * Skips runDaemon's process-level signal handlers — those are not safe to
 * register multiple times across vitest's test isolation.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelType, type Client as DiscordClient } from 'discord.js'
import { startApprovalWatcher, type ApprovalWatcher } from '../../approval-watcher.ts'
import { startDiscordGateway, type DiscordGateway } from '../../discord-gateway.ts'
import { makeInboundHandler } from '../../inbound-router.ts'
import { PermissionRelay } from '../../permission-relay.ts'
import { WorkspaceRegistry } from '../../registry.ts'
import { RingBufferMap } from '../../ring-buffer.ts'
import { RoutingTable } from '../../routing.ts'
import { startSocketServer, type ToolCallHandler } from '../../socket-server.ts'
import { dispatchToolCall, type ToolContext } from '../../tool-handlers.ts'
import { initStateDir } from '../../../shared/init-state-dir.ts'
import { resolvePaths, type Paths } from '../../../shared/paths.ts'
import { MockClient } from './_mock-client.ts'
import { attachInteractionHandler } from '../../slash-commands.ts'

export type Harness = {
  paths: Paths
  client: MockClient
  gateway: DiscordGateway
  registry: WorkspaceRegistry
  routing: RoutingTable
  ringBuffers: RingBufferMap
  permissionRelay: PermissionRelay
  approvalWatcher: ApprovalWatcher
  shutdown: () => Promise<void>
}

/**
 * Build a fresh harness in a tempdir. Caller awaits client login (clientReady)
 * before injecting messages.
 */
export async function buildHarness(): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'ce2e-'))
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'approved'), { recursive: true })

  const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
  initStateDir(paths)

  const client = new MockClient()

  const gateway = (await startDiscordGateway(paths, () => client as unknown as DiscordClient))!

  const registry = new WorkspaceRegistry()
  const routing = new RoutingTable(paths.routingFile)
  const ringBuffers = new RingBufferMap()
  registry.onEviction(name => ringBuffers.delete(name))

  const permissionRelay = new PermissionRelay(gateway, registry, paths)

  const toolDispatcher: ToolCallHandler = async (workspace, tool, args) => {
    const ctx: ToolContext = { gateway, ringBuffers, paths, workspace }
    return await dispatchToolCall(ctx, tool, args)
  }

  const sockServer = startSocketServer(paths, registry, toolDispatcher, async (workspace, msg) =>
    permissionRelay.handlePluginRequest(workspace, msg),
  )

  const inbound = makeInboundHandler({
    accessFile: paths.accessFile,
    gateway,
    registry,
    routing,
    ringBuffers,
    permissionTextIntercept: (senderId, text) => permissionRelay.handleTextResponse(senderId, text),
  })
  client.on('messageCreate', msg => {
    if (msg.author.bot) return
    if (msg.channel.type === ChannelType.DM) {
      gateway.noteDmRecipient(msg.channelId, msg.author.id)
    }
    inbound(msg as never)
  })

  const interactionHandler = attachInteractionHandler({
    gateway,
    registry,
    routing,
    ringBuffers,
    paths,
    buttonIntercept: async i => permissionRelay.handleButton(i),
  })
  client.on('interactionCreate', interactionHandler)

  const approvalWatcher = startApprovalWatcher(
    paths.approvedDir,
    async ({ chatId }) => {
      await gateway.send(chatId, 'Paired! Say hi to Claude.')
    },
    50, // tighter polling for tests
  )

  // Kick off the mock login so clientReady fires.
  await client.login()
  // Wait one tick so the setImmediate-deferred clientReady reaches subscribers.
  await new Promise(r => setImmediate(r))

  return {
    paths,
    client,
    gateway,
    registry,
    routing,
    ringBuffers,
    permissionRelay,
    approvalWatcher,
    async shutdown() {
      approvalWatcher.stop()
      permissionRelay.stop()
      routing.stopWatching()
      await sockServer.close()
      await gateway.shutdown()
    },
  }
}
