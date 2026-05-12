import { describe, expect, it } from 'vitest'
import { Connection, INBOUND_FRESHNESS_TTL_MS } from '../connection.ts'

function makeConn(): Connection {
  // socket is unused by the methods under test
  return new Connection({} as never)
}

describe('Connection.isInboundFresh (deltas §27)', () => {
  it('is false when no inbound was ever received', () => {
    expect(makeConn().isInboundFresh()).toBe(false)
  })

  it('is true right after an inbound', () => {
    const c = makeConn()
    c.lastInboundTs = Date.now()
    expect(c.isInboundFresh()).toBe(true)
  })

  it('is false once the inbound is older than the TTL', () => {
    const c = makeConn()
    c.lastInboundTs = Date.now() - INBOUND_FRESHNESS_TTL_MS - 1
    expect(c.isInboundFresh()).toBe(false)
  })

  it('honors a custom ttl argument', () => {
    const c = makeConn()
    c.lastInboundTs = Date.now() - 10_000
    expect(c.isInboundFresh(5_000)).toBe(false)
    expect(c.isInboundFresh(30_000)).toBe(true)
  })
})
