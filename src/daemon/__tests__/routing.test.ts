import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RoutingTable } from '../routing.ts'

describe('RoutingTable', () => {
  it('returns null for unknown channel when file missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    const t = new RoutingTable(join(dir, 'routing.json'))
    expect(t.get('c1')).toBeNull()
  })

  it('set then get round-trips and persists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    const path = join(dir, 'routing.json')
    const t = new RoutingTable(path)
    t.set('c1', 'foo', 1_000)
    expect(t.get('c1')?.workspace).toBe('foo')
    expect(t.get('c1')?.switched_at).toBe(1_000)

    // new instance reads from disk
    const t2 = new RoutingTable(path)
    expect(t2.get('c1')?.workspace).toBe('foo')
  })

  it('switching builds history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    const t = new RoutingTable(join(dir, 'routing.json'))
    t.set('c1', 'foo', 1)
    t.set('c1', 'bar', 2)
    expect(t.get('c1')?.workspace).toBe('bar')
    expect(t.get('c1')?.history[0]).toBe('foo')
  })

  it('handles corrupt JSON by quarantining', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    const path = join(dir, 'routing.json')
    writeFileSync(path, 'not json')
    const t = new RoutingTable(path)
    expect(t.get('c1')).toBeNull()
  })

  it('channelsFor returns all channels bound to a workspace (§26)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    const t = new RoutingTable(join(dir, 'routing.json'))
    t.set('c1', 'foo', 1)
    t.set('c2', 'bar', 2)
    t.set('c3', 'foo', 3)
    expect(t.channelsFor('foo').sort()).toEqual(['c1', 'c3'])
    expect(t.channelsFor('bar')).toEqual(['c2'])
    expect(t.channelsFor('nope')).toEqual([])
  })

  it('unset removes a binding and persists; no-op when not bound (§26)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    const path = join(dir, 'routing.json')
    const t = new RoutingTable(path)
    t.set('c1', 'foo', 1)
    t.unset('nope') // no-op, no throw
    t.unset('c1')
    expect(t.get('c1')).toBeNull()
    expect(t.channelsFor('foo')).toEqual([])
    // persisted: a fresh instance also sees it gone
    const t2 = new RoutingTable(path)
    expect(t2.get('c1')).toBeNull()
  })

  describe('indicator_message_id (§53)', () => {
    it('setIndicatorMessageId persists across instances', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rt-'))
      const path = join(dir, 'routing.json')
      const t = new RoutingTable(path)
      t.set('c1', 'foo', 1)
      t.setIndicatorMessageId('c1', 'msg-123')
      expect(t.get('c1')?.indicator_message_id).toBe('msg-123')

      const t2 = new RoutingTable(path)
      expect(t2.get('c1')?.indicator_message_id).toBe('msg-123')
    })

    it('preserves indicator_message_id across workspace switch (set)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rt-'))
      const t = new RoutingTable(join(dir, 'routing.json'))
      t.set('c1', 'foo', 1)
      t.setIndicatorMessageId('c1', 'msg-123')
      t.set('c1', 'bar', 2)
      // workspace changed, indicator carries over (we edit the same message)
      expect(t.get('c1')?.workspace).toBe('bar')
      expect(t.get('c1')?.indicator_message_id).toBe('msg-123')
    })

    it('setIndicatorMessageId(null) clears the id', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rt-'))
      const t = new RoutingTable(join(dir, 'routing.json'))
      t.set('c1', 'foo', 1)
      t.setIndicatorMessageId('c1', 'msg-123')
      t.setIndicatorMessageId('c1', null)
      expect(t.get('c1')?.indicator_message_id).toBeUndefined()
    })

    it('setIndicatorMessageId no-ops when channel has no entry', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rt-'))
      const t = new RoutingTable(join(dir, 'routing.json'))
      t.setIndicatorMessageId('c-ghost', 'msg-123') // no throw, no entry created
      expect(t.get('c-ghost')).toBeNull()
    })

    it('reads existing routing.json that lacks indicator_message_id (backward compat)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rt-'))
      const path = join(dir, 'routing.json')
      writeFileSync(path, JSON.stringify({
        version: 1,
        channels: {
          c1: { workspace: 'foo', history: [], switched_at: 1 },
        },
      }))
      const t = new RoutingTable(path)
      expect(t.get('c1')?.workspace).toBe('foo')
      expect(t.get('c1')?.indicator_message_id).toBeUndefined()
    })
  })
})
