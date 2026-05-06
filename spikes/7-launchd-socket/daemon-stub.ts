#!/usr/bin/env bun
/**
 * Spike #7 daemon stub — minimal daemon that:
 *   - Creates parent dir with 0o700
 *   - Creates Unix socket with 0o600
 *   - Logs PID, UID, socket path
 *   - Runs until SIGTERM/SIGINT
 *
 * Used by verify.ts to check ownership / permissions / connectivity.
 */

import { unlinkSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer, type Socket } from 'node:net'

const SOCKET_PATH = process.env.SPIKE7_SOCKET ?? '/tmp/spike7-daemon.sock'

if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)

const dir = dirname(SOCKET_PATH)
mkdirSync(dir, { recursive: true, mode: 0o700 })
// chmod again — mkdirSync respects umask; we want a strict 0o700 regardless
try {
  chmodSync(dir, 0o700)
} catch {}

const server = createServer((socket: Socket) => {
  process.stderr.write(`daemon-stub: client connected\n`)
  socket.on('data', d => {
    socket.write(`echo: ${d.toString()}`)
  })
})

server.listen(SOCKET_PATH, () => {
  // Discord-style strict mode on socket file
  try {
    chmodSync(SOCKET_PATH, 0o600)
  } catch (e) {
    process.stderr.write(`daemon-stub: chmod socket failed: ${e}\n`)
  }

  const stat = statSync(SOCKET_PATH)
  process.stderr.write(
    `daemon-stub: pid=${process.pid} uid=${process.getuid?.()} ` +
      `socket=${SOCKET_PATH} mode=${(stat.mode & 0o777).toString(8)} ` +
      `dirMode=${(statSync(dir).mode & 0o777).toString(8)}\n`,
  )
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
