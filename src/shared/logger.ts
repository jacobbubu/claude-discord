/**
 * Minimal stderr logger. Daemon and CLI write structured-ish lines to stderr,
 * never stdout (to keep MCP / pipe scenarios clean).
 *
 * Day-1 implementation is bare. Day-2 may swap for tslog or pino.
 */

const LEVEL = process.env.CLAUDE_DISCORD_LOG_LEVEL ?? 'info'
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const
type Level = keyof typeof LEVELS

const enabled = (l: Level): boolean =>
  LEVELS[l] <= (LEVELS[LEVEL as Level] ?? LEVELS.info)

export const log = {
  error: (msg: string) => enabled('error') && process.stderr.write(`[error] ${msg}\n`),
  warn: (msg: string) => enabled('warn') && process.stderr.write(`[warn] ${msg}\n`),
  info: (msg: string) => enabled('info') && process.stderr.write(`[info] ${msg}\n`),
  debug: (msg: string) => enabled('debug') && process.stderr.write(`[debug] ${msg}\n`),
}
