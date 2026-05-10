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
import {
  findClaudeAncestorCmdline,
  shouldConnectDaemon,
  sniffDangerouslySkipPermissions,
} from '../plugin/connect-policy.ts'

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

/**
 * Architecture deltas §22: read user-level settings.json `permissions.allow`
 * and short-circuit hook if the tool already matches an entry. CC's hook is
 * normally invoked BEFORE settings.allow check, so persisted "allow always"
 * entries (§20) wouldn't take effect without this. Honoring them here makes
 * §20 actually work end-to-end.
 *
 * Match rule: exact tool name, or `<tool_name>(<anything>)` prefix match
 * (CC's pattern syntax for arg-restricted allows).
 */
export function settingsAllows(toolName: string, settingsPath?: string): boolean {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = settingsPath ?? `${process.env.HOME ?? ''}/.claude/settings.json`
    if (!fs.existsSync(path)) return false
    const data = JSON.parse(fs.readFileSync(path, 'utf8')) as {
      permissions?: { allow?: string[] }
    }
    const rules = data.permissions?.allow ?? []
    for (const r of rules) {
      if (r === toolName) return true
      if (r.startsWith(`${toolName}(`) && r.endsWith(')')) return true
    }
    return false
  } catch {
    return false
  }
}

const MAX_DESC = 200

/**
 * Build a human-readable one-line summary of a tool call for the DM prompt.
 *
 * The default `<tool> call` is uselessly vague. We extract the tool's
 * primary argument (Bash command, Read file_path, etc) so the user can
 * decide without expanding "See more".
 */
export function buildToolDescription(toolName: string, toolInput: unknown): string {
  if (typeof toolInput !== 'object' || toolInput === null) {
    return `${toolName}: ${String(toolInput).slice(0, MAX_DESC)}`
  }
  const input = toolInput as Record<string, unknown>

  // Tool-specific extractors. Order matters; first match wins.
  const extractors: Array<[string, (i: Record<string, unknown>) => string | null]> = [
    ['Bash', i => (typeof i.command === 'string' ? i.command : null)],
    ['Read', i => (typeof i.file_path === 'string' ? i.file_path : null)],
    ['Write', i => (typeof i.file_path === 'string' ? `write ${i.file_path}` : null)],
    ['Edit', i => (typeof i.file_path === 'string' ? `edit ${i.file_path}` : null)],
    ['MultiEdit', i => (typeof i.file_path === 'string' ? `edit ${i.file_path}` : null)],
    ['NotebookEdit', i => (typeof i.notebook_path === 'string' ? `edit notebook ${i.notebook_path}` : null)],
    ['Glob', i => (typeof i.pattern === 'string' ? `glob ${i.pattern}` : null)],
    ['Grep', i => (typeof i.pattern === 'string' ? `grep ${i.pattern}` : null)],
    ['WebFetch', i => (typeof i.url === 'string' ? `fetch ${i.url}` : null)],
    ['WebSearch', i => (typeof i.query === 'string' ? `search ${i.query}` : null)],
  ]
  for (const [name, fn] of extractors) {
    if (toolName === name) {
      const v = fn(input)
      if (v) return v.slice(0, MAX_DESC)
    }
  }

  // Generic fallback: first string-valued field, prefer common arg names.
  const preferred = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'name']
  for (const k of preferred) {
    const v = input[k]
    if (typeof v === 'string' && v.length > 0) {
      return `${toolName}: ${v}`.slice(0, MAX_DESC)
    }
  }
  // Anything else: serialized first ~150 chars
  const serialized = JSON.stringify(input).slice(0, 150)
  return `${toolName}: ${serialized}`
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
          description: buildToolDescription(toolName, toolInput),
          input_preview: JSON.stringify(toolInput),
          // Architecture deltas §16: daemon uses cwd to find the matching
          // workspace conn → routes the button DM to its lastInboundChatId.
          cwd: process.cwd(),
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
  // Architecture deltas §21: parent CC has --dangerously-skip-permissions
  // → user explicitly opted out of all permission prompts. Don't bother
  // asking Discord — emit 'allow' immediately. This wins over §16
  // channel-mode routing because the flag is a stronger signal of intent.
  const cmdline = findClaudeAncestorCmdline()
  if (sniffDangerouslySkipPermissions(cmdline)) {
    emitDecision('allow', 'permission-hook: parent has --dangerously-skip-permissions')
    return
  }

  // Architecture deltas §16: only intercept when parent CC is actually
  // running our plugin in channel-mode. Other Claude sessions (cmux, plain
  // console) get 'ask' so they fall back to their own permission UI —
  // prompt and decision stay in the same place (source-bound principle).
  const decision = shouldConnectDaemon()
  if (!decision.connect) {
    emitDecision('ask', `permission-hook: skip (${decision.reason})`)
    return
  }

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
  // Architecture deltas §22: honor user's persisted permissions.allow rules
  // (added e.g. by §20 "Allow always") so the same tool doesn't keep
  // re-prompting after the user already approved it forever.
  if (settingsAllows(toolName)) {
    emitDecision('allow', `permission-hook: ${toolName} in settings.allow`)
    return
  }

  try {
    const verdict = await askDiscord(toolName, payload.tool_input ?? {})
    emitDecision(verdict)
  } catch (e) {
    // Daemon unreachable / timeout / etc — let CC handle via its normal
    // gate (TUI prompt). Don't auto-deny: that would block all tools when
    // daemon happens to be down.
    emitDecision('ask', `permission-hook: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Only auto-run when invoked as the entry script (CC spawning the hook).
// Tests can import this file for buildToolDescription without triggering
// stdin/socket I/O.
if (import.meta.main) {
  void main()
}
