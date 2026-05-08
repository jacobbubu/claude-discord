/**
 * Controlled e2e #5 — multi-workspace routing.
 *
 * Two plugins register as 'foo' and 'bar'. Two DM channels are routed:
 * dm-u-1 → foo, dm-u-2 → bar. Inbound from each user must reach only its
 * assigned plugin. Replies from each plugin land in the right channel.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

describe('controlled e2e — multi-workspace', () => {
  let h: Harness
  let foo: MockPlugin
  let bar: MockPlugin

  beforeEach(async () => {
    h = await buildHarness()
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1', 'u-2'],
      groups: {},
      pending: {},
    })

    foo = new MockPlugin({ socketPath: h.paths.socketPath, cwd: '/tmp/foo' })
    bar = new MockPlugin({ socketPath: h.paths.socketPath, cwd: '/tmp/bar' })
    await foo.connect()
    await bar.connect()
    await foo.register()
    await bar.register()

    h.client.ensureDmChannel('u-1')
    h.client.ensureDmChannel('u-2')
    h.routing.set('dm-u-1', 'foo')
    h.routing.set('dm-u-2', 'bar')
  })

  afterEach(async () => {
    await foo.close()
    await bar.close()
    await h.shutdown()
  })

  it('inbound DMs deliver to their assigned workspace only', async () => {
    h.client.injectMessage({ userId: 'u-1', content: 'for foo', isDM: true })
    h.client.injectMessage({ userId: 'u-2', content: 'for bar', isDM: true })

    const fooMsg = await foo.waitFor(m => m.type === 'inbound')
    const barMsg = await bar.waitFor(m => m.type === 'inbound')
    if (fooMsg.type !== 'inbound') throw new Error(`expected inbound, got ${fooMsg.type}`)
    if (barMsg.type !== 'inbound') throw new Error(`expected inbound, got ${barMsg.type}`)
    expect(fooMsg.content).toBe('for foo')
    expect(barMsg.content).toBe('for bar')

    // Cross-talk check: foo only saw "for foo", not "for bar". Length must
    // be non-zero (otherwise `.every` is vacuously true and the cross-talk
    // assertion would be a no-op).
    const fooInbounds = foo.receivedOfType('inbound')
    expect(fooInbounds.length).toBeGreaterThanOrEqual(1)
    expect(fooInbounds.every(m => m.content === 'for foo')).toBe(true)
    const barInbounds = bar.receivedOfType('inbound')
    expect(barInbounds.length).toBeGreaterThanOrEqual(1)
    expect(barInbounds.every(m => m.content === 'for bar')).toBe(true)
  })

  it('replies from each plugin land in their respective DM channels', async () => {
    await foo.callTool('reply', { chat_id: 'dm-u-1', text: 'foo says hi' })
    await bar.callTool('reply', { chat_id: 'dm-u-2', text: 'bar says hi' })

    const dm1 = h.client.allChannels.get('dm-u-1')!
    const dm2 = h.client.allChannels.get('dm-u-2')!
    expect(dm1.history.filter(m => m.author.bot).map(m => m.content)).toEqual(['foo says hi'])
    expect(dm2.history.filter(m => m.author.bot).map(m => m.content)).toEqual(['bar says hi'])
  })
})
