/**
 * Multi-writer logger. Stderr is always-on; the daemon additionally attaches
 * a rotating file sink (deltas §31) so its log isn't bounded by however the
 * launcher happens to redirect stdout/stderr.
 *
 * Day-1 implementation is bare. Day-2 may swap for tslog or pino.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs'

const LEVEL = process.env.CLAUDE_DISCORD_LOG_LEVEL ?? 'info'
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const
type Level = keyof typeof LEVELS

const enabled = (l: Level): boolean =>
  LEVELS[l] <= (LEVELS[LEVEL as Level] ?? LEVELS.info)

type Writer = (line: string) => void

const writers: Writer[] = [line => process.stderr.write(line)]

function broadcast(line: string): void {
  for (const w of writers) w(line)
}

export const log = {
  error: (msg: string) => enabled('error') && broadcast(`[error] ${msg}\n`),
  warn: (msg: string) => enabled('warn') && broadcast(`[warn] ${msg}\n`),
  info: (msg: string) => enabled('info') && broadcast(`[info] ${msg}\n`),
  debug: (msg: string) => enabled('debug') && broadcast(`[debug] ${msg}\n`),
}

export type FileSinkOpts = {
  path: string
  /** Rotate when the current file reaches this size. Default 10 MB. */
  maxBytes?: number
  /** How many rotated copies to retain (`.1`..`.${keep}`). Default 4. */
  keep?: number
}

/**
 * Deltas §31: a self-rotating file sink. Exposed separately from
 * `attachFileSink` so tests can drive it without going through the broadcast
 * + level-gate plumbing.
 *
 * Each `write(line)` does a synchronous append, then checks size and rotates
 * in-process if the threshold was crossed. Rotation shifts `.${keep-1}` →
 * `.${keep}` (overwriting the oldest), …, current → `.1`, then reopens a
 * fresh current. Lifecycle: `close()` closes the FD; subsequent `write`s
 * are silently dropped.
 */
export function makeFileSinkWriter(opts: FileSinkOpts): {
  write: Writer
  close: () => void
} {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024
  const keep = Math.max(1, opts.keep ?? 4)
  let fd: number | null = openSync(opts.path, 'a')

  const rotate = (): void => {
    if (fd == null) return
    closeSync(fd)
    fd = null
    for (let i = keep - 1; i >= 1; i--) {
      const src = `${opts.path}.${i}`
      const dst = `${opts.path}.${i + 1}`
      if (existsSync(src)) {
        try {
          renameSync(src, dst)
        } catch {
          // ignore — best effort
        }
      }
    }
    if (existsSync(opts.path)) {
      try {
        renameSync(opts.path, `${opts.path}.1`)
      } catch {
        // ignore
      }
    }
    fd = openSync(opts.path, 'a')
  }

  const write: Writer = line => {
    if (fd == null) return
    try {
      writeSync(fd, line)
      if (fstatSync(fd).size >= maxBytes) rotate()
    } catch {
      // I/O failure — swallow so the stderr writer still gets the line.
    }
  }

  return {
    write,
    close() {
      if (fd == null) return
      try {
        closeSync(fd)
      } catch {}
      fd = null
    },
  }
}

/**
 * Attach a rotating file sink to the global logger. Returned `detach` removes
 * the writer and closes the underlying FD. Daemon calls this once on startup
 * and doesn't detach (the FD is reclaimed on process exit).
 */
export function attachFileSink(opts: FileSinkOpts): { detach: () => void } {
  const sink = makeFileSinkWriter(opts)
  writers.push(sink.write)
  return {
    detach() {
      const i = writers.indexOf(sink.write)
      if (i >= 0) writers.splice(i, 1)
      sink.close()
    },
  }
}
