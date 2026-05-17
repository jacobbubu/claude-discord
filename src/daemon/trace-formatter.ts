/**
 * Architecture deltas §40 / §43: per-tool text renderer for the trace embed.
 *
 * §43: returns multi-embed (`TraceRender = { embeds: TraceEmbedSpec[] }`) so
 * a single trace can pack meta + input + output (and stderr when present)
 * into a stack of related embeds within one Discord message. The combined
 * 6000-char total cap across embeds gives long Bash/Read traces more room
 * than the single-embed 4096-char description allowed.
 *
 * Per-tool layouts:
 *   - Bash: meta (Status/Intent/Interrupted fields) + Command + stdout + stderr?
 *   - Read: meta (File/Range fields) + Content
 *   - Grep/Glob: meta (Pattern/Path fields) + Hits
 *   - WebFetch/WebSearch: meta (URL/Query) + Body
 *   - Edit/MultiEdit/Write: meta (File field) + YAML body (silicon PNG via §39
 *     attaches to this body embed via `imageAttachment`)
 *   - Generic / unknown: meta (tool name) + Input (YAML) + Output (YAML)
 *
 * Pure module — no side effects, no I/O. Consumer (`tool-trace.ts`) converts
 * each TraceEmbedSpec to an EmbedBuilder + applies any image attachment.
 */

import type { CcToolTraceMsg } from '../protocol/schema.ts'

const EMBED_DESC_MAX = 4000 // Discord embed.description hard cap is 4096
const FIELD_VALUE_MAX = 1024 // Discord embed.field.value hard cap
const INTENT_MAX = 200

const COLOR_OK = 0x5865f2 // Discord blurple
const COLOR_ERROR = 0xed4245 // Discord red

export type EmbedField = { name: string; value: string; inline?: boolean }

/**
 * §43: a single embed in a multi-embed trace render. tool-trace.ts converts
 * this to a real EmbedBuilder + attaches any referenced files.
 */
export type TraceEmbedSpec = {
  title?: string
  description?: string
  color?: number
  fields?: EmbedField[]
  /**
   * If set, consumer will attach a file with this name via §39
   * AttachmentBuilder and set `embed.image = attachment://<name>`. Used by
   * Edit/MultiEdit/Write to inline the silicon diff PNG.
   */
  imageAttachment?: string
}

export type TraceRender = { embeds: TraceEmbedSpec[] }

/**
 * Per-tool emoji icon for the embed title. Falls back to the generic wrench
 * for unknown tools. Error status overrides this in tool-trace.ts (renders
 * ❌ instead).
 */
export function toolIcon(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return '💻'
    case 'Read':
      return '📖'
    case 'Grep':
      return '🔍'
    case 'Glob':
      return '📁'
    case 'Edit':
    case 'MultiEdit':
      return '✏️'
    case 'Write':
      return '📝'
    case 'WebFetch':
      return '🌐'
    case 'WebSearch':
      return '🔎'
    default:
      return '🔧'
  }
}

/**
 * §43 main entry. Returns a multi-embed spec; tool-trace.ts builds real
 * EmbedBuilders + sends in one message.
 */
export function renderTrace(msg: CcToolTraceMsg): TraceRender {
  const input = safeParseJson(msg.tool_input)
  const color = msg.status === 'error' ? COLOR_ERROR : COLOR_OK
  switch (msg.tool_name) {
    case 'Bash':
      return renderBash(input, msg.tool_response, msg.status, color)
    case 'Read':
      return renderRead(input, msg.tool_response, color)
    case 'Grep':
      return renderGrep(input, msg.tool_response, color)
    case 'Glob':
      return renderGlob(input, msg.tool_response, color)
    case 'WebFetch':
      return renderWebFetch(input, msg.tool_response, color)
    case 'WebSearch':
      return renderWebSearch(input, msg.tool_response, color)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return renderFileWrite(msg.tool_name, input, color)
    default:
      return renderGeneric(msg.tool_name, msg.tool_input, msg.tool_response, color)
  }
}

// ─── per-tool renderers ──────────────────────────────────────────────────────

function renderBash(
  input: unknown,
  response: string,
  status: 'ok' | 'error',
  color: number,
): TraceRender {
  const cmd = pickString(input, 'command')
  const intent = pickString(input, 'description')
  const parsed = safeParseJson(response)
  // CC hook payload: { stdout, stderr, interrupted, isImage, noOutputExpected }.
  // No exitCode (per #112). Envelope fallback if shape is unexpected.
  const stdoutTop = pickString(parsed, 'stdout')
  const stderr = pickString(parsed, 'stderr')
  const interrupted = pickBoolean(parsed, 'interrupted')
  const stdout = stdoutTop ?? extractToolText(response)

  const fields: EmbedField[] = []
  fields.push({ name: 'Status', value: status === 'error' ? '❌ error' : '✅ ok', inline: true })
  if (interrupted === true) {
    fields.push({ name: 'Interrupted', value: '⏸ yes', inline: true })
  }
  if (intent) fields.push({ name: 'Intent', value: trim(intent, INTENT_MAX), inline: true })

  const embeds: TraceEmbedSpec[] = [
    { title: `${toolIcon('Bash')} Bash`, color, fields },
  ]
  if (cmd) {
    embeds.push({
      title: 'Command',
      description: clampDescription(fence('bash', cmd)),
      color,
    })
  }
  if (stdout && stdout.length > 0) {
    embeds.push({
      title: 'stdout',
      description: clampDescription(fence('text', stdout)),
      color,
    })
  }
  if (stderr && stderr.length > 0) {
    embeds.push({
      title: 'stderr',
      description: clampDescription(fence('text', stderr)),
      color: COLOR_ERROR,
    })
  }
  return { embeds }
}

function renderRead(input: unknown, response: string, color: number): TraceRender {
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
  return {
    embeds: [
      { title: `${toolIcon('Read')} Read`, color, fields },
      {
        title: 'Content',
        description: clampDescription(fence('text', extractToolText(response))),
        color,
      },
    ],
  }
}

function renderGrep(input: unknown, response: string, color: number): TraceRender {
  const pattern = pickString(input, 'pattern')
  const path = pickString(input, 'path')
  const fields: EmbedField[] = []
  if (pattern) fields.push({ name: 'Pattern', value: `\`${pattern}\``, inline: true })
  if (path) fields.push({ name: 'Path', value: `\`${path}\``, inline: true })
  return {
    embeds: [
      { title: `${toolIcon('Grep')} Grep`, color, fields },
      {
        title: 'Hits',
        description: clampDescription(fence('text', extractToolText(response))),
        color,
      },
    ],
  }
}

function renderGlob(input: unknown, response: string, color: number): TraceRender {
  const pattern = pickString(input, 'pattern')
  const path = pickString(input, 'path')
  const fields: EmbedField[] = []
  if (pattern) fields.push({ name: 'Pattern', value: `\`${pattern}\``, inline: true })
  if (path) fields.push({ name: 'Path', value: `\`${path}\``, inline: true })
  return {
    embeds: [
      { title: `${toolIcon('Glob')} Glob`, color, fields },
      {
        title: 'Matches',
        description: clampDescription(fence('text', extractToolText(response))),
        color,
      },
    ],
  }
}

function renderWebFetch(input: unknown, response: string, color: number): TraceRender {
  const url = pickString(input, 'url')
  const fields: EmbedField[] = []
  if (url) fields.push({ name: 'URL', value: url, inline: false })
  return {
    embeds: [
      { title: `${toolIcon('WebFetch')} WebFetch`, color, fields },
      {
        title: 'Body',
        description: clampDescription(fence('text', extractToolText(response))),
        color,
      },
    ],
  }
}

function renderWebSearch(input: unknown, response: string, color: number): TraceRender {
  const query = pickString(input, 'query')
  const fields: EmbedField[] = []
  if (query) fields.push({ name: 'Query', value: `\`${query}\``, inline: true })
  return {
    embeds: [
      { title: `${toolIcon('WebSearch')} WebSearch`, color, fields },
      {
        title: 'Results',
        description: clampDescription(fence('text', extractToolText(response))),
        color,
      },
    ],
  }
}

function renderFileWrite(
  tool: 'Edit' | 'MultiEdit' | 'Write',
  input: unknown,
  color: number,
): TraceRender {
  const filePath = pickString(input, 'file_path')
  const fields: EmbedField[] = []
  if (filePath) fields.push({ name: 'File', value: `\`${filePath}\``, inline: true })
  // Text fallback for §39 diff image: YAML dump of input keeps before/after
  // searchable even when silicon isn't installed / fails. The image (when
  // available) attaches via `imageAttachment` (consumer adds the file +
  // sets embed.image = attachment://<name>).
  return {
    embeds: [
      { title: `${toolIcon(tool)} ${tool}`, color, fields },
      {
        title: 'Diff',
        description: clampDescription(fence('yaml', jsonToYaml(input))),
        color,
        imageAttachment: DIFF_IMAGE_NAME,
      },
    ],
  }
}

function renderGeneric(
  toolName: string,
  toolInput: string,
  toolResponse: string,
  color: number,
): TraceRender {
  const inputYaml = jsonToYaml(safeParseJson(toolInput) ?? toolInput)
  const responseYaml = jsonToYaml(safeParseJson(toolResponse) ?? toolResponse)
  return {
    embeds: [
      { title: `${toolIcon(toolName)} ${toolName}`, color },
      {
        title: 'Input',
        description: clampDescription(fence('yaml', inputYaml)),
        color,
      },
      {
        title: 'Output',
        description: clampDescription(fence('yaml', responseYaml)),
        color,
      },
    ],
  }
}

/**
 * §43: well-known attachment filename used by Edit/MultiEdit/Write renderers
 * to reference the silicon-rendered diff PNG. tool-trace.ts uses this same
 * constant when constructing the AttachmentBuilder so the `attachment://`
 * URL in the embed matches.
 */
export const DIFF_IMAGE_NAME = 'diff.png'

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Unwrap CC's structured tool-response shapes so the trace embed shows the
 * actual content instead of a JSON dump with metadata. Handles the common
 * shapes returned by Read / Grep / Glob / WebFetch / WebSearch:
 *   - `{ type: 'text', text: '...content...' }`
 *   - `{ type: 'text', file: { filePath, content } }`           (Read object)
 *   - `{ type: 'text', file: [{ filePath, content }] }`         (Read array)
 *   - `{ content: '...' }`                                      (generic)
 *   - `{ content: [{ type, text }] }`                           (Anthropic shape)
 * Falls back to raw string for plain / unknown shapes.
 */
export function extractToolText(response: string): string {
  const parsed = safeParseJson(response)
  if (parsed == null || typeof parsed !== 'object') return response
  const obj = parsed as Record<string, unknown>

  const file = obj.file
  if (Array.isArray(file) && file.length > 0) {
    const inner = file[0]
    if (inner && typeof inner === 'object') {
      const c = (inner as Record<string, unknown>).content
      if (typeof c === 'string') return c
    }
  } else if (file && typeof file === 'object') {
    const c = (file as Record<string, unknown>).content
    if (typeof c === 'string') return c
  }

  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.content === 'string') return obj.content
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const first = obj.content[0]
    if (first && typeof first === 'object') {
      const t = (first as Record<string, unknown>).text
      if (typeof t === 'string') return t
    }
  }
  return response
}

/** §40-fix: kept for callers that imported the old narrow name. */
export const extractReadContent = extractToolText

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

function pickBoolean(o: unknown, key: string): boolean | null {
  if (typeof o !== 'object' || o === null) return null
  const v = (o as Record<string, unknown>)[key]
  return typeof v === 'boolean' ? v : null
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
 * readable than JSON.stringify". Pure for testing.
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
  if (/^(true|false|null|yes|no|on|off|-?\d+(\.\d+)?)$/i.test(s)) return `"${s}"`
  if (/^[\s\-:?,&*!|>%@`#"']/.test(s) || s.includes(': ')) return JSON.stringify(s)
  return s
}
