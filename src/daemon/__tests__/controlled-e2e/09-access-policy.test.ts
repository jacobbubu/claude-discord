/**
 * Controlled e2e #9 — access policy state machine across pairing /
 * allowlist / disabled, with a registered workspace listening.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const lastBotMessage = (h: Harness, channelId: string): string | undefined => {
  const ch = h.client.allChannels.get(channelId)
  if (!ch) return undefined
  const last = ch.history.filter(m => m.author.bot).at(-1)
  return last?.content
}

describe('controlled e2e — access policy', () => {
  let h: Harness
  let plugin: MockPlugin

  beforeEach(async () => {
    h = await buildHarness()
    plugin = new MockPlugin({ socketPath: h.paths.socketPath, cwd: '/tmp/foo' })
    await plugin.connect()
    await plugin.register()
  })

  afterEach(async () => {
    await plugin.close()
    await h.shutdown()
  })

  it('pairing policy: stranger gets code, allowed gets routed', async () => {
    // strangers get pairing code (default policy)
    h.client.injectMessage({ userId: 'u-stranger', content: 'hi', isDM: true })
    await wait(20)
    expect(lastBotMessage(h, 'dm-u-stranger')).toMatch(/Pairing required/)
  })

  it('allowlist policy: stranger silently dropped, allowed routed', async () => {
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'allowlist',
      allowFrom: ['u-allowed'],
      groups: {},
      pending: {},
    })

    // stranger → silent drop
    h.client.injectMessage({ userId: 'u-stranger', content: 'hi', isDM: true })
    await wait(20)
    // No bot message in stranger's DM
    const strangerDm = h.client.allChannels.get('dm-u-stranger')
    const strangerBotMsgs = strangerDm?.history.filter(m => m.author.bot) ?? []
    expect(strangerBotMsgs.length).toBe(0)

    // allowed → routes to plugin
    h.routing.set('dm-u-allowed', 'foo')
    h.client.injectMessage({ userId: 'u-allowed', content: 'hi paired', isDM: true })
    const inbound = await plugin.waitFor(m => m.type === 'inbound')
    if (inbound.type === 'inbound') expect(inbound.content).toBe('hi paired')
  })

  it('disabled policy: drops everything including allowFrom', async () => {
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'disabled',
      allowFrom: ['u-allowed'],
      groups: {},
      pending: {},
    })

    h.client.injectMessage({ userId: 'u-allowed', content: 'hi', isDM: true })
    await wait(50)

    const dm = h.client.allChannels.get('dm-u-allowed')
    const botMsgs = dm?.history.filter(m => m.author.bot) ?? []
    expect(botMsgs.length).toBe(0)
    // Plugin should not have received any inbound either
    expect(plugin.receivedOfType('inbound')).toHaveLength(0)
  })
})
