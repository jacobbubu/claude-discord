#!/usr/bin/env bun
/**
 * Plugin entry — runs as a CC subprocess (per .mcp.json).
 *
 * Dual-IO: MCP stdio with CC + outbound Unix socket to daemon. Slice 2 wires
 * the full proxy: tool_call CC→daemon round-trip and inbound daemon→CC fan-out.
 *
 * Reconnect strategy: exponential backoff up to 5s cap. While disconnected,
 * outstanding tool calls fail fast with clear errors.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { resolvePaths } from '../shared/paths.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import type { WireMsg } from '../protocol/schema.ts'
import { shouldConnectDaemon } from './connect-policy.ts'
import { startOrphanWatcher } from './orphan-watcher.ts'
import { backoffDelayMs, delay } from './reconnect.ts'
import { buildWhoamiResult } from './whoami.ts'
import {
  buildMcpServer,
  connectMcpStdio,
  disconnectedResult,
  relayInbound,
  type ToolDispatcher,
} from './mcp-server.ts'
import { SocketClient } from './socket-client.ts'
import { ToolBridge } from './tool-handlers.ts'

const PermissionRequestNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

const HEARTBEAT_MS = 10_000

// §28: real parent CC pid, captured before anything can change it. The orphan
// watcher uses this to notice if the parent dies and we got reparented.
const PARENT_PID = process.ppid

const SOCKET_PATH = process.env.CLAUDE_DISCORD_SOCKET ?? resolvePaths().socketPath
const PLUGIN_AGENT = 'claude-code'
const PLUGIN_CAPABILITIES = ['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment']

/**
 * Mutable holders so the MCP server's tool dispatch + inbound relay always
 * point at the *current* socket-client / tool-bridge after reconnects.
 */
const state = {
  client: null as SocketClient | null,
  bridge: null as ToolBridge | null,
  workspace: null as string | null,
  heartbeatTimer: null as ReturnType<typeof setInterval> | null,
}

// Plugin version — read once from manifest at the cache root if available,
// otherwise '?'. Used by whoami to self-report.
const PLUGIN_VERSION = (() => {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT
    if (!root) return '?'
    const txt = readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')
    return (JSON.parse(txt) as { version?: string }).version ?? '?'
  } catch {
    return '?'
  }
})()

const dispatch: ToolDispatcher = (tool, args) => {
  if (tool === 'whoami') {
    // No-args local introspection — doesn't go through the daemon.
    return Promise.resolve(
      buildWhoamiResult({
        workspace: state.workspace,
        daemon_socket: SOCKET_PATH,
        agent: PLUGIN_AGENT,
        plugin_version: PLUGIN_VERSION,
        connected: state.client !== null,
      }),
    )
  }
  if (!state.bridge) return Promise.resolve(disconnectedResult())
  return state.bridge.call(tool, args)
}

const mcp = buildMcpServer(dispatch)

// Subscribe to CC's permission_request — forward to daemon for Discord-side
// approval. The matching `permission` reply lands in onMessage and is
// emitted back as an MCP notification to CC.
mcp.setNotificationHandler(PermissionRequestNotificationSchema, async ({ params }) => {
  if (!state.client) {
    process.stderr.write('plugin: permission_request received but daemon disconnected\n')
    return
  }
  state.client.send({
    type: 'permission_request',
    v: PROTOCOL_VERSION,
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  })
})

await connectMcpStdio(mcp)

function startHeartbeat(): void {
  stopHeartbeat()
  state.heartbeatTimer = setInterval(() => {
    try {
      state.client?.send({ type: 'heartbeat', v: PROTOCOL_VERSION })
    } catch {
      /* socket may have closed; reaper will trigger reconnect */
    }
  }, HEARTBEAT_MS)
  state.heartbeatTimer.unref()
}

function stopHeartbeat(): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = null
  }
}

function onMessage(msg: WireMsg): void {
  switch (msg.type) {
    case 'register_ack':
      state.workspace = msg.workspace
      process.stderr.write(`plugin: registered as workspace=${state.workspace}\n`)
      return
    case 'register_reject':
      process.stderr.write(
        `plugin: register rejected (${msg.reason}): ${msg.detail ?? ''}\n`,
      )
      process.exit(2)
      return
    case 'inbound':
      relayInbound(mcp, msg)
      return
    case 'tool_result':
      state.bridge?.receiveResult(msg)
      return
    case 'permission':
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      })
      return
    case 'evicted':
      process.stderr.write(`plugin: evicted by daemon (${msg.reason ?? 'no reason'})\n`)
      return
    case 'bye':
      process.stderr.write(`plugin: daemon said bye (${msg.reason ?? ''})\n`)
      return
    default:
      process.stderr.write(`plugin: unexpected daemon message: ${msg.type}\n`)
  }
}

let reconnecting = false

async function connectLoop(): Promise<void> {
  if (reconnecting) return
  reconnecting = true
  try {
    let attempt = 0
    while (true) {
      const client = new SocketClient(SOCKET_PATH, {
        onMessage,
        onError: err => process.stderr.write(`plugin: socket error: ${err}\n`),
        onClose: () => {
          stopHeartbeat()
          state.bridge?.rejectAll('daemon disconnected')
          state.client = null
          state.bridge = null
          state.workspace = null
          // Schedule another reconnect attempt in the background.
          reconnecting = false
          void connectLoop().catch(e =>
            process.stderr.write(`plugin: reconnect failed: ${e}\n`),
          )
        },
      })

      try {
        await client.connect()
        state.client = client
        state.bridge = new ToolBridge(client)

        client.send({
          type: 'register',
          v: PROTOCOL_VERSION,
          agent: PLUGIN_AGENT,
          cwd: process.cwd(),
          pid: process.pid,
          capabilities: PLUGIN_CAPABILITIES,
        })
        startHeartbeat()
        return
      } catch (e) {
        const wait = backoffDelayMs(attempt++)
        process.stderr.write(`plugin: connect failed (${e}); retrying in ${wait}ms\n`)
        await delay(wait)
      }
    }
  } finally {
    reconnecting = false
  }
}

// Conditional daemon connect (architecture deltas §10): only connect if
// parent CC was launched with `--channels plugin:<this-plugin>@<marketplace>`
// (or `--dangerously-load-development-channels` referencing us). Otherwise
// stay MCP-only — saves daemon registry from being polluted by every CC
// session that has the plugin enabled but isn't actually serving Discord.
//
// Override: CLAUDE_DISCORD_FORCE_CONNECT=1 forces connect (debug / unusual
// deployments where ppid lookup fails).
const decision = shouldConnectDaemon()
if (decision.connect) {
  process.stderr.write(`plugin: connecting to daemon — ${decision.reason}\n`)
  await connectLoop()
} else {
  process.stderr.write(
    `plugin: skipping daemon connect — ${decision.reason}. ` +
      `Set CLAUDE_DISCORD_FORCE_CONNECT=1 to override.\n`,
  )
}

// Global safety net — without these the plugin process dies silently on
// any unhandled rejection or sync throw, taking the CC session's MCP
// channel with it. (BH-3 in docs/reviews/code-review-mvp.md.)
process.on('unhandledRejection', err =>
  process.stderr.write(`plugin: unhandled rejection: ${err}\n`),
)
process.on('uncaughtException', err =>
  process.stderr.write(`plugin: uncaught exception: ${err}\n`),
)

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

// Belt-and-suspenders: if MCP transport's onclose hook (mcp-server.ts) fails
// to fire on stdin EOF for some reason, the raw stream events still trigger
// process exit. Without this, observed PID 43849 spin in #26 — orphan plugin
// after parent CC TUI exit.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

// §28: third line of defense — if the parent CC dies and the stdio-close
// signals above somehow don't fire, notice the reparent (process.ppid changes)
// and exit. Cheap poll, .unref()'d so it never keeps us alive on its own.
startOrphanWatcher({ originalPpid: PARENT_PID })

process.stderr.write(`plugin: started (path=${SOCKET_PATH})\n`)
