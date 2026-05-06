#!/usr/bin/env bun
/**
 * Plugin for spike #6: thin proxy between CC (MCP stdio) and daemon (Unix socket NDJSON).
 *
 *   CC stdin/stdout  ⇄  MCP server  (this file)  ⇄  Unix socket  ⇄  daemon
 *
 * Validates that one Bun process can simultaneously:
 *   - Serve MCP stdio to CC (single tool: 'reply')
 *   - Maintain outbound Unix socket connection to daemon
 *   - Forward CC tool calls → daemon, route daemon results back to CC
 *   - Receive daemon push messages → emit as MCP notifications to CC
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { connect, type Socket } from 'node:net'

const SOCKET_PATH = process.env.SPIKE_SOCKET ?? '/tmp/claude-discord-spike-daemon.sock'

const mcp = new Server(
  { name: 'claude-discord-spike', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

// Daemon socket — outbound, with tool_call/tool_result correlation by id
let daemon: Socket | null = null
let socketReady: Promise<void> | null = null
const pendingResult = new Map<string, (v: any) => void>()
let nextId = 1

function ensureDaemon(): Promise<void> {
  if (socketReady) return socketReady
  socketReady = new Promise<void>((resolve, reject) => {
    const sock = connect(SOCKET_PATH)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => {
      process.stderr.write(`plugin: connected to daemon\n`)
      sock.write(
        JSON.stringify({
          type: 'register',
          v: 1,
          agent: 'claude-code',
          cwd: process.cwd(),
          pid: process.pid,
          capabilities: ['reply'],
        }) + '\n',
      )
      resolve()
    })
    sock.on('error', err => {
      process.stderr.write(`plugin: socket error: ${err}\n`)
      reject(err)
    })
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        handleDaemonLine(line)
      }
    })
    sock.on('close', () => {
      process.stderr.write(`plugin: daemon socket closed\n`)
      daemon = null
      socketReady = null
    })
    daemon = sock
  })
  return socketReady
}

function handleDaemonLine(line: string) {
  let m: any
  try {
    m = JSON.parse(line)
  } catch {
    process.stderr.write(`plugin: bad JSON from daemon: ${line}\n`)
    return
  }
  process.stderr.write(`plugin: rx ${m.type}\n`)

  if (m.type === 'tool_result' && pendingResult.has(m.id)) {
    pendingResult.get(m.id)!(m)
    pendingResult.delete(m.id)
    return
  }

  if (m.type === 'inbound') {
    void mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: m.content,
        meta: {
          chat_id: m.chat_id,
          message_id: m.message_id,
          user: m.user,
          user_id: m.user_id,
          ts: m.ts,
        },
      },
    })
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a reply via the daemon.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') {
    return {
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      isError: true,
    }
  }

  await ensureDaemon()
  const id = `tc-${nextId++}`
  daemon!.write(
    JSON.stringify({
      type: 'tool_call',
      v: 1,
      id,
      tool: 'reply',
      args: req.params.arguments ?? {},
    }) + '\n',
  )

  const result = await new Promise<any>(resolve => pendingResult.set(id, resolve))
  return result.ok
    ? { content: [{ type: 'text', text: result.result }] }
    : {
        content: [{ type: 'text', text: result.error ?? 'unknown error' }],
        isError: true,
      }
})

await mcp.connect(new StdioServerTransport())
await ensureDaemon()
process.stderr.write(`plugin: started, MCP stdio + daemon socket both wired\n`)
