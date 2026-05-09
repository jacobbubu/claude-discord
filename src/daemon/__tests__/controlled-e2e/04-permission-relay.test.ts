/**
 * Controlled e2e #4 — permission relay text path.
 *
 *   1. Plugin issues permission_request (request_id 'abcde')
 *   2. Daemon DMs the allowFrom user with buttons + "yes abcde" instructions
 *   3. We inject DM "yes abcde" from the same user
 *   4. Daemon claims pending, dispatches `permission` (allow) back to plugin
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('controlled e2e — permission relay (text)', () => {
  let h: Harness
  let plugin: MockPlugin

  beforeEach(async () => {
    h = await buildHarness()
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1'],
      groups: {},
      pending: {},
    })
    plugin = new MockPlugin({ socketPath: h.paths.socketPath, cwd: '/tmp/foo' })
    await plugin.connect()
    await plugin.register()
    h.client.ensureDmChannel('u-1')
    h.routing.set('dm-u-1', 'foo')
  })

  afterEach(async () => {
    await plugin.close()
    await h.shutdown()
  })

  it('"yes <code>" from allowed user → plugin receives allow', async () => {
    plugin.sendPermissionRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'run ls',
      input_preview: '{"command":"ls"}',
    })

    // Wait for daemon to DM the user (which proves the request landed)
    await wait(50)
    const dm = h.client.allChannels.get('dm-u-1')
    expect(dm).toBeDefined()
    const dmBotMsgs = dm!.history.filter(m => m.author.bot)
    const promptMsg = dmBotMsgs.find(m => m.content.includes('Permission'))
    expect(promptMsg).toBeDefined()
    // Main prompt surfaces the tool name only — request_id is folded into
    // the "See more" expansion (polish #29).
    expect(promptMsg!.content).toContain('Bash')
    expect(promptMsg!.content).not.toContain('abcde')

    // User replies with "yes abcde"
    h.client.injectMessage({ userId: 'u-1', content: 'yes abcde', isDM: true })

    const perm = await plugin.waitFor(m => m.type === 'permission')
    if (perm.type !== 'permission') throw new Error(`expected permission, got ${perm.type}`)
    expect(perm.request_id).toBe('abcde')
    expect(perm.behavior).toBe('allow')
  })

  it('"no <code>" from allowed user → plugin receives deny', async () => {
    plugin.sendPermissionRequest({
      request_id: 'mnopq',
      tool_name: 'Write',
      description: 'write file',
      input_preview: '{"file":"x.md"}',
    })
    await wait(50)

    h.client.injectMessage({ userId: 'u-1', content: 'no mnopq', isDM: true })

    const perm = await plugin.waitFor(m => m.type === 'permission')
    if (perm.type !== 'permission') throw new Error(`expected permission, got ${perm.type}`)
    expect(perm.request_id).toBe('mnopq')
    expect(perm.behavior).toBe('deny')
  })
})
