/**
 * CLI smoke test (§46): spawn the real `claude-discord-bot` entry as a
 * subprocess and assert it boots without import errors, lists every expected
 * subcommand in `--help`, and reports the package.json version on `--version`.
 *
 * Catches install-time regressions that import-level unit tests miss:
 *   - missing commander registration for a new subcommand
 *   - broken import chain breaking the whole binary
 *   - --version drifting from package.json
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// vitest runs from repo root, so cwd is reliable here. `import.meta.dir` is
// undefined under vitest's module loader, which is why we don't use it.
const REPO_ROOT = process.cwd()
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts')

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bun', ['run', CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // 15s upper bound is generous — `--help` exits immediately.
    timeout: 15_000,
    // Prevent the daemon hook env from leaking into the subprocess.
    env: { ...process.env, DISCORD_BOT_TOKEN: '', DISCORD_CHANNEL_ID: '' },
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 }
}

describe('CLI smoke (§46)', () => {
  it('--help exits 0 and lists every expected subcommand', () => {
    const r = runCli(['--help'])
    expect(r.status).toBe(0)
    // The combined output (help may go to stdout or stderr depending on shell);
    // commander emits to stdout but be tolerant.
    const out = `${r.stdout}\n${r.stderr}`

    // Every subcommand registered in index.ts. Adding one without listing
    // it here is the regression we want to catch.
    const expected = [
      'start',
      'configure',
      'pair',
      'deny',
      'allow',
      'remove',
      'policy',
      'group',
      'set',
      'access',
      'install',
      'uninstall',
      'install-hook',
      'uninstall-hook',
      'status',
      'dev',
      'reset',
      'stop',
      'restart',
      'logs',
    ]
    for (const cmd of expected) {
      expect(out).toContain(cmd)
    }
  })

  it('--version reflects package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
    const r = runCli(['--version'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  })

  it('unknown subcommand exits non-zero', () => {
    const r = runCli(['this-subcommand-does-not-exist'])
    expect(r.status).not.toBe(0)
  })

  it('install --dry-run runs without spawning the installer side effects', () => {
    // `install --dry-run` should print the plan and exit cleanly without
    // touching launchd / systemd. If commander wiring breaks or install.ts
    // imports fail, this catches it.
    const r = runCli(['install', '--dry-run'])
    // Either succeeds (printed plan) or fails with a deterministic reason
    // (e.g. unsupported platform on CI). Either way the subcommand must be
    // *reachable* — what we're guarding against is "no such command".
    const out = `${r.stdout}\n${r.stderr}`
    expect(out).not.toMatch(/unknown command/i)
  })
})
