#!/usr/bin/env bun
/**
 * Architecture deltas §15: CC PreToolUse hook that defers permission
 * decisions to Discord (via daemon). Replaces CC's TUI prompt with a
 * Discord DM containing Allow / Deny buttons (and `yes/no XXXXX` text
 * fallback) — same UX as plugin-provided tool permission relay.
 *
 * Wire-up: register as a `PreToolUse` hook in ~/.claude/settings.json
 * via `claude-discord-bot install-hook`.
 *
 * Protocol:
 *   stdin  ← CC sends JSON { tool_name, tool_input, session_id, ... }
 *   stdout → JSON { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *                                         permissionDecision: 'allow' | 'deny' | 'ask' } }
 *   exit   = 0 (always; permission decision is in stdout JSON)
 *
 * Behavior:
 *   - Tools in HARMLESS_TOOLS auto-allowed (no Discord round-trip)
 *   - Other tools: connect daemon socket, send cc_permission_request,
 *     wait for `permission` reply, output corresponding permissionDecision
 *   - On any I/O failure: output 'ask' so CC falls back to its normal flow
 *     (TUI prompt or settings.json allow/deny rules)
 */

import { connect } from 'node:net'
import { resolvePaths } from '../shared/paths.ts'
import { encode, LineBuffer } from '../protocol/ndjson.ts'
import { WireSchema } from '../protocol/schema.ts'
import { PROTOCOL_VERSION } from '../protocol/version.ts'

const TIMEOUT_MS = 60 * 60 * 1000 // 1h — match permission-relay TTL

// Local read/search tools that don't need Discord-side approval. User can
// adjust by editing this array (rebuild hook) or by adding/removing
// permission rules in settings.json that short-circuit before this hook.
const HARMLESS_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  // Plugin-provided MCP tools — already gated by claude-discord plugin's
  // own permission_request flow, no need to double-ask via this hook.
  // (Pattern: mcp__plugin_claude-discord_claude-discord__*)
])

function isHarmless(toolName: string): boolean {
  if (HARMLESS_TOOLS.has(toolName)) return true
  // Skip our plugin's own MCP tools — they have their own permission relay.
  if (toolName.startsWith('mcp__plugin_claude-discord_')) return true
  return false
}

function makeRequestId(): string {
  // 5-letter [a-km-z] (skip 'l') — matches schema regex
  const alphabet = 'abcdefghijkmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return s
}

function emitDecision(decision: 'allow' | 'deny' | 'ask', reason?: string): void {
  const out: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
    },
  }
  if (reason) {
    ;(out.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason = reason
  }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
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

async function askDiscord(toolName: string, toolInput: unknown): Promise<'allow' | 'deny'> {
  const paths = resolvePaths()
  const requestId = makeRequestId()

  return new Promise<'allow' | 'deny'>((resolve, reject) => {
    const sock = connect(paths.socketPath)
    const buf = new LineBuffer()
    const timer = setTimeout(() => {
      try {
        sock.destroy()
      } catch {}
      reject(new Error('timeout'))
    }, TIMEOUT_MS)
    timer.unref()

    sock.setEncoding('utf8')
    sock.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    sock.once('connect', () => {
      sock.write(
        encode({
          type: 'cc_permission_request',
          v: PROTOCOL_VERSION,
          request_id: requestId,
          tool_name: toolName,
          description: typeof toolInput === 'object' && toolInput !== null
            ? `${toolName} call`
            : String(toolInput),
          input_preview: JSON.stringify(toolInput),
        }),
      )
    })
    sock.on('data', chunk => {
      for (const line of buf.push(chunk as unknown as string)) {
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        const parsed = WireSchema.safeParse(raw)
        if (!parsed.success) continue
        const msg = parsed.data
        if (msg.type === 'permission' && msg.request_id === requestId) {
          clearTimeout(timer)
          try {
            sock.end()
          } catch {}
          resolve(msg.behavior)
        }
      }
    })
  })
}

async function main(): Promise<void> {
  const raw = await readStdin().catch(() => '')
  let payload: { tool_name?: string; tool_input?: unknown } = {}
  try {
    payload = JSON.parse(raw)
  } catch {
    // bad input → defer to CC default flow
    emitDecision('ask', 'permission-hook: bad stdin JSON')
    return
  }

  const toolName = payload.tool_name ?? '<unknown>'
  if (isHarmless(toolName)) {
    emitDecision('allow')
    return
  }

  try {
    const decision = await askDiscord(toolName, payload.tool_input ?? {})
    emitDecision(decision)
  } catch (e) {
    // Daemon unreachable / timeout / etc — let CC handle via its normal
    // gate (TUI prompt). Don't auto-deny: that would block all tools when
    // daemon happens to be down.
    emitDecision('ask', `permission-hook: ${e instanceof Error ? e.message : String(e)}`)
  }
}

void main()
