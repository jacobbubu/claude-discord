/**
 * Real-subprocess e2e: spawn daemon process + plugin process, drive plugin
 * via MCP Client SDK (= what Claude Code does at runtime).
 *
 * No Discord token, so daemon runs in degraded mode. We verify:
 *   - daemon socket comes up
 *   - plugin spawns under StdioClientTransport, completes register handshake
 *   - listTools returns the 5-tool MCP surface
 *   - callTool(reply) reaches daemon's tool dispatcher and comes back with
 *     ok=false 'discord gateway not running' (the expected degraded-mode result)
 *   - shutdown is clean
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Strip Discord secret env vars before spawning child processes (#93).
 * The test asserts the daemon runs in degraded mode (no real gateway), which
 * relies on `DISCORD_BOT_TOKEN` being unset. Developer shells (e.g. this
 * repo's yolo2 profile) routinely export the token, so without this scrub
 * the daemon would happily log in to Discord and the test would fail on the
 * wrong error string.
 */
function spawnEnv(): Record<string, string> {
  const e = { ...process.env } as Record<string, string | undefined>
  delete e.DISCORD_BOT_TOKEN
  delete e.DISCORD_CHANNEL_ID
  // Drop undefineds so callers can pass this to spawn() typed as
  // Record<string, string>.
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === 'string') clean[k] = v
  }
  return clean
}

describe('subprocess e2e (real daemon + real plugin + MCP Client)', () => {
  let stateDir: string
  let daemon: ChildProcess
  let client: Client | null = null
  let transport: StdioClientTransport | null = null

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'e2e-'))
  })

  afterEach(async () => {
    if (client) {
      try {
        await client.close()
      } catch {}
      client = null
    }
    transport = null
    if (daemon) {
      try {
        daemon.kill('SIGTERM')
        await wait(300)
        if (!daemon.killed) daemon.kill('SIGKILL')
      } catch {}
    }
  })

  it('lists 5 tools and degraded reply returns gateway-not-running error', async () => {
    // 1. Spawn daemon
    daemon = spawn('bun', ['run', join(REPO_ROOT, 'src/cli/index.ts'), 'start'], {
      env: { ...spawnEnv(), CLAUDE_DISCORD_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Wait for socket to come up (max 5s)
    const sockPath = join(stateDir, 'daemon.sock')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !existsSync(sockPath)) await wait(50)
    expect(existsSync(sockPath)).toBe(true)

    // 2. Spawn plugin via StdioClientTransport (= CC's path)
    transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', join(REPO_ROOT, 'src/plugin/index.ts')],
      env: { ...spawnEnv(), CLAUDE_DISCORD_STATE_DIR: stateDir },
    })
    client = new Client({ name: 'mock-cc', version: '0.0.1' }, { capabilities: {} })
    await client.connect(transport)

    // 3. listTools should return 8 tools (7 daemon-routed + whoami local)
    const tools = await client.listTools()
    const names = tools.tools.map(t => t.name).sort()
    expect(names).toEqual([
      'discord_ask_question',
      'download_attachment',
      'edit_message',
      'fetch_messages',
      'react',
      'reply',
      'thread_reply',
      'whoami',
    ])

    // 4. callTool(reply) — daemon's gateway is absent, so dispatcher returns
    //    the degraded error. Plugin surfaces it as MCP tool error result.
    const result = (await client.callTool({
      name: 'reply',
      arguments: { chat_id: 'c1', text: 'hi' },
    })) as { content?: Array<{ type: string; text: string }>; isError?: boolean }

    expect(result.isError).toBe(true)
    const text = result.content?.[0]?.text ?? ''
    expect(text).toMatch(/discord gateway not running/)

    // 5. shutdown is clean — afterEach handles
  }, 15_000)
})
