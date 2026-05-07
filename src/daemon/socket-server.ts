/**
 * Daemon-side Unix domain socket server. Accepts plugin connections,
 * handles register handshake + heartbeat + tool_call (delegated).
 *
 * Tool-call dispatch is injected: pass a `handleToolCall` callback. Slice 4
 * wires it to the real discord.js implementation via dispatchToolCall.
 */

import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { LineBuffer } from '../protocol/ndjson.ts'
import { WireSchema, type WireMsg } from '../protocol/schema.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import { log } from '../shared/logger.ts'
import type { Paths } from '../shared/paths.ts'
import { Connection } from './connection.ts'
import type { WorkspaceRegistry } from './registry.ts'

export type ToolCallHandler = (
  workspace: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: string; error?: string }>

export type SocketServer = {
  close(): Promise<void>
}

const HEARTBEAT_TIMEOUT_MS = 30_000

const echoHandler: ToolCallHandler = async (_w, tool, args) => ({
  ok: true,
  result: `(echo) ${tool}(${JSON.stringify(args)})`,
})

export function startSocketServer(
  paths: Paths,
  registry: WorkspaceRegistry,
  handleToolCall: ToolCallHandler = echoHandler,
): SocketServer {
  if (existsSync(paths.socketPath)) {
    try {
      unlinkSync(paths.socketPath)
    } catch (e) {
      log.warn(`could not unlink stale socket ${paths.socketPath}: ${e}`)
    }
  }

  const server: Server = createServer(socket => onSocket(socket, registry, handleToolCall))

  server.on('error', err => log.error(`socket server error: ${err}`))

  server.listen(paths.socketPath, () => {
    try {
      chmodSync(paths.socketPath, 0o600)
    } catch (e) {
      log.warn(`chmod socket failed: ${e}`)
    }
    log.info(`socket server listening on ${paths.socketPath}`)
  })

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const conn of registry.list()) {
      if (now - conn.lastActivityTs > HEARTBEAT_TIMEOUT_MS) {
        log.warn(
          `heartbeat timeout: workspace=${conn.workspace} last=${now - conn.lastActivityTs}ms ago`,
        )
        registry.unregisterByConnection(conn)
        conn.close()
      }
    }
  }, 5_000)
  reaper.unref()

  return {
    close: () =>
      new Promise<void>(resolve => {
        clearInterval(reaper)
        for (const conn of registry.list()) {
          conn.send({ type: 'bye', v: PROTOCOL_VERSION, reason: 'daemon shutting down' })
          conn.close()
        }
        server.close(() => {
          try {
            unlinkSync(paths.socketPath)
          } catch {}
          resolve()
        })
      }),
  }
}

function onSocket(
  socket: Socket,
  registry: WorkspaceRegistry,
  handleToolCall: ToolCallHandler,
): void {
  const conn = new Connection(socket)
  const buf = new LineBuffer()

  log.debug('plugin socket: connected')
  socket.setEncoding('utf8')

  socket.on('data', chunk => {
    for (const line of buf.push(chunk as unknown as string)) {
      handleLine(line, conn, registry, handleToolCall)
    }
  })

  socket.on('close', () => {
    log.debug(`plugin socket: closed (workspace=${conn.workspace ?? 'unregistered'})`)
    if (conn.state === 'registered') registry.unregisterByConnection(conn)
    conn.state = 'closed'
  })

  socket.on('error', err => log.warn(`plugin socket error: ${err}`))
}

function handleLine(
  line: string,
  conn: Connection,
  registry: WorkspaceRegistry,
  handleToolCall: ToolCallHandler,
): void {
  conn.touch()

  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    log.warn(`plugin socket: bad JSON line dropped`)
    return
  }

  const parsed = WireSchema.safeParse(raw)
  if (!parsed.success) {
    log.warn(
      `plugin socket: schema reject (${(parsed.error.issues[0]?.path ?? []).join('.')} ${parsed.error.issues[0]?.message ?? ''})`,
    )
    return
  }

  const msg: WireMsg = parsed.data
  switch (msg.type) {
    case 'register':
      handleRegister(msg, conn, registry)
      return
    case 'heartbeat':
      return
    case 'tool_call':
      void handleToolCallMsg(msg, conn, handleToolCall)
      return
    default:
      log.warn(`plugin socket: unexpected message type from plugin: ${msg.type}`)
  }
}

function handleRegister(
  msg: { agent: string; cwd: string; pid: number; capabilities: string[] },
  conn: Connection,
  registry: WorkspaceRegistry,
): void {
  if (msg.agent !== 'claude-code') {
    conn.send({
      type: 'register_reject',
      v: PROTOCOL_VERSION,
      reason: 'unknown_agent',
      detail: `agent=${msg.agent}`,
    })
    conn.close()
    return
  }

  const basename = msg.cwd.split('/').pop() || 'workspace'
  conn.workspace = basename
  conn.agent = msg.agent
  conn.capabilities = msg.capabilities
  conn.state = 'registered'
  registry.register(basename, conn)

  conn.send({
    type: 'register_ack',
    v: PROTOCOL_VERSION,
    workspace: basename,
    server_capabilities: ['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment'],
  })

  log.info(`workspace registered: ${basename} (agent=${msg.agent}, pid=${msg.pid})`)
}

async function handleToolCallMsg(
  msg: { id: string; tool: string; args: Record<string, unknown> },
  conn: Connection,
  handleToolCall: ToolCallHandler,
): Promise<void> {
  if (!conn.workspace) {
    conn.send({
      type: 'tool_result',
      v: PROTOCOL_VERSION,
      id: msg.id,
      ok: false,
      error: 'tool_call before register',
    })
    return
  }
  const out = await handleToolCall(conn.workspace, msg.tool, msg.args)
  conn.send({
    type: 'tool_result',
    v: PROTOCOL_VERSION,
    id: msg.id,
    ok: out.ok,
    ...(out.ok ? { result: out.result ?? '' } : { error: out.error ?? 'unknown error' }),
  })
}
