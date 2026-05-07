/**
 * Controlled e2e #10 — guild channel opt-in + mention 3 paths.
 *
 * Uses MockClient guild channel + injected messages with mention semantics.
 */

import { ChannelType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

describe('controlled e2e — guild channel + mention', () => {
  let h: Harness
  let plugin: MockPlugin

  beforeEach(async () => {
    h = await buildHarness()
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: { cg1: { requireMention: true, allowFrom: [] } },
      pending: {},
      mentionPatterns: ['^hey claude\\b'],
    })
    plugin = new MockPlugin({ socketPath: h.paths.socketPath, cwd: '/tmp/foo' })
    await plugin.connect()
    await plugin.register()
    h.client.ensureGuildChannel('g1', 'cg1')
    h.routing.set('cg1', 'foo')
  })

  afterEach(async () => {
    await plugin.close()
    await h.shutdown()
  })

  it('guild channel without mention is dropped', async () => {
    h.client.injectMessage({
      userId: 'u-2',
      channelId: 'cg1',
      isDM: false,
      content: 'plain message',
    })
    // No inbound after a beat
    await new Promise(r => setTimeout(r, 30))
    expect(plugin.receivedOfType('inbound')).toHaveLength(0)
  })

  it('guild channel with structured @mention delivers', async () => {
    h.client.injectMessage({
      userId: 'u-2',
      channelId: 'cg1',
      isDM: false,
      content: '<@BOT_USER> hello',
    })
    const inbound = await plugin.waitFor(m => m.type === 'inbound')
    if (inbound.type === 'inbound') expect(inbound.content).toBe('<@BOT_USER> hello')
  })

  it('guild channel with mentionPatterns regex match delivers', async () => {
    h.client.injectMessage({
      userId: 'u-2',
      channelId: 'cg1',
      isDM: false,
      content: 'hey claude what time is it?',
    })
    const inbound = await plugin.waitFor(m => m.type === 'inbound')
    if (inbound.type === 'inbound') expect(inbound.content).toMatch(/hey claude/)
  })

  it('guild channel without opt-in is dropped even with mention', async () => {
    // Register a NEW channel that's not in groups
    h.client.ensureGuildChannel('g1', 'cg2')
    h.client.injectMessage({
      userId: 'u-2',
      channelId: 'cg2',
      isDM: false,
      content: '<@BOT_USER> hello',
    })
    await new Promise(r => setTimeout(r, 30))
    // Plugin already received messages from earlier tests in this file's describe — we need to count NEW
    // Easier: use a fresh channel instance check
    const cg2 = h.client.allChannels.get('cg2')
    expect(cg2?.type).toBe(ChannelType.GuildText)
    // The inbound count for cg2 specifically should be 0
    const inboundsForCg2 = plugin
      .receivedOfType('inbound')
      .filter(m => m.chat_id === 'cg2')
    expect(inboundsForCg2).toHaveLength(0)
  })
})
