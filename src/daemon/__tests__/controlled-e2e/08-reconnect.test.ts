/**
 * Controlled e2e #8 — plugin disconnect → reconnect.
 *
 *   1. Plugin A connects + registers as 'foo'
 *   2. Plugin A's socket closes (simulating CC restart)
 *   3. Daemon's connection-close handler unregisters 'foo'
 *   4. New plugin B connects with same cwd → registers as 'foo' again
 *   5. Inbound messages route to plugin B
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('controlled e2e — plugin reconnect', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1'],
      groups: {},
      pending: {},
    })
  })

  afterEach(async () => {
    await h.shutdown()
  })

  it('disconnect drops registration, fresh connect re-registers same name', async () => {
    const a = new MockPlugin({ socketPath: h.paths.socketPath, cwd: '/tmp/foo' })
    await a.connect()
    expect((await a.register()).ok).toBe(true)
    expect(h.registry.list().length).toBe(1)

    // Simulate CC crash / restart — close the socket.
    await a.close()
    // Give daemon a beat to handle 'close'
    await wait(30)
    expect(h.registry.list().length).toBe(0)

    // Plugin B with same cwd → same workspace name 'foo'
    const b = new MockPlugin({ socketPath: h.paths.socketPath, cwd: '/tmp/foo' })
    await b.connect()
    const reg = await b.register()
    expect(reg.ok).toBe(true)
    expect(h.registry.list().length).toBe(1)
    expect(h.registry.list()[0]!.workspace).toBe('foo')

    // New inbound routes to B
    h.routing.set('dm-u-1', 'foo')
    h.client.injectMessage({ userId: 'u-1', content: 'after reconnect', isDM: true })
    const inbound = await b.waitFor(m => m.type === 'inbound')
    if (inbound.type === 'inbound') expect(inbound.content).toBe('after reconnect')

    await b.close()
  })
})
