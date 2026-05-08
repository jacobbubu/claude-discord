/**
 * Live e2e #1 — real plugin subprocess + real MCP stdio + real socket transport.
 *
 * Architecture:
 *   [vitest process: harness daemon + mock discord client]
 *      ↑                                    ↑
 *      | NDJSON over real Unix socket       | discord.js Client (mock)
 *      ↓                                    ↓
 *   [plugin subprocess: bun src/plugin/index.ts]
 *      ↑
 *      | MCP stdio (JSON-RPC over stdin/stdout)
 *      ↓
 *   [test as MCP client — drives tools/call]
 *
 * What this proves over the controlled-e2e tier:
 *   - Plugin's MCP server side actually talks to a real MCP client
 *   - SocketClient + ToolBridge run in a separate process
 *   - NDJSON round-trips over a real Unix socket (no in-process shortcuts)
 *   - .mcp.json's `bun run …/plugin/index.ts` invocation is reachable
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from '../controlled-e2e/_harness.ts'

const REPO = resolve(__dirname, '../../../..')
const PLUGIN_ENTRY = join(REPO, 'src/plugin/index.ts')

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('live e2e — plugin subprocess via MCP', () => {
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
    pluginCwd = mkdtempSync(join(tmpdir(), 'live-plugin-'))
  })

  afterEach(async () => {
    try {
      await mcp?.close()
    } catch {}
    mcp = null
    await h.shutdown()
  })

  it('plugin registers, MCP tools/call reply → daemon → mock channel', async () => {
    // Pre-create the DM channel so fetchTextChannel resolves recipient
    h.client.ensureDmChannel('u-1')

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
    mcp = new McpClient({ name: 'live-test', version: '1.0' })
    await mcp.connect(transport)

    // Wait up to 5s for plugin's daemon-side register to land in registry.
    const t0 = Date.now()
    while (Date.now() - t0 < 5_000 && h.registry.list().length === 0) {
      await wait(50)
    }
    expect(h.registry.list().length).toBe(1)
    expect(h.registry.list()[0]!.workspace).toBe(basename(pluginCwd))

    // List tools — sanity check MCP server side is alive
    const tools = await mcp.listTools()
    expect(tools.tools.map(t => t.name)).toContain('reply')

    // Drive tools/call reply → plugin → daemon → mock channel
    const result = await mcp.callTool({
      name: 'reply',
      arguments: { chat_id: 'dm-u-1', text: 'hello from real plugin' },
    })
    expect(result.isError).toBeFalsy()

    const dm = h.client.allChannels.get('dm-u-1')!
    const botMsgs = dm.history.filter(m => m.author.bot)
    expect(botMsgs.length).toBe(1)
    expect(botMsgs[0]!.content).toBe('hello from real plugin')
  }, 15_000)
})
