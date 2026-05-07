/**
 * Live e2e #2 — real `claude` CLI subprocess drives a real plugin.
 *
 * Architecture:
 *   [vitest: harness daemon + mock discord client]
 *      ↑ real Unix socket NDJSON                ↑ mock discord.js
 *   [plugin subprocess (auto-spawned by claude as MCP server)]
 *      ↑ MCP stdio
 *   [claude CLI subprocess: --print --dangerously-skip-permissions]
 *
 * GATED: this test costs API tokens and needs `claude` on PATH with a
 * working subscription. Set CLAUDE_DISCORD_LIVE=1 to enable. Otherwise
 * skipped at runtime — keeps CI green and routine `bun test` fast.
 *
 * Why it exists: the controlled-e2e tier (mock plugin) and live-e2e #1
 * (real plugin, MCP-driven by test) both stop short of validating that
 * Claude itself can reach our `reply` tool through the published MCP
 * surface. This script is the authoritative end-to-end gate, ran on
 * release branches and before public-flip.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from '../controlled-e2e/_harness.ts'

const REPO = resolve(__dirname, '../../../..')
const PLUGIN_ENTRY = join(REPO, 'src/plugin/index.ts')

// `it.skipIf` keeps the test skipped (not silent) when the flag is off.
const ENABLED = process.env.CLAUDE_DISCORD_LIVE === '1'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('live e2e — real claude CLI driver', () => {
  let h: Harness
  let workCwd = ''

  beforeEach(async () => {
    h = await buildHarness()
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1'],
      groups: {},
      pending: {},
    })
    workCwd = mkdtempSync(join(tmpdir(), 'live-claude-'))
    h.client.ensureDmChannel('u-1')
  })

  afterEach(async () => {
    await h.shutdown()
  })

  it.skipIf(!ENABLED)('claude --print → reply tool → mock channel', async () => {
    // Write a per-test MCP config pointing absolute paths at our plugin
    // and threading the harness socket via env.
    const mcpConfig = {
      mcpServers: {
        'claude-discord': {
          command: 'bun',
          args: ['run', PLUGIN_ENTRY],
          env: {
            CLAUDE_DISCORD_SOCKET: h.paths.socketPath,
          },
        },
      },
    }
    const mcpConfigPath = join(workCwd, 'mcp.json')
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2))

    const prompt =
      'Use the discord reply tool (claude-discord MCP server) to send the exact text "hello from real claude" to chat_id "dm-u-1". Then stop.'

    // claude's `--mcp-config <configs...>` is variadic, so positional prompt
    // gets eaten if it follows. Pipe the prompt via stdin instead — `--print`
    // accepts `--input-format text` (the default) over stdin.
    const proc = spawn(
      'claude',
      ['--print', '--dangerously-skip-permissions', '--mcp-config', mcpConfigPath],
      {
        cwd: workCwd,
        env: {
          ...process.env,
          CLAUDE_DISCORD_SOCKET: h.paths.socketPath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    proc.stdin!.end(prompt)
    let stdout = ''
    let stderr = ''
    proc.stdout!.on('data', d => (stdout += d.toString()))
    proc.stderr!.on('data', d => (stderr += d.toString()))

    const exitCode: number = await new Promise(r => proc.on('exit', c => r(c ?? -1)))

    // Allow a beat for any in-flight tool_call → daemon → mock send to settle.
    await wait(100)

    const dm = h.client.allChannels.get('dm-u-1')!
    const botMsgs = dm.history.filter(m => m.author.bot)

    if (botMsgs.length === 0) {
      // eslint-disable-next-line no-console
      console.error('claude exit', exitCode, '\nstdout:\n', stdout, '\nstderr:\n', stderr)
    }
    expect(botMsgs.length).toBeGreaterThanOrEqual(1)
    expect(botMsgs[0]!.content).toMatch(/hello from real claude/)
  }, 90_000)
})
