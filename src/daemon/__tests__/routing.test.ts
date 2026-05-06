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
})
