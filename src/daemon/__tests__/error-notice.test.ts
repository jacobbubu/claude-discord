/**
 * Unit tests for §55 (issue #136) ErrorNotifier — pure format + per-channel
 * throttle behavior. Injects a vi.fn() send callback so no DiscordGateway
 * mock is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorNotifier } from '../error-notice.ts'

describe('ErrorNotifier (§55)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('posts a formatted ⚠️ notice for a stuck channel', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send)
    await n.notify('c-1', 'stuck')
    expect(send).toHaveBeenCalledTimes(1)
    const [channelId, content] = send.mock.calls[0]!
    expect(channelId).toBe('c-1')
    expect(content).toContain('⚠️')
    expect(content).toContain('卡住')
  })

  it('appends the detail for file/send kinds', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send)
    await n.notify('c-1', 'file', 'file too large: /x (30MB)')
    expect(send.mock.calls[0]![1]).toContain('file too large: /x (30MB)')
  })

  it('does not append a detail to a stuck notice', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send)
    await n.notify('c-1', 'stuck', 'ignored detail')
    expect(send.mock.calls[0]![1]).not.toContain('ignored detail')
  })

  it('truncates an over-long detail', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send)
    await n.notify('c-1', 'send', 'x'.repeat(1000))
    const content = send.mock.calls[0]![1] as string
    expect(content.length).toBeLessThan(400)
    expect(content).toContain('…')
  })

  it('throttles a second notice to the same channel within the window', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send, { throttleMs: 60_000 })
    await n.notify('c-1', 'send', 'first')
    await n.notify('c-1', 'send', 'second')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('allows a notice again after the throttle window elapses', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send, { throttleMs: 60_000 })
    await n.notify('c-1', 'send', 'first')
    vi.advanceTimersByTime(60_001)
    await n.notify('c-1', 'send', 'second')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('throttles per channel — a different channel is not blocked', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send, { throttleMs: 60_000 })
    await n.notify('c-1', 'send', 'a')
    await n.notify('c-2', 'send', 'b')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('never throws when the send callback rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('boom'))
    const n = new ErrorNotifier(send)
    await expect(n.notify('c-1', 'stuck')).resolves.toBeUndefined()
  })

  it('formats an api-error notice with the detail appended (§55b)', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' })
    const n = new ErrorNotifier(send)
    await n.notify('c-1', 'api', 'API Error: … · Rate limited')
    const content = send.mock.calls[0]![1] as string
    expect(content).toContain('⚠️')
    expect(content).toContain('API 错误')
    expect(content).toContain('Rate limited')
  })
})
