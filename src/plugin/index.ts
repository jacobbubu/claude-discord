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

import { resolvePaths } from '../shared/paths.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import type { WireMsg } from '../protocol/schema.ts'
import { backoffDelayMs, delay } from './reconnect.ts'
import {
  buildMcpServer,
  connectMcpStdio,
  disconnectedResult,
  relayInbound,
  type ToolDispatcher,
} from './mcp-server.ts'
import { SocketClient } from './socket-client.ts'
import { ToolBridge } from './tool-handlers.ts'

const HEARTBEAT_MS = 10_000

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

const dispatch: ToolDispatcher = (tool, args) => {
  if (!state.bridge) return Promise.resolve(disconnectedResult())
  return state.bridge.call(tool, args)
}

const mcp = buildMcpServer(dispatch)
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

await connectLoop()

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

process.stderr.write(`plugin: started (path=${SOCKET_PATH})\n`)
