#!/usr/bin/env bun
/**
 * Architecture deltas §24: PostToolUse hook that forwards each CC tool
 * invocation to the daemon, which pushes a formatted embed to the per-turn
 * Discord thread. Lets the user audit tool I/O (git log, Bash output, Read
 * results, ...) without polluting the main channel timeline.
 *
 * Wire-up: register as a `PostToolUse` hook in ~/.claude/settings.json via
 * `claude-discord-bot install-hook` (writes both Pre- and PostToolUse).
 *
 * Protocol:
 *   stdin  ← CC sends JSON { tool_name, tool_input, tool_response, ... }
 *   stdout → empty / ignored; exit 0
 *   wire   → daemon socket: { type: 'cc_tool_trace', ... }
 *
 * Behavior:
 *   - Plugin's own tools and TodoWrite are skipped (no daemon round-trip)
 *   - Non-channel-mode CC parents are skipped (same walker as §16)
 *   - tool_input / tool_response truncated to 1800 chars each
 *   - Fire-and-forget: writes to daemon then exits; never blocks CC
 */

import { connect } from 'node:net'
import { resolvePaths } from '../shared/paths.ts'
import { encode } from '../protocol/ndjson.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import { findClaudeAncestorCmdline, sniffChannelMode } from '../plugin/connect-policy.ts'

const FIELD_MAX = 1800
const SEND_TIMEOUT_MS = 200

/**
 * Tools we don't want to mirror to the trace thread.
 *
 * - plugin's own tools: would create an echo loop (reply → thread embed of
 *   reply → ...) and the user already saw the reply content in the channel.
 * - TodoWrite: CC's internal task tracker — high frequency, low information.
 * - Whitelisted read tools could be excluded too, but the user explicitly
 *   asked for both tool I/O and reasoning visibility, so we keep Read/Grep/...
 */
const SKIP_TOOLS = new Set(['TodoWrite'])

export function shouldSkip(toolName: string): boolean {
  if (SKIP_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp__plugin_claude-discord_')) return true
  return false
}

export function truncate(s: string, max = FIELD_MAX): string {
  if (s.length <= max) return s
  const head = s.slice(0, max - 30)
  return `${head}…(truncated ${s.length - (max - 30)} chars)`
}

function stringifyMaybe(x: unknown): string {
  if (typeof x === 'string') return x
  if (x === undefined || x === null) return ''
  try {
    return JSON.stringify(x)
  } catch {
    return String(x)
  }
}

/**
 * Recursively truncate string values inside an object/array in place.
 * Non-string scalars (number, boolean, null) are untouched. Used by
 * `compactToolResponse` to keep JSON structure intact when shortening long
 * `stdout` / `content` payloads.
 */
function truncateStringsDeep(value: unknown, max: number): void {
  if (value == null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i]
      if (typeof v === 'string') {
        value[i] = truncate(v, max)
      } else {
        truncateStringsDeep(v, max)
      }
    }
    return
  }
  const obj = value as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === 'string') {
      obj[k] = truncate(v, max)
    } else {
      truncateStringsDeep(v, max)
    }
  }
}

/**
 * Serialize `tool_response` for the trace wire, ensuring the result is always
 * valid JSON (or a plain string). The naive `truncate(stringifyMaybe(x))`
 * approach cuts JSON in the middle when string fields are long, leaving the
 * daemon with un-parseable input — Bash's `{stdout:"<long>"...}` envelope hits
 * this on grep / long-output commands. Instead, structured responses get
 * per-field truncation so the renderer can still parse and pull out
 * `stdout` / `file.content` / etc.
 */
export function compactToolResponse(r: unknown, max = FIELD_MAX): string {
  if (typeof r === 'string') return truncate(r, max)
  if (r == null || typeof r !== 'object') return stringifyMaybe(r)
  let cloned: unknown
  try {
    cloned = JSON.parse(JSON.stringify(r))
  } catch {
    // Cycles / unserializable → fall back to old behavior.
    return truncate(stringifyMaybe(r), max)
  }
  truncateStringsDeep(cloned, max)
  try {
    return JSON.stringify(cloned)
  } catch {
    return truncate(stringifyMaybe(r), max)
  }
}

/**
 * Derive ok/error status from CC's tool_response. CC wraps tool errors in an
 * object with `is_error: true` (Bash, etc) or simply returns a result object.
 * Plain strings are always 'ok'.
 */
export function detectStatus(toolResponse: unknown): 'ok' | 'error' {
  if (typeof toolResponse === 'object' && toolResponse !== null) {
    const r = toolResponse as Record<string, unknown>
    if (r.is_error === true) return 'error'
    if (typeof r.status === 'string' && r.status.toLowerCase() === 'error') return 'error'
  }
  return 'ok'
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function sendTrace(payload: object): Promise<void> {
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
  // Channel-mode gate. Unlike permission-hook (which falls back to 'ask' for
  // unknown contexts), tool traces have no fallback — sending them from a
  // non-channel-mode CC would pollute another workspace's thread or silently
  // drop server-side. So require an explicit `--channels plugin:` flag on
  // the ancestor claude cmdline before forwarding anything.
  if (!sniffChannelMode(findClaudeAncestorCmdline())) {
    process.exit(0)
  }

  const raw = await readStdin().catch(() => '')
  let payload: {
    tool_name?: string
    tool_input?: unknown
    tool_response?: unknown
    transcript_path?: string
  } = {}
  try {
    payload = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const toolName = payload.tool_name ?? '<unknown>'
  if (shouldSkip(toolName)) process.exit(0)

  const trace = {
    type: 'cc_tool_trace' as const,
    v: PROTOCOL_VERSION,
    tool_name: toolName,
    tool_input: truncate(stringifyMaybe(payload.tool_input)),
    // §40-fix: structure-preserving truncation so renderers (which parse JSON
    // to extract stdout / file.content / etc.) don't end up with a half-cut
    // wrapper. See `compactToolResponse`.
    tool_response: compactToolResponse(payload.tool_response),
    status: detectStatus(payload.tool_response),
    cwd: process.cwd(),
    // §55b (issue #140): forward CC's transcript path so the daemon can tail
    // it for API-error records. Present on every CC hook payload.
    ...(typeof payload.transcript_path === 'string' && payload.transcript_path.length > 0
      ? { transcript_path: payload.transcript_path }
      : {}),
  }
  await sendTrace(trace)
  process.exit(0)
}

if (import.meta.main) {
  void main()
}
