/**
 * Decide whether plugin should open the daemon socket on startup.
 *
 * Architecture deltas §10: plugin only registers when parent CC explicitly
 * launched with `--channels plugin:<this-plugin>@<marketplace>` (or
 * `--dangerously-load-development-channels`). This keeps the daemon registry
 * free of CC sessions that have the plugin enabled but aren't actually
 * serving Discord (e.g. cmux-managed sessions, console-only dev work).
 *
 * Authoritative plugin name is read from
 * `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` (no hardcoded `name`).
 *
 * The pure decision (decideConnect) is split from the I/O probe
 * (shouldConnectDaemon) so the policy can be unit-tested without spawning
 * a real CC parent or mocking fs/exec at the call site.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ConnectDecision = { connect: boolean; reason: string }

export type DecideInput = {
  /** True if `CLAUDE_DISCORD_FORCE_CONNECT=1` is set. */
  forceConnect: boolean
  /** `CLAUDE_PLUGIN_ROOT` env. undefined when not running under CC plugin loader. */
  pluginRoot: string | undefined
  /** Parsed `plugin.json`. null if unreadable / not present. */
  manifest: { name?: string } | null
  /** Parent process cmdline (full ps output). null if probe failed. */
  cmdline: string | null
}

/**
 * Pure policy. Failure modes (env unset / unreadable manifest / ps failed)
 * default to connect=true to preserve current behavior under unusual
 * launch contexts (manual dev, sandboxes without ps, etc).
 */
export function decideConnect(input: DecideInput): ConnectDecision {
  if (input.forceConnect) {
    return { connect: true, reason: 'CLAUDE_DISCORD_FORCE_CONNECT=1 override' }
  }

  if (!input.pluginRoot) {
    return { connect: true, reason: 'CLAUDE_PLUGIN_ROOT unset (dev/manual launch)' }
  }

  const name = input.manifest?.name
  if (typeof name !== 'string' || name.length === 0) {
    return { connect: true, reason: 'plugin.json missing or no name field' }
  }

  if (input.cmdline == null) {
    return { connect: true, reason: 'parent cmdline probe failed' }
  }

  const ref = `plugin:${name}@`
  if (input.cmdline.includes(ref)) {
    return { connect: true, reason: `parent CC --channels references ${ref}*` }
  }
  return { connect: false, reason: `parent CC has no ${ref}* in cmdline` }
}

/**
 * Walk the parent process chain looking for the nearest `claude` process.
 *
 * Plugin spawn (via .mcp.json) → CC is the immediate parent (depth 1).
 * Hook spawn (via settings.json `command` type) → CC → bash → bun → hook
 * → CC may be 2-3 levels up. Walking handles both cases without
 * special-casing.
 *
 * Returns the cmdline of the first ancestor whose comm/cmd starts with
 * "claude", or null if no claude ancestor found within the walk limit.
 */
export function findClaudeAncestorCmdline(startPid = process.ppid, maxDepth = 8): string | null {
  let pid = startPid
  for (let depth = 0; depth < maxDepth; depth++) {
    if (pid <= 1) return null
    let line: string
    try {
      line = execSync(`ps -p ${pid} -o ppid=,command=`, {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim()
    } catch {
      return null
    }
    // Format: "<ppid> <command...>"
    const m = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!m) return null
    const parentPid = Number(m[1])
    const cmd = m[2]!
    // Match if the command's basename is "claude" or starts with "claude "
    const basename = (cmd.split(' ')[0] ?? '').split('/').pop() ?? ''
    if (basename === 'claude' || basename.startsWith('claude.')) {
      return cmd
    }
    pid = parentPid
  }
  return null
}

/**
 * Architecture deltas §21: detect whether the parent claude was launched
 * with `--dangerously-skip-permissions`. Hook uses this to short-circuit
 * → emit 'allow' instead of asking Discord.
 */
export function sniffDangerouslySkipPermissions(cmdline: string | null): boolean {
  if (!cmdline) return false
  return cmdline.includes('--dangerously-skip-permissions')
}

/**
 * Real-world probe: read env, plugin.json, ppid cmdline, then call
 * decideConnect. Always returns a decision (no exceptions thrown).
 */
export function shouldConnectDaemon(): ConnectDecision {
  const forceConnect = process.env.CLAUDE_DISCORD_FORCE_CONNECT === '1'
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT

  let manifest: { name?: string } | null = null
  if (pluginRoot) {
    try {
      const text = readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')
      manifest = JSON.parse(text) as { name?: string }
    } catch {
      manifest = null
    }
  }

  // Walk the ancestor chain to find the actual claude process; handles both
  // direct-spawn (plugin path) and shell-spawn (hook path) callers.
  const cmdline = findClaudeAncestorCmdline()

  return decideConnect({ forceConnect, pluginRoot, manifest, cmdline })
}
