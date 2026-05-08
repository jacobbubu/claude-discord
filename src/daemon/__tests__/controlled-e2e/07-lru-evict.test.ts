/**
 * Controlled e2e #7 — LRU eviction when cap is exceeded.
 *
 * Configures registry with cap=3 / trim=2, registers 4 plugins → expect
 * 2 oldest evicted (their sockets closed). Surviving plugins still respond
 * to tool_calls.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHarness, type Harness } from './_harness.ts'
import { MockPlugin } from './_mock-plugin.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('controlled e2e — LRU eviction', () => {
  let h: Harness
  const plugins: MockPlugin[] = []

  beforeEach(async () => {
    h = await buildHarness({ registry: { cap: 3, trim: 2 } })
  })

  afterEach(async () => {
    for (const p of plugins.splice(0)) {
      try {
        await p.close()
      } catch {}
    }
    await h.shutdown()
  })

  it('exceeding cap evicts oldest, retains newest', async () => {
    const names = ['ws1', 'ws2', 'ws3', 'ws4']
    for (const n of names) {
      const p = new MockPlugin({ socketPath: h.paths.socketPath, cwd: `/tmp/${n}` })
      plugins.push(p)
      await p.connect()
      const ack = await p.register()
      expect(ack.ok).toBe(true)
      // Stagger lastActivityTs slightly so LRU order is deterministic
      await wait(15)
    }

    // After 4 registers with cap=3 trim=2: 4th register pushes size to 4,
    // triggers evictTo(2) → drops 2 oldest. Final size = 2.
    expect(h.registry.list().length).toBe(2)

    const remaining = new Set(h.registry.list().map(c => c.workspace!))
    expect(remaining.has('ws3')).toBe(true)
    expect(remaining.has('ws4')).toBe(true)
    expect(remaining.has('ws1')).toBe(false)
    expect(remaining.has('ws2')).toBe(false)
  })
})
