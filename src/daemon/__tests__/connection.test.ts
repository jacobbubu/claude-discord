import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Connection, INBOUND_FRESHNESS_TTL_MS, TURN_SUNSET_MS } from '../connection.ts'

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

describe('Connection turn lifecycle (deltas §35)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts idle and isInTurn() is false', () => {
    const c = makeConn()
    expect(c.turnState).toBe('idle')
    expect(c.isInTurn()).toBe(false)
  })

  it('startTurn() transitions to active and records chatId + ts', () => {
    const c = makeConn()
    c.startTurn('chat-A')
    expect(c.turnState).toBe('active')
    expect(c.isInTurn()).toBe(true)
    expect(c.lastInboundChatId).toBe('chat-A')
    expect(c.lastInboundTs).not.toBeNull()
  })

  it('startSunset() moves active → sunset; auto-clears after TURN_SUNSET_MS', () => {
    const c = makeConn()
    c.startTurn('chat-A')
    c.startSunset()
    expect(c.turnState).toBe('sunset')
    expect(c.isInTurn()).toBe(true)

    vi.advanceTimersByTime(TURN_SUNSET_MS - 1)
    expect(c.isInTurn()).toBe(true)
    vi.advanceTimersByTime(2)
    expect(c.turnState).toBe('idle')
    expect(c.isInTurn()).toBe(false)
  })

  it('startSunset() on already-sunset resets the tail (covers §25 multi-reply pattern)', () => {
    const c = makeConn()
    c.startTurn('chat-A')
    c.startSunset(1000) // first sunset @ t=0, expires t=1000
    vi.advanceTimersByTime(800)
    expect(c.isInTurn()).toBe(true)
    c.startSunset(1000) // RESET the tail — now expires at t=800+1000=1800
    vi.advanceTimersByTime(800) // total t=1600 < 1800
    expect(c.isInTurn()).toBe(true)
    vi.advanceTimersByTime(300) // total t=1900 > 1800
    expect(c.turnState).toBe('idle')
  })

  it('startSunset() is a no-op when state is idle (no late-reply resurrection)', () => {
    const c = makeConn()
    expect(c.turnState).toBe('idle')
    c.startSunset()
    expect(c.turnState).toBe('idle')
    expect(c.isInTurn()).toBe(false)
  })

  it('a new inbound during sunset re-enters active and cancels the tail', () => {
    const c = makeConn()
    c.startTurn('chat-A')
    c.startSunset()
    expect(c.turnState).toBe('sunset')
    c.startTurn('chat-A')
    expect(c.turnState).toBe('active')
    // sunset would fire after TURN_SUNSET_MS — push past it, should stay active
    vi.advanceTimersByTime(TURN_SUNSET_MS * 2)
    expect(c.turnState).toBe('active')
  })

  it('clearTurn() force-ends regardless of state', () => {
    const c = makeConn()
    c.startTurn('chat-A')
    c.clearTurn()
    expect(c.turnState).toBe('idle')
    c.startTurn('chat-B')
    c.startSunset()
    c.clearTurn()
    expect(c.turnState).toBe('idle')
    // pending sunset timer should be cancelled
    vi.advanceTimersByTime(TURN_SUNSET_MS * 2)
    expect(c.turnState).toBe('idle')
  })

  it('close() clears the sunset timer so it cannot fire after disconnect', () => {
    const c = new Connection({ end: () => {}, destroy: () => {} } as never)
    c.startTurn('chat-A')
    c.startSunset()
    c.close()
    // Stale fire would mutate turnState on a closed conn — we verify it doesn't.
    vi.advanceTimersByTime(TURN_SUNSET_MS * 2)
    expect(c.turnState).toBe('sunset') // close cancels timer; state frozen
    expect(c.state).toBe('closed')
  })
})
