/**
 * Architecture deltas §39: render Edit / MultiEdit / Write tool diffs as
 * silicon-rendered PNG attachments for the Discord trace thread.
 *
 * Why only these three tools (out of 30+ that CC may call): a session-level
 * tool-usage sample shows Edit/MultiEdit/Write account for ~31% of calls and
 * are the cases where text-form diff in a fenced block is hardest to read on
 * mobile. Bash (53%) and Read (14%) plain text is already legible; image
 * would only cost render latency and lose copy-selectability.
 *
 * Degradation: silicon binary missing, spawn failing, or any parsing error
 * returns `null` — trace embed still flows through with text-only fallback.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CcToolTraceMsg } from '../protocol/schema.ts'
import { log } from '../shared/logger.ts'

const SILICON_BIN = 'silicon'
const SILICON_TIMEOUT_MS = 5_000

/** Tool names that produce something diff-shaped worth rendering as an image. */
const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

/** Subset of silicon args we use; fixed for now (no per-call customization). */
const SILICON_ARGS = [
  '--language',
  'diff',
  '--theme',
  'Dracula',
  '--pad-horiz',
  '20',
  '--pad-vert',
  '20',
  '--no-window-controls',
  '--font',
  'JetBrainsMono Nerd Font;PingFang SC',
] as const

/**
 * Parse tool_input JSON string and build a unified-diff text. Returns null
 * if the tool isn't a diff-shaped one or input is unrecognizable.
 *
 * Pure for unit-testability — no I/O.
 */
export function buildDiffText(toolName: string, toolInput: string): string | null {
  if (!DIFF_TOOLS.has(toolName)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(toolInput)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const input = parsed as Record<string, unknown>
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  if (!filePath) return null

  if (toolName === 'Write') {
    const content = typeof input.content === 'string' ? input.content : ''
    return formatWriteDiff(filePath, content)
  }
  if (toolName === 'Edit') {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : null
    const newStr = typeof input.new_string === 'string' ? input.new_string : null
    if (oldStr == null || newStr == null) return null
    return formatEditHunk(filePath, [{ oldStr, newStr }])
  }
  // MultiEdit
  const edits = input.edits
  if (!Array.isArray(edits)) return null
  const hunks: { oldStr: string; newStr: string }[] = []
  for (const e of edits) {
    if (e == null || typeof e !== 'object') continue
    const o = (e as Record<string, unknown>).old_string
    const n = (e as Record<string, unknown>).new_string
    if (typeof o === 'string' && typeof n === 'string') {
      hunks.push({ oldStr: o, newStr: n })
    }
  }
  if (hunks.length === 0) return null
  return formatEditHunk(filePath, hunks)
}

/** Trim a single leading `/` so the conventional `a/<rel>` / `b/<rel>` form
 *  doesn't double up to `a//abs`. Absolute paths stay readable in the diff
 *  header without the redundant slash. */
function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p
}

function formatWriteDiff(filePath: string, content: string): string {
  const header = `--- /dev/null\n+++ b/${stripLeadingSlash(filePath)}\n`
  const body = content.split('\n').map(line => `+${line}`).join('\n')
  return `${header}@@ +1 @@\n${body}\n`
}

function formatEditHunk(
  filePath: string,
  hunks: { oldStr: string; newStr: string }[],
): string {
  const rel = stripLeadingSlash(filePath)
  const header = `--- a/${rel}\n+++ b/${rel}\n`
  const body = hunks
    .map(({ oldStr, newStr }) => {
      const oldLines = oldStr.split('\n').map(l => `-${l}`).join('\n')
      const newLines = newStr.split('\n').map(l => `+${l}`).join('\n')
      return `@@ edit @@\n${oldLines}\n${newLines}`
    })
    .join('\n')
  return `${header}${body}\n`
}

/**
 * Render the diff text via silicon to a temp PNG and return its path.
 * Spawns silicon, waits up to SILICON_TIMEOUT_MS, returns null on any failure
 * (ENOENT, non-zero exit, timeout). Caller is responsible for unlinking the
 * returned path after consuming it.
 */
export async function renderDiffImage(msg: CcToolTraceMsg): Promise<string | null> {
  const diff = buildDiffText(msg.tool_name, msg.tool_input)
  if (diff == null) return null

  const dir = mkdtempSync(join(tmpdir(), 'cd-diff-'))
  const inputPath = join(dir, 'diff.txt')
  const outputPath = join(dir, 'diff.png')
  try {
    writeFileSync(inputPath, diff)
  } catch (e) {
    log.debug(`renderDiffImage: write diff failed: ${e}`)
    return null
  }

  return new Promise<string | null>(resolve => {
    let settled = false
    const child = spawn(SILICON_BIN, [...SILICON_ARGS, '--output', outputPath, inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {}
      log.debug('renderDiffImage: silicon timeout')
      resolve(null)
    }, SILICON_TIMEOUT_MS)
    timer.unref()

    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log.debug(`renderDiffImage: silicon spawn error: ${err.message}`)
      resolve(null)
    })
    child.on('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        log.debug(`renderDiffImage: silicon exit ${code}`)
        resolve(null)
        return
      }
      resolve(outputPath)
    })
  })
}
