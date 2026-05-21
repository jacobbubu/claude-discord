/**
 * Unit tests for §33 TypingHeartbeat — pure-timer behavior with vi.useFakeTimers.
 * Injects a vi.fn() sendTyping callback so no DiscordGateway / mock is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypingHeartbeat } from '../typing-heartbeat.ts'

describe('TypingHeartbeat (§33)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('start() fires sendTyping immediately', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('c-1')
  })

  it('re-fires every intervalMs while running', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1')
    expect(send).toHaveBeenCalledTimes(1) // immediate
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(300)
    expect(send).toHaveBeenCalledTimes(5)
  })

  it('stop() clears the interval; no further fires', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1')
    vi.advanceTimersByTime(100) // 2 fires now
    hb.stop('c-1')
    vi.advanceTimersByTime(1_000)
    expect(send).toHaveBeenCalledTimes(2)
    expect(hb.activeCount).toBe(0)
  })

  it('stop() on an unknown chatId is a no-op', () => {
    const hb = new TypingHeartbeat(vi.fn(), { intervalMs: 100, maxMs: 10_000 })
    expect(() => hb.stop('ghost')).not.toThrow()
  })

  it('starting the same chatId again resets the timer (no stacking)', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1')
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledTimes(1)
    hb.start('c-1') // reset — should fire immediately again, but only one timer running
    expect(send).toHaveBeenCalledTimes(2)
    expect(hb.activeCount).toBe(1)
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(3) // single timer, single fire
  })

  it('tracks multiple chats independently', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1')
    hb.start('c-2')
    expect(hb.activeCount).toBe(2)
    vi.advanceTimersByTime(100)
    // 2 immediate + 2 at t=100
    expect(send).toHaveBeenCalledTimes(4)
    expect(send).toHaveBeenCalledWith('c-1')
    expect(send).toHaveBeenCalledWith('c-2')
    hb.stop('c-1')
    expect(hb.activeCount).toBe(1)
    vi.advanceTimersByTime(100)
    // Only c-2 keeps firing now
    expect(send).toHaveBeenCalledTimes(5)
  })

  it('stopAll() clears every timer at once', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1')
    hb.start('c-2')
    hb.start('c-3')
    expect(hb.activeCount).toBe(3)
    hb.stopAll()
    expect(hb.activeCount).toBe(0)
    const before = send.mock.calls.length
    vi.advanceTimersByTime(1_000)
    expect(send.mock.calls.length).toBe(before)
  })

  it('auto-stops at maxMs and clears the entry', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 500 })
    hb.start('c-1')
    vi.advanceTimersByTime(500) // max reached
    expect(hb.activeCount).toBe(0)
    const before = send.mock.calls.length
    vi.advanceTimersByTime(1_000)
    expect(send.mock.calls.length).toBe(before)
  })

  it('sendTyping rejection does not stop the heartbeat', async () => {
    const send = vi.fn().mockRejectedValue(new Error('boom'))
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1')
    await vi.advanceTimersByTimeAsync(100)
    // Fired twice (immediate + 1 interval) despite rejections.
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(hb.activeCount).toBe(1)
  })

  it('stopByWorkspace(ws) clears only chats tagged with that workspace', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1', 'ws-a')
    hb.start('c-2', 'ws-a')
    hb.start('c-3', 'ws-b')
    hb.start('c-4') // no workspace tag
    expect(hb.activeCount).toBe(4)
    hb.stopByWorkspace('ws-a')
    expect(hb.activeCount).toBe(2)
    // The untagged one and ws-b survive
    const before = send.mock.calls.length
    vi.advanceTimersByTime(100)
    // Only c-3 + c-4 keep firing
    expect(send.mock.calls.length - before).toBe(2)
  })

  it('stopByWorkspace with no matches is a no-op', () => {
    const send = vi.fn()
    const hb = new TypingHeartbeat(send, { intervalMs: 100, maxMs: 10_000 })
    hb.start('c-1', 'ws-a')
    expect(() => hb.stopByWorkspace('ws-nope')).not.toThrow()
    expect(hb.activeCount).toBe(1)
  })

  it('§55: calls onStuck with the chatId when the safety cap trips', () => {
    const onStuck = vi.fn()
    const hb = new TypingHeartbeat(vi.fn(), { intervalMs: 100, maxMs: 500, onStuck })
    hb.start('c-1')
    expect(onStuck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(onStuck).toHaveBeenCalledTimes(1)
    expect(onStuck).toHaveBeenCalledWith('c-1')
  })

  it('§55: does not call onStuck when stopped before the cap', () => {
    const onStuck = vi.fn()
    const hb = new TypingHeartbeat(vi.fn(), { intervalMs: 100, maxMs: 500, onStuck })
    hb.start('c-1')
    vi.advanceTimersByTime(200)
    hb.stop('c-1')
    vi.advanceTimersByTime(1_000)
    expect(onStuck).not.toHaveBeenCalled()
  })

  it('§55: an onStuck that throws does not break the cap teardown', () => {
    const onStuck = vi.fn(() => {
      throw new Error('boom')
    })
    const hb = new TypingHeartbeat(vi.fn(), { intervalMs: 100, maxMs: 500, onStuck })
    hb.start('c-1')
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    expect(hb.activeCount).toBe(0)
  })
})
