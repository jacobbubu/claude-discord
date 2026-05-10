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
 * Idempotent install. Returns the modified settings object.
 *
 * Strategy: find or create a PreToolUse matcher block with matcher=''. If
 * an existing hook has the same `command` substring (project path), no-op.
 * Otherwise append a new hook entry pointing at our permission-hook.ts.
 */
export function addHookToSettings(
  settings: Settings,
  hookCommand: string,
  timeoutSec = HOOK_TIMEOUT_S,
): { settings: Settings; changed: boolean } {
  const next: Settings = JSON.parse(JSON.stringify(settings ?? {}))
  next.hooks = next.hooks ?? {}
  const blocks: MatcherBlock[] = (next.hooks.PreToolUse as MatcherBlock[]) ?? []
  next.hooks.PreToolUse = blocks

  // Look for any block (any matcher) that already has our command — install
  // is idempotent, second run shouldn't duplicate.
  for (const block of blocks) {
    for (const h of block.hooks ?? []) {
      if (h.type === 'command' && typeof h.command === 'string' && h.command === hookCommand) {
        return { settings: next, changed: false }
      }
    }
  }

  // Find an existing matcher='' block to append to, otherwise create one.
  let target = blocks.find(b => (b.matcher ?? '') === '')
  if (!target) {
    target = { matcher: '', hooks: [] }
    blocks.push(target)
  }
  target.hooks.push({ type: 'command', command: hookCommand, timeout: timeoutSec })
  return { settings: next, changed: true }
}

/**
 * Idempotent removal. Strips any hook entry whose `command` exactly equals
 * our hookCommand. Empty matcher blocks are pruned. PreToolUse key is
 * removed if it ends up empty. `hooks` key removed if it ends up empty.
 */
export function removeHookFromSettings(
  settings: Settings,
  hookCommand: string,
): { settings: Settings; changed: boolean } {
  const next: Settings = JSON.parse(JSON.stringify(settings ?? {}))
  if (!next.hooks?.PreToolUse) return { settings: next, changed: false }

  let changed = false
  const blocks = next.hooks.PreToolUse
  for (const block of blocks) {
    const before = block.hooks?.length ?? 0
    block.hooks = (block.hooks ?? []).filter(
      h => !(h.type === 'command' && h.command === hookCommand),
    )
    if (block.hooks.length !== before) changed = true
  }
  next.hooks.PreToolUse = blocks.filter(b => (b.hooks?.length ?? 0) > 0)
  if (next.hooks.PreToolUse.length === 0) delete next.hooks.PreToolUse
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

export function installHook(): void {
  const cmd = resolveHookCommand()
  const current = readSettings()
  const { settings, changed } = addHookToSettings(current, cmd)
  if (!changed) {
    log.info(`hook already installed: ${cmd}`)
    return
  }
  writeSettings(settings)
  log.info(`installed PreToolUse hook → ${cmd}`)
  log.info(`edit ~/.claude/settings.json to remove or run \`claude-discord-bot uninstall-hook\``)
}

export function uninstallHook(): void {
  const cmd = resolveHookCommand()
  const current = readSettings()
  const { settings, changed } = removeHookFromSettings(current, cmd)
  if (!changed) {
    log.info(`hook not present (nothing to remove): ${cmd}`)
    return
  }
  writeSettings(settings)
  log.info(`removed PreToolUse hook → ${cmd}`)
}
