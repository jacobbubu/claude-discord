/**
 * Live e2e #3 — real plugin subprocess, multi-turn permission round-trip.
 *
 * #24 originally proposed a real-claude-CLI + tmux multi-turn permission
 * test. Investigation showed that path requires patching the mock client to
 * surface button customIds, installing the PreToolUse hook into a temp
 * CLAUDE_CONFIG_DIR, navigating §27's freshness gate, etc. — high cost for
 * a release-gate-only test. This file fills the same gap at the layer that
 * actually matters: the **plugin subprocess's permission_request relay**.
 *
 * Architecture:
 *   [vitest: harness daemon + mock discord client]
 *      ↑ real Unix socket NDJSON       ↑ discord.js Client (mock)
 *      ↓
 *   [plugin subprocess: bun src/plugin/index.ts]
 *      ↑ MCP stdio (server side)
 *      ↓
 *   [test as MCP client — sends notifications/claude/channel/permission_request,
 *    receives notifications/claude/channel/permission]
 *
 * What this proves over the existing tiers:
 *   - controlled-e2e #4 uses a mock plugin in-process — protocol level only
 *   - live-e2e #1 covers reply tool but not the permission notification path
 *   - live-e2e #2 covers --print mode but doesn't exercise multi-turn permission
 *   - HERE: real plugin subprocess actually forwards CC's MCP permission_request
 *     notification to daemon, daemon DMs the user, the user's "yes <code>" text
 *     response round-trips back as a permission MCP notification to CC
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from '../controlled-e2e/_harness.ts'

const REPO = resolve(__dirname, '../../../..')
const PLUGIN_ENTRY = join(REPO, 'src/plugin/index.ts')

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const PermissionNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({
    request_id: z.string(),
    behavior: z.enum(['allow', 'deny']),
  }),
})

async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return
    await wait(25)
  }
  throw new Error(`waitUntil timed out after ${ms}ms`)
}

describe('live e2e — plugin subprocess multi-turn permission (#24)', () => {
  let h: Harness
  let mcp: McpClient | null = null
  let pluginCwd = ''

  beforeEach(async () => {
    h = await buildHarness()
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1'],
      groups: {},
      pending: {},
    })
    pluginCwd = mkdtempSync(join(tmpdir(), 'live-perm-'))
    h.client.ensureDmChannel('u-1')
  })

  afterEach(async () => {
    try {
      await mcp?.close()
    } catch {}
    mcp = null
    await h.shutdown()
  })

  async function bootPluginAsMcpServer(): Promise<McpClient> {
    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', PLUGIN_ENTRY],
      cwd: pluginCwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CLAUDE_DISCORD_SOCKET: h.paths.socketPath,
      },
      stderr: 'pipe',
    })
    const client = new McpClient(
      { name: 'live-perm-test', version: '1.0' },
      // Declare the same experimental capability the plugin advertises so the
      // server is willing to send us permission notifications.
      { capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } } },
    )
    await client.connect(transport)

    // Wait for the plugin's daemon-side register to land — proves the
    // subprocess + Unix socket + register handshake all came up.
    const t0 = Date.now()
    while (Date.now() - t0 < 5_000 && h.registry.list().length === 0) {
      await wait(50)
    }
    if (h.registry.list().length === 0) throw new Error('plugin did not register within 5s')
    return client
  }

  async function runPermissionRoundtrip(
    request_id: string,
    answer: 'yes' | 'no',
  ): Promise<{ request_id: string; behavior: string }> {
    mcp = await bootPluginAsMcpServer()

    // Arm the notification handler BEFORE issuing the request, otherwise we
    // could miss the daemon → plugin → MCP-client permission reply if the
    // round-trip is fast.
    let received: { request_id: string; behavior: string } | null = null
    const permissionReceived = new Promise<{ request_id: string; behavior: string }>(resolve => {
      mcp!.setNotificationHandler(PermissionNotificationSchema, async n => {
        received = n.params
        resolve(n.params)
      })
    })

    // Test plays the CC side: send the MCP notification that triggers the
    // plugin's permission_request relay to the daemon.
    await mcp.notification({
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id,
        tool_name: 'Bash',
        description: 'run ls',
        input_preview: '{"command":"ls"}',
      },
    })

    // Daemon should DM the only allowFrom user with the permission prompt.
    const dm = h.client.allChannels.get('dm-u-1')!
    await waitUntil(
      () => dm.history.some(m => m.author.bot && m.content.includes('Permission')),
      5_000,
    )
    const prompt = dm.history.find(m => m.author.bot && m.content.includes('Permission'))!
    expect(prompt.content).toContain('Bash')

    // User replies via DM with "yes <code>" / "no <code>".
    h.client.injectMessage({ userId: 'u-1', content: `${answer} ${request_id}`, isDM: true })

    // Daemon → plugin (NDJSON `permission`) → plugin → MCP-client (notification)
    const params = await Promise.race([
      permissionReceived,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout waiting for permission MCP notification')), 5_000),
      ),
    ])
    expect(received).toEqual(params)
    return params
  }

  it('"yes <code>" round-trips back to MCP client as permission allow', async () => {
    const params = await runPermissionRoundtrip('abcde', 'yes')
    expect(params.request_id).toBe('abcde')
    expect(params.behavior).toBe('allow')
  }, 15_000)

  it('"no <code>" round-trips back to MCP client as permission deny', async () => {
    const params = await runPermissionRoundtrip('mnopq', 'no')
    expect(params.request_id).toBe('mnopq')
    expect(params.behavior).toBe('deny')
  }, 15_000)
})
