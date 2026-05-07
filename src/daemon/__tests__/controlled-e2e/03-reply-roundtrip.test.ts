/**
 * Controlled e2e #3 — reply tool round-trip.
 *
 *   1. Mock plugin registers as workspace 'foo'
 *   2. Test injects DM from allowed user → daemon routes inbound to plugin
 *   3. Mock plugin issues `reply` tool_call back to the channel
 *   4. Daemon dispatches to MockClient → mock channel captures the message
 *   5. tool_result returns ok with sent id
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

describe('controlled e2e — reply round-trip', () => {
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
    const reg = await plugin.register()
    expect(reg.ok).toBe(true)
  })

  afterEach(async () => {
    await plugin.close()
    await h.shutdown()
  })

  it('plugin tool_call(reply) → mock channel captures bot message', async () => {
    const dmChannelId = 'dm-u-1'
    // DM channel must exist (recipientId is checked against allowFrom in
    // fetchTextChannel). Real flow creates it on first inbound message.
    h.client.ensureDmChannel('u-1')
    h.routing.set(dmChannelId, 'foo')

    // Send a tool_call to push a reply
    const result = await plugin.callTool('reply', {
      chat_id: dmChannelId,
      text: 'hello from CC',
    })
    expect(result.ok).toBe(true)
    expect(result.result).toMatch(/sent/)

    // Verify mock Discord captured the message
    const dm = h.client.allChannels.get(dmChannelId)
    expect(dm).toBeDefined()
    const botMsgs = dm!.history.filter(m => m.author.bot)
    expect(botMsgs.length).toBe(1)
    expect(botMsgs[0]!.content).toBe('hello from CC')
  })

  it('inbound DM routes to plugin as inbound NDJSON', async () => {
    const dmChannelId = 'dm-u-1'
    h.routing.set(dmChannelId, 'foo')

    h.client.injectMessage({
      userId: 'u-1',
      content: 'hello bot',
      isDM: true,
    })

    const inbound = await plugin.waitFor(m => m.type === 'inbound')
    expect(inbound.type).toBe('inbound')
    if (inbound.type === 'inbound') {
      expect(inbound.content).toBe('hello bot')
      expect(inbound.user_id).toBe('u-1')
      expect(inbound.chat_id).toBe(dmChannelId)
    }
  })
})
