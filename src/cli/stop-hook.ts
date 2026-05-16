#!/usr/bin/env bun
/**
 * Architecture deltas §36: Stop hook subprocess. Fires once when CC finishes a
 * turn. Sends a `cc_stop { cwd }` line to the daemon socket so daemon can:
 *   1) end §35 turn lifecycle immediately (skip the 30s sunset tail)
 *   2) clear any /cancel flag tied to the turn that just ended
 *
 * Wire-up: register as a `Stop` hook in ~/.claude/settings.json via
 * `claude-discord-bot install-hook`.
 *
 * Protocol:
 *   stdin  ← CC sends JSON { session_id, ... } (we ignore the payload)
 *   stdout → empty / ignored; exit 0
 *   wire   → daemon socket: { type: 'cc_stop', cwd: <cwd> }
 *
 * Behavior:
 *   - Non-channel-mode CC parents are skipped (same walker as §16/§24)
 *   - Fire-and-forget: writes to daemon then exits; never blocks CC
 */

import { connect } from 'node:net'
import { resolvePaths } from '../shared/paths.ts'
import { encode } from '../protocol/ndjson.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import { findClaudeAncestorCmdline, sniffChannelMode } from '../plugin/connect-policy.ts'

const SEND_TIMEOUT_MS = 200

function sendStop(payload: object): Promise<void> {
  const paths = resolvePaths()
  return new Promise<void>(resolve => {
    const sock = connect(paths.socketPath)
    const timer = setTimeout(() => {
      try {
        sock.destroy()
      } catch {}
      resolve()
    }, SEND_TIMEOUT_MS)
    timer.unref()
    sock.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
    sock.once('connect', () => {
      sock.write(encode(payload as never), () => {
        clearTimeout(timer)
        try {
          sock.end()
        } catch {}
        resolve()
      })
    })
  })
}

async function main(): Promise<void> {
  // Channel-mode gate (same as post-tool-use-hook). Stop fires for every
  // claude session; only forward when the ancestor was started with
  // `--channels plugin:claude-discord`.
  if (!sniffChannelMode(findClaudeAncestorCmdline())) {
    process.exit(0)
  }

  // We don't actually need stdin contents — the Stop event only signals "turn
  // ended"; cwd is what daemon uses to find the workspace. Drain stdin so CC
  // doesn't see a broken pipe.
  process.stdin.resume()
  process.stdin.on('data', () => {})

  const payload = {
    type: 'cc_stop' as const,
    v: PROTOCOL_VERSION,
    cwd: process.cwd(),
  }
  await sendStop(payload)
  process.exit(0)
}

if (import.meta.main) {
  void main()
}
