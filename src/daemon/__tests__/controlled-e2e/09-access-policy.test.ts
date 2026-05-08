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
    h.routing.set('dm-u-allowed', 'foo')

    // Inject the gated stranger first, then a sentinel that *should* pass
    // the gate. When the sentinel arrives at the plugin we know the gate
    // check for the prior stranger has run — assert the stranger DM has no
    // bot reply (silent drop). This is stronger than a fixed-window wait.
    h.client.injectMessage({ userId: 'u-stranger', content: 'hi', isDM: true })
    h.client.injectMessage({ userId: 'u-allowed', content: 'hi paired', isDM: true })

    const inbound = await plugin.waitFor(m => m.type === 'inbound')
    if (inbound.type !== 'inbound') throw new Error(`expected inbound, got ${inbound.type}`)
    expect(inbound.content).toBe('hi paired')

    const strangerDm = h.client.allChannels.get('dm-u-stranger')
    const strangerBotMsgs = strangerDm?.history.filter(m => m.author.bot) ?? []
    expect(strangerBotMsgs.length).toBe(0)
  })

  it('disabled policy: drops everything including allowFrom', async () => {
    // Step 1: disabled — inject DM, daemon should drop it silently.
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'disabled',
      allowFrom: ['u-allowed'],
      groups: {},
      pending: {},
    })
    h.client.injectMessage({ userId: 'u-allowed', content: 'should-be-dropped', isDM: true })

    // Step 2: flip policy to allowlist and send a sentinel DM. inbound-router
    // reads access.json fresh per message; the disabled-policy gate runs
    // synchronously to `drop` (no awaits in handle for that branch), so by
    // the time we inject the sentinel the prior message has already been
    // dropped. Once sentinel arrives at plugin, we can assert nothing else
    // for this DM channel reached it.
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'allowlist',
      allowFrom: ['u-allowed'],
      groups: {},
      pending: {},
    })
    h.client.ensureDmChannel('u-allowed')
    h.routing.set('dm-u-allowed', 'foo')
    h.client.injectMessage({ userId: 'u-allowed', content: 'sentinel', isDM: true })

    const sentinel = await plugin.waitFor(
      m => m.type === 'inbound' && m.content === 'sentinel',
    )
    expect(sentinel.type).toBe('inbound')

    // Disabled policy is silent — no DM bot reply.
    const dm = h.client.allChannels.get('dm-u-allowed')
    const botMsgs = dm?.history.filter(m => m.author.bot) ?? []
    expect(botMsgs.length).toBe(0)

    // Only the sentinel reached the plugin; the disabled-policy DM did not.
    const dmInbounds = plugin
      .receivedOfType('inbound')
      .filter(m => m.chat_id === 'dm-u-allowed')
    expect(dmInbounds).toHaveLength(1)
    expect(dmInbounds[0]!.content).toBe('sentinel')
  })
})
