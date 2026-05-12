import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startOrphanWatcher } from '../orphan-watcher.ts'

describe('startOrphanWatcher (deltas §28)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not fire onOrphan while ppid is unchanged', () => {
    const onOrphan = vi.fn()
    startOrphanWatcher({ originalPpid: 42, getPpid: () => 42, onOrphan, intervalMs: 10 })
    vi.advanceTimersByTime(100)
    expect(onOrphan).not.toHaveBeenCalled()
  })

  it('fires onOrphan once the ppid changes (parent died → reparented to init)', () => {
    const onOrphan = vi.fn()
    let ppid = 42
    startOrphanWatcher({ originalPpid: 42, getPpid: () => ppid, onOrphan, intervalMs: 10 })
    vi.advanceTimersByTime(30)
    expect(onOrphan).not.toHaveBeenCalled()
    ppid = 1 // CC died, we got reparented to launchd
    vi.advanceTimersByTime(10)
    expect(onOrphan).toHaveBeenCalledTimes(1)
    // doesn't keep re-firing on subsequent ticks
    vi.advanceTimersByTime(50)
    expect(onOrphan).toHaveBeenCalledTimes(1)
  })

  it('stop() halts the poll — no fire even after ppid changes', () => {
    const onOrphan = vi.fn()
    let ppid = 42
    const w = startOrphanWatcher({ originalPpid: 42, getPpid: () => ppid, onOrphan, intervalMs: 10 })
    w.stop()
    ppid = 1
    vi.advanceTimersByTime(100)
    expect(onOrphan).not.toHaveBeenCalled()
  })

  it('stop() is idempotent', () => {
    const w = startOrphanWatcher({ originalPpid: 42, getPpid: () => 42, intervalMs: 10 })
    expect(() => {
      w.stop()
      w.stop()
    }).not.toThrow()
  })
})
