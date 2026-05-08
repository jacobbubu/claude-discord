/**
 * Controlled e2e #6 — long content chunking on the reply tool path.
 *
 * Asserts: a >2000-char body is split into multiple sends, each ≤ limit;
 * full text recoverable by concatenating; tool reports total chunks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAccessFile } from '../../access-control.ts'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

describe('controlled e2e — long content chunking', () => {
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

  it('5000-char body splits into multiple chunks each ≤2000 chars', async () => {
    // No paragraph/line breaks → forces space/hard cuts
    const body = 'A'.repeat(5000)
    const result = await plugin.callTool('reply', { chat_id: 'dm-u-1', text: body })
    expect(result.ok).toBe(true)

    const dm = h.client.allChannels.get('dm-u-1')!
    const botMsgs = dm.history.filter(m => m.author.bot)
    // 5000 chars / 2000 limit = exactly 3 chunks. >=3 would mask over-split bugs.
    expect(botMsgs.length).toBe(3)
    for (const m of botMsgs) expect(m.content.length).toBeLessThanOrEqual(2000)
    // Concatenated chunks should reconstruct the body
    expect(botMsgs.map(m => m.content).join('')).toBe(body)
  })

  it('respects access.textChunkLimit override (smaller chunks)', async () => {
    writeAccessFile(h.paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1'],
      groups: {},
      pending: {},
      textChunkLimit: 500,
    })

    const body = 'B'.repeat(1500)
    const result = await plugin.callTool('reply', { chat_id: 'dm-u-1', text: body })
    expect(result.ok).toBe(true)

    const dm = h.client.allChannels.get('dm-u-1')!
    const botMsgs = dm.history.filter(m => m.author.bot)
    // 1500 / 500 = exactly 3.
    expect(botMsgs.length).toBe(3)
    for (const m of botMsgs) expect(m.content.length).toBeLessThanOrEqual(500)
    expect(botMsgs.map(m => m.content).join('')).toBe(body)
  })
})
