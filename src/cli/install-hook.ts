/**
 * `claude-discord-bot install-hook` — adds (or removes) our PreToolUse hook
 * to ~/.claude/settings.json so CC's tool permission requests get routed
 * to Discord (architecture deltas §15).
 *
 * Pure helpers exported for unit testing; CLI wrapper at the bottom does
 * the actual file I/O.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from '../shared/logger.ts'

/** Resolve the absolute path to permission-hook.ts (next to this file). */
export function resolveHookCommand(): string {
  const here = import.meta.dir
  // here = .../src/cli/  →  permission-hook.ts in same dir
  return `bun run ${join(here, 'permission-hook.ts')}`
}

/**
 * Architecture deltas §24: post-tool-use-hook.ts for tool-trace forwarding.
 */
export function resolvePostToolUseHookCommand(): string {
  const here = import.meta.dir
  return `bun run ${join(here, 'post-tool-use-hook.ts')}`
}

const HOOK_TIMEOUT_S = 3700 // 1h + slack — matches PENDING_TTL_MS

type HookEntry = {
  // settings.json is user-controlled, so accept any string here. Our own
  // entries write 'command' specifically.
  type?: string
  command?: string
  timeout?: number
  // other fields ignored for install/uninstall purposes
  [k: string]: unknown
}

type MatcherBlock = {
  matcher?: string
  hooks: HookEntry[]
}

type Settings = {
  hooks?: Record<string, MatcherBlock[]>
  [k: string]: unknown
}

/**
 * Idempotent install for one hook event. Returns the modified settings object.
 *
 * Strategy: find or create a matcher='' block under `event`. If an existing
 * hook has the same `command`, no-op. Otherwise append a new entry.
 */
export function addHookToSettings(
  settings: Settings,
  hookCommand: string,
  timeoutSec = HOOK_TIMEOUT_S,
  event = 'PreToolUse',
): { settings: Settings; changed: boolean } {
  const next: Settings = JSON.parse(JSON.stringify(settings ?? {}))
  next.hooks = next.hooks ?? {}
  const blocks: MatcherBlock[] = (next.hooks[event] as MatcherBlock[]) ?? []
  next.hooks[event] = blocks

  for (const block of blocks) {
    for (const h of block.hooks ?? []) {
      if (h.type === 'command' && typeof h.command === 'string' && h.command === hookCommand) {
        return { settings: next, changed: false }
      }
    }
  }

  let target = blocks.find(b => (b.matcher ?? '') === '')
  if (!target) {
    target = { matcher: '', hooks: [] }
    blocks.push(target)
  }
  target.hooks.push({ type: 'command', command: hookCommand, timeout: timeoutSec })
  return { settings: next, changed: true }
}

/**
 * Idempotent removal for one hook event. Strips any hook entry whose
 * `command` matches. Empty matcher blocks are pruned, then the event key
 * itself if empty, then `hooks` if empty.
 */
export function removeHookFromSettings(
  settings: Settings,
  hookCommand: string,
  event = 'PreToolUse',
): { settings: Settings; changed: boolean } {
  const next: Settings = JSON.parse(JSON.stringify(settings ?? {}))
  if (!next.hooks?.[event]) return { settings: next, changed: false }

  let changed = false
  const blocks = next.hooks[event]
  for (const block of blocks) {
    const before = block.hooks?.length ?? 0
    block.hooks = (block.hooks ?? []).filter(
      h => !(h.type === 'command' && h.command === hookCommand),
    )
    if (block.hooks.length !== before) changed = true
  }
  next.hooks[event] = blocks.filter(b => (b.hooks?.length ?? 0) > 0)
  if (next.hooks[event].length === 0) delete next.hooks[event]
  if (Object.keys(next.hooks).length === 0) delete next.hooks
  return { settings: next, changed }
}

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

function readSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) return {}
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Settings
  } catch (e) {
    log.error(`could not parse ${SETTINGS_PATH}: ${e}`)
    process.exit(1)
  }
}

function writeSettings(s: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n')
}

// PostToolUse hook is fire-and-forget; 5s is plenty for socket round-trip.
const POST_HOOK_TIMEOUT_S = 5

export function installHook(): void {
  const preCmd = resolveHookCommand()
  const postCmd = resolvePostToolUseHookCommand()
  let settings = readSettings()
  const pre = addHookToSettings(settings, preCmd, HOOK_TIMEOUT_S, 'PreToolUse')
  const post = addHookToSettings(pre.settings, postCmd, POST_HOOK_TIMEOUT_S, 'PostToolUse')
  settings = post.settings

  if (!pre.changed && !post.changed) {
    log.info(`hooks already installed (Pre/Post)`)
    return
  }
  writeSettings(settings)
  if (pre.changed) log.info(`installed PreToolUse hook → ${preCmd}`)
  if (post.changed) log.info(`installed PostToolUse hook → ${postCmd}`)
  log.info(`edit ~/.claude/settings.json to remove or run \`claude-discord-bot uninstall-hook\``)
}

export function uninstallHook(): void {
  const preCmd = resolveHookCommand()
  const postCmd = resolvePostToolUseHookCommand()
  let settings = readSettings()
  const pre = removeHookFromSettings(settings, preCmd, 'PreToolUse')
  const post = removeHookFromSettings(pre.settings, postCmd, 'PostToolUse')
  settings = post.settings

  if (!pre.changed && !post.changed) {
    log.info(`hooks not present (nothing to remove)`)
    return
  }
  writeSettings(settings)
  if (pre.changed) log.info(`removed PreToolUse hook → ${preCmd}`)
  if (post.changed) log.info(`removed PostToolUse hook → ${postCmd}`)
}
