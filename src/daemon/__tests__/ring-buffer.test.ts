import { describe, expect, it } from 'vitest'
import { RingBuffer, RingBufferMap, shouldAutoDisplay } from '../ring-buffer.ts'

const push = (b: RingBuffer, partial: Partial<Parameters<RingBuffer['push']>[0]> = {}) => {
  b.push({ channelId: 'c1', direction: 'in', text: 'hello', ...partial })
}

describe('RingBuffer', () => {
  it('push then recent in order', () => {
    const b = new RingBuffer()
    push(b, { text: 'a' })
    push(b, { text: 'b' })
    push(b, { text: 'c' })
    const r = b.recent(2)
    expect(r.length).toBe(2)
    expect(r[0]!.textPreview).toBe('b')
    expect(r[1]!.textPreview).toBe('c')
  })

  it('caps at 50 entries (oldest dropped)', () => {
    const b = new RingBuffer()
    for (let i = 0; i < 60; i++) push(b, { text: `m${i}` })
    expect(b.size).toBe(50)
    const oldestKept = b.recent(50)[0]!.textPreview
    expect(oldestKept).toBe('m10')
  })

  it('truncates long preview', () => {
    const b = new RingBuffer()
    push(b, { text: 'x'.repeat(500) })
    expect(b.recent(1)[0]!.textPreview.endsWith('…')).toBe(true)
    expect(b.recent(1)[0]!.textPreview.length).toBeLessThanOrEqual(201)
  })

  it('lastActivity / lastChannel reflect newest', () => {
    const b = new RingBuffer()
    push(b, { ts: 100, channelId: 'c1' })
    push(b, { ts: 200, channelId: 'c2' })
    expect(b.lastActivity()).toBe(200)
    expect(b.lastChannel()).toBe('c2')
  })

  it('clear empties', () => {
    const b = new RingBuffer()
    push(b)
    b.clear()
    expect(b.isEmpty()).toBe(true)
    expect(b.lastActivity()).toBe(0)
    expect(b.lastChannel()).toBeNull()
  })
})

describe('shouldAutoDisplay', () => {
  it('false for empty buffer', () => {
    expect(shouldAutoDisplay(new RingBuffer(), 'c1', 1_000_000)).toBe(false)
  })

  it('false when last activity < 15 min ago', () => {
    const b = new RingBuffer()
    push(b, { ts: 1_000_000, channelId: 'cOther' })
    expect(shouldAutoDisplay(b, 'c1', 1_000_000 + 5 * 60 * 1000)).toBe(false)
  })

  it('false when last channel == current', () => {
    const b = new RingBuffer()
    push(b, { ts: 0, channelId: 'c1' })
    expect(shouldAutoDisplay(b, 'c1', 99 * 60 * 1000)).toBe(false)
  })

  it('true when stale + different channel', () => {
    const b = new RingBuffer()
    push(b, { ts: 0, channelId: 'cOther' })
    expect(shouldAutoDisplay(b, 'c1', 99 * 60 * 1000)).toBe(true)
  })
})

describe('RingBufferMap', () => {
  it('for() creates lazily, get returns same instance', () => {
    const m = new RingBufferMap()
    const a = m.for('foo')
    const b = m.for('foo')
    expect(a).toBe(b)
    expect(m.size).toBe(1)
  })

  it('delete removes', () => {
    const m = new RingBufferMap()
    m.for('foo')
    m.delete('foo')
    expect(m.size).toBe(0)
    expect(m.get('foo')).toBeUndefined()
  })
})
