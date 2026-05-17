/**
 * Architecture deltas §40: per-tool text renderer for the trace embed.
 *
 * Replaces the old JSON-dump-everything approach with tool-specific formatting:
 * Bash extracts command + stdout + stderr + exit; Read shows file content;
 * Grep/Glob show pattern + hits; etc. Anything unknown falls back to a small
 * YAML-ish pretty-printer (way more readable than single-line JSON).
 *
 * Pure module — no side effects, no I/O. Consumer (`tool-trace.ts`) builds
 * the EmbedBuilder from the returned `description` + `fields`.
 */

import type { CcToolTraceMsg } from '../protocol/schema.ts'

const EMBED_DESC_MAX = 4000 // Discord embed.description hard cap is 4096
const FIELD_VALUE_MAX = 1024 // Discord embed.field.value hard cap
const INTENT_MAX = 200

export type EmbedField = { name: string; value: string; inline?: boolean }
export type TraceContent = { description: string; fields?: EmbedField[] }

/**
 * Main entry. Routes to a per-tool renderer; falls back to YAML dump for
 * unknown tools or when input parse fails.
 */
export function renderTraceContent(msg: CcToolTraceMsg): TraceContent {
  const input = safeParseJson(msg.tool_input)
  switch (msg.tool_name) {
    case 'Bash':
      return renderBash(input, msg.tool_response, msg.status)
    case 'Read':
      return renderRead(input, msg.tool_response)
    case 'Grep':
      return renderGrep(input, msg.tool_response)
    case 'Glob':
      return renderGlob(input, msg.tool_response)
    case 'WebFetch':
      return renderWebFetch(input, msg.tool_response)
    case 'WebSearch':
      return renderWebSearch(input, msg.tool_response)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return renderFileWrite(msg.tool_name, input, msg.tool_response)
    default:
      return renderGeneric(msg.tool_input, msg.tool_response)
  }
}

// ─── per-tool renderers ──────────────────────────────────────────────────────

function renderBash(input: unknown, response: string, status: 'ok' | 'error'): TraceContent {
  const cmd = pickString(input, 'command')
  const intent = pickString(input, 'description')
  const parsed = safeParseJson(response)
  const stdout = pickString(parsed, 'stdout') ?? response // Bash responses are objects; plain string is a graceful fallback
  const stderr = pickString(parsed, 'stderr')
  const exitCode = pickNumber(parsed, 'exitCode')

  const sections: string[] = []
  if (cmd) sections.push(`**Command**\n${fence('bash', cmd)}`)
  if (stdout && stdout.length > 0) sections.push(`**stdout**\n${fence('text', stdout)}`)
  if (stderr && stderr.length > 0) sections.push(`**stderr**\n${fence('text', stderr)}`)

  const fields: EmbedField[] = []
  fields.push({ name: 'Status', value: status === 'error' ? '❌ error' : '✅ ok', inline: true })
  if (exitCode != null) fields.push({ name: 'Exit', value: `\`${exitCode}\``, inline: true })
  if (intent) fields.push({ name: 'Intent', value: trim(intent, INTENT_MAX), inline: true })

  return { description: clampDescription(sections.join('\n')), fields }
}

function renderRead(input: unknown, response: string): TraceContent {
  const filePath = pickString(input, 'file_path')
  const offset = pickNumber(input, 'offset')
  const limit = pickNumber(input, 'limit')
  const fields: EmbedField[] = []
  if (filePath) fields.push({ name: 'File', value: `\`${filePath}\``, inline: true })
  if (offset != null || limit != null) {
    const start = offset ?? 1
    const end = limit != null ? start + limit - 1 : '?'
    fields.push({ name: 'Range', value: `${start}–${end}`, inline: true })
  }
  return { description: clampDescription(fence('text', response)), fields }
}

function renderGrep(input: unknown, response: string): TraceContent {
  const pattern = pickString(input, 'pattern')
  const path = pickString(input, 'path')
  const fields: EmbedField[] = []
  if (pattern) fields.push({ name: 'Pattern', value: `\`${pattern}\``, inline: true })
  if (path) fields.push({ name: 'Path', value: `\`${path}\``, inline: true })
  return { description: clampDescription(fence('text', response)), fields }
}

function renderGlob(input: unknown, response: string): TraceContent {
  const pattern = pickString(input, 'pattern')
  const path = pickString(input, 'path')
  const fields: EmbedField[] = []
  if (pattern) fields.push({ name: 'Pattern', value: `\`${pattern}\``, inline: true })
  if (path) fields.push({ name: 'Path', value: `\`${path}\``, inline: true })
  return { description: clampDescription(fence('text', response)), fields }
}

function renderWebFetch(input: unknown, response: string): TraceContent {
  const url = pickString(input, 'url')
  const fields: EmbedField[] = []
  if (url) fields.push({ name: 'URL', value: url, inline: false })
  return { description: clampDescription(fence('text', response)), fields }
}

function renderWebSearch(input: unknown, response: string): TraceContent {
  const query = pickString(input, 'query')
  const fields: EmbedField[] = []
  if (query) fields.push({ name: 'Query', value: `\`${query}\``, inline: true })
  return { description: clampDescription(fence('text', response)), fields }
}

function renderFileWrite(
  tool: 'Edit' | 'MultiEdit' | 'Write',
  input: unknown,
  response: string,
): TraceContent {
  const filePath = pickString(input, 'file_path')
  const fields: EmbedField[] = []
  if (filePath) fields.push({ name: 'File', value: `\`${filePath}\``, inline: true })
  // Text fallback for §39 diff image. Keep YAML-ish dump of input so the
  // before/after is searchable even when silicon is unavailable.
  const body = `**${tool}**\n${fence('yaml', jsonToYaml(input))}`
  return { description: clampDescription(body), fields }
}

function renderGeneric(toolInput: string, toolResponse: string): TraceContent {
  const inputYaml = jsonToYaml(safeParseJson(toolInput) ?? toolInput)
  const responseYaml = jsonToYaml(safeParseJson(toolResponse) ?? toolResponse)
  const body = `**Input**\n${fence('yaml', inputYaml)}\n**Output**\n${fence('yaml', responseYaml)}`
  return { description: clampDescription(body) }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function pickString(o: unknown, key: string): string | null {
  if (typeof o !== 'object' || o === null) return null
  const v = (o as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

function pickNumber(o: unknown, key: string): number | null {
  if (typeof o !== 'object' || o === null) return null
  const v = (o as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : null
}

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

/**
 * Truncate to EMBED_DESC_MAX while trying not to leave an unterminated fence.
 * Counts ``` occurrences in the kept prefix; if odd, append a closing ```.
 */
export function clampDescription(s: string, max = EMBED_DESC_MAX): string {
  if (s.length <= max) return s
  const head = s.slice(0, max - 60)
  const openFences = (head.match(/```/g) ?? []).length
  const closer = openFences % 2 === 1 ? '\n```\n' : '\n'
  return `${head}${closer}…(truncated ${s.length - head.length} chars)`
}

/**
 * Minimal "YAML-ish" pretty printer. Not strict YAML spec — goal is "more
 * readable than JSON.stringify". Pure for testing. Empty / null returns ''.
 *
 * Rules:
 *  - strings with newlines → `|-` block scalar, body indented
 *  - other strings → bare unless they need quoting (look like numbers / yaml
 *    reserved words / contain special chars)
 *  - objects → `key: value` lines, recursive with indentation
 *  - arrays → `- item` lines (item may be a sub-object, recursive)
 *  - numbers / booleans / null → bare
 */
export function jsonToYaml(value: unknown, indent = 0): string {
  if (value == null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return formatScalarString(value, indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const pad = ' '.repeat(indent)
    return value
      .map(item => {
        // Render the item at indent=0 so we can prefix its first line with
        // `- ` directly. Subsequent lines (multi-line object / nested) need
        // `  ` (2-space hanging indent) so they line up under the first key.
        const rendered = jsonToYaml(item, 0)
        const lines = rendered.split('\n')
        return lines
          .map((l, i) => (i === 0 ? `${pad}- ${l}` : `${pad}  ${l}`))
          .join('\n')
      })
      .join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return entries
      .map(([k, v]) => {
        const pad = ' '.repeat(indent)
        if (v == null || typeof v !== 'object') {
          return `${pad}${k}: ${jsonToYaml(v, indent + 2)}`
        }
        const nested = jsonToYaml(v, indent + 2)
        if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`
        if (!Array.isArray(v) && Object.keys(v as object).length === 0) return `${pad}${k}: {}`
        return `${pad}${k}:\n${nested}`
      })
      .join('\n')
  }
  return String(value)
}

function formatScalarString(s: string, indent: number): string {
  if (s.includes('\n')) {
    const pad = ' '.repeat(indent + 2)
    const body = s.split('\n').map(line => `${pad}${line}`).join('\n')
    return `|-\n${body}`
  }
  // Quote if it looks like a number / bool / null / starts with special
  if (/^(true|false|null|yes|no|on|off|-?\d+(\.\d+)?)$/i.test(s)) return `"${s}"`
  if (/^[\s\-:?,&*!|>%@`#"']/.test(s) || s.includes(': ')) return JSON.stringify(s)
  return s
}
