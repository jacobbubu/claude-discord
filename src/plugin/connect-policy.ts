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

  let cmdline: string | null = null
  try {
    cmdline = execSync(`ps -p ${process.ppid} -o command=`, {
      encoding: 'utf8',
      timeout: 1_000,
    })
  } catch {
    cmdline = null
  }

  return decideConnect({ forceConnect, pluginRoot, manifest, cmdline })
}
