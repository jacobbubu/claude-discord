/**
 * `claude-discord-bot install-codex` / `uninstall-codex` — register the
 * MCP server entry in `~/.codex/config.toml` so Codex desktop / CLI / IDE
 * spawn our plugin and route MCP tool calls through it.
 *
 * Strategy: surgical text edit (not full TOML round-trip). User's
 * config.toml typically has hand-curated comments + ordering we mustn't
 * destroy. We only append / strip our own `[mcp_servers.claude-discord]`
 * block, leaving everything else byte-for-byte intact.
 *
 * §49 (issue #130). Pure helpers exported for unit testing; CLI wrapper
 * at the bottom does I/O.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from '../shared/logger.ts'

const SECTION_HEADER = '[mcp_servers.claude-discord]'
const BLOCK_MARKER_START = '# claude-discord-bot install-codex (managed — do not edit by hand)'
const BLOCK_MARKER_END = '# /claude-discord-bot install-codex'

export type CodexInstallOpts = {
  configPath?: string
  pluginCommand?: string
  pluginArgs?: string[]
}

/**
 * Resolve the absolute path to `src/plugin/index.ts` so the entry we write
 * still works when the user globally installed via npm.
 */
export function resolvePluginCommand(): { command: string; args: string[] } {
  // CLI module sits at `src/cli/install-codex.ts`. The plugin entry is
  // `src/plugin/index.ts` in the same package. Walk up from this module.
  const here = dirname(fileURLToPath(import.meta.url))
  const pluginEntry = join(here, '..', 'plugin', 'index.ts')
  return { command: 'bun', args: ['run', pluginEntry] }
}

/** Path Codex reads MCP config from. Override with $CODEX_HOME (Codex
 *  honors this env). Exported for unit-test injection. */
export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME
    : join(homedir(), '.codex')
  return join(codexHome, 'config.toml')
}

/**
 * Pure: given existing config.toml text and the desired plugin command,
 * return the new text with our block appended if not already present.
 * Idempotent: re-running with the same input returns identical output.
 */
export function addCodexEntry(
  existing: string,
  pluginCommand: string,
  pluginArgs: string[],
): { text: string; changed: boolean } {
  if (existing.includes(SECTION_HEADER)) {
    return { text: existing, changed: false }
  }
  const argsToml = JSON.stringify(pluginArgs).replace(/"/g, '"')
  const block = [
    '',
    BLOCK_MARKER_START,
    SECTION_HEADER,
    `command = ${JSON.stringify(pluginCommand)}`,
    `args = ${argsToml}`,
    BLOCK_MARKER_END,
    '',
  ].join('\n')
  // Append to end, ensuring exactly one blank line between user content
  // and our block.
  const base = existing.endsWith('\n') ? existing : `${existing}\n`
  return { text: `${base}${block}`, changed: true }
}

/**
 * Pure: remove our block (matched by `BLOCK_MARKER_START` … `BLOCK_MARKER_END`).
 * If the markers aren't found, fall back to removing the legacy section
 * (`[mcp_servers.claude-discord]` + its `key = value` lines until the
 * next `[...]` header or EOF). Idempotent.
 */
export function removeCodexEntry(existing: string): { text: string; changed: boolean } {
  if (existing.includes(BLOCK_MARKER_START) && existing.includes(BLOCK_MARKER_END)) {
    // Strip from start-marker line through end-marker line (inclusive).
    const lines = existing.split('\n')
    const startIdx = lines.findIndex(l => l.trim() === BLOCK_MARKER_START)
    const endIdx = lines.findIndex(l => l.trim() === BLOCK_MARKER_END)
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      return { text: existing, changed: false }
    }
    // Also eat one leading blank line if it preceded our block (we wrote one).
    let dropFrom = startIdx
    if (dropFrom > 0 && lines[dropFrom - 1] === '') dropFrom -= 1
    const kept = [...lines.slice(0, dropFrom), ...lines.slice(endIdx + 1)]
    return { text: kept.join('\n'), changed: true }
  }
  // Legacy block (no markers — e.g. user hand-added the section before we
  // started writing markers). Strip the section header line and following
  // lines until the next `[...]` header.
  if (existing.includes(SECTION_HEADER)) {
    const lines = existing.split('\n')
    const start = lines.findIndex(l => l.trim() === SECTION_HEADER)
    if (start === -1) return { text: existing, changed: false }
    let end = start + 1
    while (end < lines.length && !lines[end]!.trim().startsWith('[')) end++
    // Eat trailing blank line if any
    while (end > start + 1 && lines[end - 1]!.trim() === '') end -= 1
    const kept = [...lines.slice(0, start), ...lines.slice(end)]
    return { text: kept.join('\n'), changed: true }
  }
  return { text: existing, changed: false }
}

export function installCodex(opts: CodexInstallOpts = {}): void {
  const configPath = opts.configPath ?? resolveCodexConfigPath()
  if (!existsSync(configPath)) {
    log.error(
      `Codex config not found at ${configPath}. Install / launch Codex first, then re-run.`,
    )
    process.exit(1)
  }
  const { command, args } = opts.pluginCommand
    ? { command: opts.pluginCommand, args: opts.pluginArgs ?? [] }
    : resolvePluginCommand()
  const existing = readFileSync(configPath, 'utf8')
  const { text, changed } = addCodexEntry(existing, command, args)
  if (!changed) {
    log.info(`claude-discord MCP entry already present in ${configPath}`)
    return
  }
  writeFileSync(configPath, text)
  log.info(`registered claude-discord MCP server in ${configPath}`)
  log.info(`restart Codex desktop / CLI to pick up the change.`)
}

export function uninstallCodex(opts: CodexInstallOpts = {}): void {
  const configPath = opts.configPath ?? resolveCodexConfigPath()
  if (!existsSync(configPath)) {
    log.info(`Codex config not found at ${configPath} — nothing to remove.`)
    return
  }
  const existing = readFileSync(configPath, 'utf8')
  const { text, changed } = removeCodexEntry(existing)
  if (!changed) {
    log.info(`claude-discord MCP entry not present in ${configPath}.`)
    return
  }
  writeFileSync(configPath, text)
  log.info(`removed claude-discord MCP server from ${configPath}.`)
}
