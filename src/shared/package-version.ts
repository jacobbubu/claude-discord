/**
 * §48: shared helper to read the runtime version from package.json so both
 * the CLI (`claude-discord-bot --version`) and the daemon startup log can
 * report the same value without hardcoded drift (the CLI literal was
 * `0.0.1` for 45 releases until §46 fixed it).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Walk up from this module's directory until we find a `package.json`.
 * Works whether we're running from `src/...ts` (development), from `dist/`
 * (built bundle), or from `node_modules/claude-discord-bot/...` (npm
 * install).
 */
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    let dir = here
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          version?: string
          name?: string
        }
        // Only accept claude-discord-bot's package.json (in case the walker
        // hits a parent project's package.json first).
        if (pkg.name === 'claude-discord-bot' && typeof pkg.version === 'string') {
          return pkg.version
        }
      } catch {
        /* keep walking */
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return '0.0.0'
  } catch {
    return '0.0.0'
  }
}
