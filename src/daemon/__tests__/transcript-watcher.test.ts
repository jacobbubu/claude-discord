/**
 * Unit tests for §55b (issue #140) TranscriptWatcher — tail-from-EOF + line
 * parsing against real temp files. `poll()` is driven directly so no timers.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseApiError, TranscriptWatcher } from '../transcript-watcher.ts'

/** Build a transcript JSONL line that looks like CC's API-error record. */
function apiErrorLine(opts: { status?: number; code?: string; text?: string } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    apiErrorStatus: opts.status ?? 429,
    error: opts.code ?? 'rate_limit',
    cwd: '/x',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            opts.text ??
            'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
        },
      ],
    },
  })
}

describe('TranscriptWatcher (§55b)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcript-test-'))
    file = join(dir, 'session.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports an API-error line appended after observe', () => {
    writeFileSync(file, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(file, '/work/cwd')
    appendFileSync(file, apiErrorLine() + '\n')
    w.poll()
    expect(onApiError).toHaveBeenCalledTimes(1)
    const [cwd, info] = onApiError.mock.calls[0]!
    expect(cwd).toBe('/work/cwd')
    expect(info.status).toBe(429)
    expect(info.code).toBe('rate_limit')
    expect(info.text).toContain('Rate limited')
  })

  it('does not replay history written before observe', () => {
    writeFileSync(file, apiErrorLine() + '\n' + apiErrorLine() + '\n')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(file, '/x') // tail-from-EOF
    w.poll()
    expect(onApiError).not.toHaveBeenCalled()
    appendFileSync(file, apiErrorLine() + '\n')
    w.poll()
    expect(onApiError).toHaveBeenCalledTimes(1)
  })

  it('ignores non-error transcript lines', () => {
    writeFileSync(file, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(file, '/x')
    appendFileSync(
      file,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    )
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      }) + '\n',
    )
    w.poll()
    expect(onApiError).not.toHaveBeenCalled()
  })

  it('buffers a partial line until its newline arrives', () => {
    writeFileSync(file, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(file, '/x')
    const line = apiErrorLine()
    const half = Math.floor(line.length / 2)
    appendFileSync(file, line.slice(0, half)) // no newline yet
    w.poll()
    expect(onApiError).not.toHaveBeenCalled()
    appendFileSync(file, line.slice(half) + '\n') // completes the line
    w.poll()
    expect(onApiError).toHaveBeenCalledTimes(1)
  })

  it('reports each line of a multi-line burst once', () => {
    writeFileSync(file, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(file, '/x')
    appendFileSync(file, apiErrorLine() + '\n' + apiErrorLine() + '\n' + apiErrorLine() + '\n')
    w.poll()
    expect(onApiError).toHaveBeenCalledTimes(3)
    w.poll() // second poll — nothing new
    expect(onApiError).toHaveBeenCalledTimes(3)
  })

  it('observe is idempotent for the same path', () => {
    writeFileSync(file, '')
    const w = new TranscriptWatcher(vi.fn())
    w.observe(file, '/x')
    w.observe(file, '/x')
    expect(w.observedCount).toBe(1)
  })

  it('poll tolerates a missing transcript file', () => {
    const w = new TranscriptWatcher(vi.fn())
    w.observe(join(dir, 'nonexistent.jsonl'), '/x')
    expect(() => w.poll()).not.toThrow()
  })

  it('stop() drops all observed entries', () => {
    writeFileSync(file, '')
    const w = new TranscriptWatcher(vi.fn())
    w.observe(file, '/x')
    expect(w.observedCount).toBe(1)
    w.stop()
    expect(w.observedCount).toBe(0)
  })
})

describe('TranscriptWatcher §55c — sub-agent transcripts', () => {
  let dir: string
  let mainFile: string
  let subagentsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcript-sub-test-'))
    mainFile = join(dir, 'session.jsonl')
    // observe(mainFile) derives <dir>/session/subagents
    subagentsDir = join(dir, 'session', 'subagents')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers the derived subagents dir on observe', () => {
    writeFileSync(mainFile, '')
    const w = new TranscriptWatcher(vi.fn())
    w.observe(mainFile, '/x')
    expect(w.watchedDirCount).toBe(1)
  })

  it('discovers a sub-agent transcript that appears after observe and reports its errors', () => {
    writeFileSync(mainFile, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(mainFile, '/work') // subagents dir does not exist yet
    // sub-agent spawns later:
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(join(subagentsDir, 'agent-abc.jsonl'), apiErrorLine() + '\n')
    w.poll()
    expect(onApiError).toHaveBeenCalledTimes(1)
    expect(onApiError.mock.calls[0]![0]).toBe('/work')
  })

  it('tails a newly-appeared sub-agent transcript from offset 0', () => {
    writeFileSync(mainFile, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(mainFile, '/x')
    mkdirSync(subagentsDir, { recursive: true })
    // file is born with an error already in it, before the watcher sees it
    writeFileSync(join(subagentsDir, 'agent-1.jsonl'), apiErrorLine({ status: 529 }) + '\n')
    w.poll()
    expect(onApiError).toHaveBeenCalledTimes(1)
    expect(onApiError.mock.calls[0]![1].status).toBe(529)
  })

  it('does not replay history of sub-agent transcripts present at observe-time', () => {
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(
      join(subagentsDir, 'agent-old.jsonl'),
      apiErrorLine() + '\n' + apiErrorLine() + '\n',
    )
    writeFileSync(mainFile, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(mainFile, '/x') // pre-existing agent file → tailed from EOF
    w.poll()
    expect(onApiError).not.toHaveBeenCalled()
    appendFileSync(join(subagentsDir, 'agent-old.jsonl'), apiErrorLine() + '\n')
    w.poll()
    expect(onApiError).toHaveBeenCalledTimes(1)
  })

  it('ignores agent-*.meta.json siblings', () => {
    writeFileSync(mainFile, '')
    const onApiError = vi.fn()
    const w = new TranscriptWatcher(onApiError)
    w.observe(mainFile, '/x')
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(join(subagentsDir, 'agent-z.meta.json'), '{"not":"a transcript"}\n')
    w.poll()
    expect(onApiError).not.toHaveBeenCalled()
    expect(w.observedCount).toBe(1) // only the main transcript
  })
})

describe('parseApiError (§55b) — pure', () => {
  it('parses a 429 rate-limit record', () => {
    const info = parseApiError(apiErrorLine({ status: 429, code: 'rate_limit' }))
    expect(info).not.toBeNull()
    expect(info!.status).toBe(429)
    expect(info!.code).toBe('rate_limit')
    expect(info!.text).toContain('Rate limited')
  })

  it('returns null for a normal transcript line', () => {
    expect(parseApiError(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull()
  })

  it('returns null for an empty / whitespace line', () => {
    expect(parseApiError('')).toBeNull()
    expect(parseApiError('   ')).toBeNull()
  })

  it('returns null when isApiErrorMessage is false', () => {
    expect(
      parseApiError(JSON.stringify({ isApiErrorMessage: false, message: { content: 'x' } })),
    ).toBeNull()
  })

  it('returns null for malformed JSON even if it mentions isApiErrorMessage', () => {
    expect(parseApiError('{isApiErrorMessage: true, broken')).toBeNull()
  })

  it('reads content given as a plain string', () => {
    const line = JSON.stringify({
      isApiErrorMessage: true,
      apiErrorStatus: 529,
      message: { content: 'API Error: 529 Overloaded' },
    })
    expect(parseApiError(line)!.text).toBe('API Error: 529 Overloaded')
  })

  it('falls back to synthetic text when the message shape is unexpected', () => {
    const info = parseApiError(JSON.stringify({ isApiErrorMessage: true, apiErrorStatus: 401 }))
    expect(info!.text).toContain('401')
  })
})
