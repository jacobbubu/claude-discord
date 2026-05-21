#!/usr/bin/env bun
/**
 * Spike 11: dump every CC Notification hook invocation to a log file so we
 * can see which events fire and what payload they carry — especially when
 * CC hits Anthropic API rate-limits mid-tool-call.
 *
 * Wire up via ~/.claude/settings.json:
 *   {
 *     "hooks": {
 *       "Notification": [{
 *         "matcher": "",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "bun run /Users/rongshen/vibe-coding/claude_discord/spikes/11-cc-notification-hook/dump-notification.ts",
 *           "timeout": 5
 *         }]
 *       }]
 *     }
 *   }
 *
 * Then trigger events:
 *   - Send a Discord message → CC processes (look for "permission needed" notification)
 *   - Let CC idle for a few minutes (look for "waiting for input" or similar)
 *   - Try to provoke rate-limit (multiple parallel CC sessions burning tokens)
 *
 * Output: appended NDJSON lines to /tmp/cc-notification-spike11.log
 *   Each line: { ts, ppid, cwd, payload, env_subset }
 */

import { appendFileSync } from 'node:fs'

const LOG_PATH = '/tmp/cc-notification-spike11.log'

function readStdinSync(): string {
  // Bun supports reading stdin via process.stdin sync-ish; use Buffer
  // chunks. For hook subprocess context, stdin is finite + small.
  const chunks: Buffer[] = []
  let chunk: Buffer | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stdin = process.stdin as any
  try {
    stdin.setEncoding && stdin.setEncoding(null)
  } catch {}
  // Fallback: read sync via fs.readFileSync(0) — file descriptor 0 = stdin.
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    return readFileSync(0, 'utf8')
  } catch {
    void chunk
    void chunks
    return ''
  }
}

const raw = readStdinSync()

const envSubset = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    /CLAUDE|CC|ANTHROPIC|CODEX/i.test(k),
  ),
)

const entry = {
  ts: new Date().toISOString(),
  ppid: process.ppid,
  pid: process.pid,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  payload_raw: raw,
  payload_parsed: (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return null
    }
  })(),
  env_subset: envSubset,
}

appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')

// Don't block CC — exit success.
process.exit(0)
