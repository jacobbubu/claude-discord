/**
 * Architecture deltas §55b (issue #140): tail CC session transcripts and
 * surface Anthropic API errors (rate-limit / overload / auth) into Discord.
 *
 * Why this exists: an API 429 / 529 hits CC *before* it calls into the plugin
 * — the daemon never sees it over the socket. Spike 11 (#137) confirmed the CC
 * `Notification` hook does not carry the signal either. The only ground-truth
 * source is the session transcript JSONL, where CC records each failure as a
 * line with `isApiErrorMessage: true` (plus `apiErrorStatus` / `error`).
 *
 * The PostToolUse hook now forwards `transcript_path`; the daemon calls
 * `observe()` with it. The watcher polls each observed transcript, reads only
 * newly-appended bytes (tail-from-EOF — historical errors are never replayed),
 * and on a fresh API-error line invokes `onApiError`.
 *
 * `poll()` is callable directly so tests don't need real timers; `start()`
 * drives it on an interval in production.
 *
 * §55c (issue #143): a sub-agent's API errors land in its own
 * `<session>/subagents/agent-*.jsonl` — never in the main transcript, and the
 * cc_tool_trace path is always the *main* transcript. So `observe()` also
 * registers the derived `subagents/` directory and `poll()` auto-discovers +
 * tails sub-agent transcripts as they appear.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { log } from '../shared/logger.ts'

/** How often to scan observed transcripts for appended lines. */
const DEFAULT_POLL_MS = 2_000

/** Cap on bytes read per poll per file — a runaway transcript shouldn't make
 *  one poll read tens of MB. Anything beyond is picked up on the next poll. */
const MAX_READ_BYTES = 1 << 20 // 1 MiB

export type ApiErrorInfo = {
  /** HTTP-ish status from `apiErrorStatus` (429 / 529 / 401 / ...). */
  status?: number
  /** Short code from `error` (rate_limit / server_error / ...). */
  code?: string
  /** Human-readable text CC recorded (the "API Error: ..." string). */
  text: string
}

type Entry = {
  /** observe-time cwd — matches the registry's conn.cwd. */
  cwd: string
  /** Byte offset already consumed. */
  offset: number
  /** Trailing partial line carried to the next read. */
  partial: string
}

export type TranscriptWatcherOpts = {
  /** Poll interval in ms. Default 2000. */
  pollMs?: number
}

export class TranscriptWatcher {
  private readonly pollMs: number
  private readonly entries = new Map<string, Entry>()
  /** §55c: derived `subagents/` dirs → cwd, polled for new agent-*.jsonl. */
  private readonly subagentDirs = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    /** Invoked once per fresh API-error line. `cwd` is the observe-time cwd
     *  (matches the registry's conn.cwd). The callback must not throw. */
    private readonly onApiError: (cwd: string, info: ApiErrorInfo) => void,
    opts: TranscriptWatcherOpts = {},
  ) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  }

  /**
   * Start (idempotently) tailing `transcriptPath` (a main session transcript)
   * and register this session's `subagents/` directory. Called on every
   * `cc_tool_trace`, so it must stay cheap + idempotent.
   */
  observe(transcriptPath: string, cwd: string): void {
    this.observeFile(transcriptPath, cwd, false)

    // §55c (issue #143): a sub-agent's API errors go to its own
    // <session>/subagents/agent-*.jsonl, and the cc_tool_trace path is always
    // the *main* transcript — so we derive + watch the subagents dir here.
    const dir = subagentsDirFor(transcriptPath)
    if (dir && !this.subagentDirs.has(dir)) {
      this.subagentDirs.set(dir, cwd)
      // Sub-agent transcripts already present when we start watching → tail
      // from EOF (skip history). Ones appearing later are picked up from
      // offset 0 by poll().
      for (const f of listAgentFiles(dir)) {
        this.observeFile(join(dir, f), cwd, false)
      }
    }
  }

  /**
   * Add `path` to the tail set if not already tracked. `fromStart=false`
   * tails from the current EOF (skip history); `true` tails from offset 0.
   */
  private observeFile(path: string, cwd: string, fromStart: boolean): void {
    if (this.entries.has(path)) return
    let offset = 0
    if (!fromStart) {
      try {
        offset = statSync(path).size
      } catch (e) {
        // File not there yet — start at 0; scan() tolerates a missing file.
        log.debug(`transcript-watcher: stat ${path} failed: ${e}`)
      }
    }
    this.entries.set(path, { cwd, offset, partial: '' })
    log.debug(`transcript-watcher: observing ${path} (cwd=${cwd}, from byte ${offset})`)
  }

  /** Begin the poll loop. No-op if already started. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), this.pollMs)
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  /** Stop the poll loop and drop all observed entries. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.entries.clear()
    this.subagentDirs.clear()
  }

  /** Test hook: number of transcript files currently tailed. */
  get observedCount(): number {
    return this.entries.size
  }

  /** Test hook: number of `subagents/` directories being watched. */
  get watchedDirCount(): number {
    return this.subagentDirs.size
  }

  /** Scan every observed transcript once for newly-appended lines, after
   *  discovering sub-agent transcripts that appeared since the last poll. */
  poll(): void {
    // §55c: pick up sub-agent transcripts spawned since the last poll.
    for (const [dir, cwd] of this.subagentDirs) {
      for (const f of listAgentFiles(dir)) {
        const p = join(dir, f)
        if (!this.entries.has(p)) this.observeFile(p, cwd, true)
      }
    }
    for (const [path, entry] of this.entries) {
      try {
        this.scan(path, entry)
      } catch (e) {
        log.debug(`transcript-watcher: scan ${path} failed: ${e}`)
      }
    }
  }

  private scan(path: string, entry: Entry): void {
    const size = statSync(path).size
    if (size <= entry.offset) {
      // No growth, or the file shrank / rotated — resync without replaying.
      entry.offset = size
      return
    }
    const want = Math.min(size - entry.offset, MAX_READ_BYTES)
    const buf = Buffer.allocUnsafe(want)
    const fd = openSync(path, 'r')
    let read = 0
    try {
      read = readSync(fd, buf, 0, want, entry.offset)
    } finally {
      closeSync(fd)
    }
    entry.offset += read

    const chunk = entry.partial + buf.toString('utf8', 0, read)
    const lines = chunk.split('\n')
    // The last element is whatever followed the final newline — possibly an
    // incomplete line still being written; carry it to the next scan.
    entry.partial = lines.pop() ?? ''
    for (const line of lines) {
      const info = parseApiError(line)
      if (info) this.onApiError(entry.cwd, info)
    }
  }
}

/**
 * Derive a session's `subagents/` directory from its main transcript path:
 * `<dir>/<session-id>.jsonl` → `<dir>/<session-id>/subagents`. Returns null
 * when the path isn't a `.jsonl`.
 */
function subagentsDirFor(transcriptPath: string): string | null {
  if (!transcriptPath.endsWith('.jsonl')) return null
  const base = basename(transcriptPath).slice(0, -'.jsonl'.length)
  return join(dirname(transcriptPath), base, 'subagents')
}

/** List `agent-*.jsonl` files (sub-agent transcripts) in `dir`; returns []
 *  if the dir doesn't exist yet. Sibling `agent-*.meta.json` are skipped. */
function listAgentFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
  } catch {
    return []
  }
}

/**
 * Parse one transcript JSONL line; return `ApiErrorInfo` iff it is an API
 * error record (`isApiErrorMessage: true`), else null. Exported for unit
 * testing.
 */
export function parseApiError(line: string): ApiErrorInfo | null {
  const trimmed = line.trim()
  // Cheap pre-filter — skip JSON.parse on the many non-error transcript lines.
  if (!trimmed || !trimmed.includes('isApiErrorMessage')) return null
  let rec: unknown
  try {
    rec = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof rec !== 'object' || rec === null) return null
  const r = rec as Record<string, unknown>
  if (r.isApiErrorMessage !== true) return null

  const status = typeof r.apiErrorStatus === 'number' ? r.apiErrorStatus : undefined
  const code = typeof r.error === 'string' ? r.error : undefined
  return { status, code, text: extractText(r) }
}

/** Pull the human-readable error text out of a transcript record's
 *  `message.content` (an array of `{type,text}` parts, or a plain string). */
function extractText(r: Record<string, unknown>): string {
  const msg = r.message
  if (typeof msg === 'object' && msg !== null) {
    const content = (msg as Record<string, unknown>).content
    if (typeof content === 'string' && content.length > 0) return content
    if (Array.isArray(content)) {
      const parts = content
        .map(c =>
          typeof c === 'object' && c !== null
            ? (c as Record<string, unknown>).text
            : undefined,
        )
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
      if (parts.length > 0) return parts.join(' ')
    }
  }
  // Fallback when the shape is unexpected.
  const status = r.apiErrorStatus
  return `API error${typeof status === 'number' ? ` ${status}` : ''}`
}
