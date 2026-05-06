#!/usr/bin/env bun
/**
 * Mock daemon for spike #6: Unix socket NDJSON server.
 *
 * Speaks the daemon side of the plugin↔daemon protocol:
 *   - register / register_ack
 *   - heartbeat (ignored)
 *   - tool_call → tool_result (echo)
 *   - pushes a synthetic inbound after register to verify daemon→plugin direction
 */

import { unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer, type Socket } from 'node:net'

const SOCKET_PATH = process.env.SPIKE_SOCKET ?? '/tmp/claude-discord-spike-daemon.sock'

if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)
mkdirSync(dirname(SOCKET_PATH), { recursive: true })

const send = (socket: Socket, msg: object) => socket.write(JSON.stringify(msg) + '\n')

const server = createServer((socket: Socket) => {
  process.stderr.write(`mock-daemon: client connected\n`)
  let buf = ''

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      handleLine(line, socket)
    }
  })

  socket.on('close', () => {
    process.stderr.write(`mock-daemon: client closed\n`)
  })
})

function handleLine(line: string, socket: Socket) {
  let m: any
  try {
    m = JSON.parse(line)
  } catch {
    process.stderr.write(`mock-daemon: bad JSON: ${line}\n`)
    return
  }
  process.stderr.write(`mock-daemon: rx ${m.type}\n`)

  switch (m.type) {
    case 'register':
      send(socket, {
        type: 'register_ack',
        v: 1,
        workspace: m.cwd?.split('/').pop() ?? 'spike',
        server_capabilities: ['reply'],
      })
      // Push a synthetic inbound 100ms after register to test daemon→plugin direction
      setTimeout(
        () =>
          send(socket, {
            type: 'inbound',
            v: 1,
            chat_id: 'c1',
            message_id: 'm1',
            user: 'tester',
            user_id: 'u1',
            ts: new Date().toISOString(),
            content: 'hello from mock daemon',
          }),
        100,
      )
      break
    case 'heartbeat':
      break
    case 'tool_call':
      send(socket, {
        type: 'tool_result',
        v: 1,
        id: m.id,
        ok: true,
        result: `mock-daemon echoed: ${JSON.stringify(m.args)}`,
      })
      break
    default:
      process.stderr.write(`mock-daemon: unknown type ${m.type}\n`)
  }
}

server.listen(SOCKET_PATH, () => {
  process.stderr.write(`mock-daemon: listening on ${SOCKET_PATH}\n`)
})

const cleanup = () => {
  server.close()
  try {
    unlinkSync(SOCKET_PATH)
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)
