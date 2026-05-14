import { describe, expect, it, vi } from 'vitest'
import { Connection } from '../connection.ts'
import { WorkspaceRegistry } from '../registry.ts'

class FakeSocket {
  end() {}
  destroy() {}
  write() {
    return true
  }
}

const newConn = (): Connection => new Connection(new FakeSocket() as never)

describe('WorkspaceRegistry', () => {
  it('register / get / has / size', () => {
    const r = new WorkspaceRegistry()
    expect(r.size).toBe(0)
    const c = newConn()
    c.workspace = 'foo'
    r.register('foo', c)
    expect(r.size).toBe(1)
    expect(r.has('foo')).toBe(true)
    expect(r.get('foo')).toBe(c)
  })

  it('re-registering the same name closes the previous connection', () => {
    const r = new WorkspaceRegistry()
    const a = newConn()
    a.workspace = 'foo'
    const b = newConn()
    b.workspace = 'foo'
    r.register('foo', a)
    r.register('foo', b)
    expect(a.state).toBe('closed')
    expect(r.get('foo')).toBe(b)
    expect(r.size).toBe(1)
  })

  it('unregister by name', () => {
    const r = new WorkspaceRegistry()
    const c = newConn()
    c.workspace = 'foo'
    r.register('foo', c)
    r.unregister('foo')
    expect(r.size).toBe(0)
  })

  it('unregisterByConnection only removes if mapping matches', () => {
    const r = new WorkspaceRegistry()
    const a = newConn()
    a.workspace = 'foo'
    const b = newConn()
    b.workspace = 'foo'
    r.register('foo', a)
    r.unregisterByConnection(b) // b is not the registered one
    expect(r.size).toBe(1)
    r.unregisterByConnection(a)
    expect(r.size).toBe(0)
  })

  describe('onChange (§29)', () => {
    it('fires after register, unregister, and unregisterByConnection', () => {
      const r = new WorkspaceRegistry()
      const fn = vi.fn()
      r.onChange(fn)

      const a = newConn(); a.workspace = 'foo'
      r.register('foo', a)
      expect(fn).toHaveBeenCalledTimes(1)

      r.unregister('foo')
      expect(fn).toHaveBeenCalledTimes(2)

      r.register('foo', a)
      const b = newConn(); b.workspace = 'bar'
      r.register('bar', b)
      expect(fn).toHaveBeenCalledTimes(4)

      r.unregisterByConnection(b)
      expect(fn).toHaveBeenCalledTimes(5)
    })

    it('does not fire when re-registering the exact same conn under the same name (reconnect)', () => {
      const r = new WorkspaceRegistry()
      const fn = vi.fn()
      const a = newConn(); a.workspace = 'foo'
      r.register('foo', a)
      fn.mockReset()
      r.onChange(fn)
      r.register('foo', a) // identical re-register
      expect(fn).not.toHaveBeenCalled()
    })

    it('does not fire when unregistering a non-existent name', () => {
      const r = new WorkspaceRegistry()
      const fn = vi.fn()
      r.onChange(fn)
      r.unregister('ghost')
      expect(fn).not.toHaveBeenCalled()
    })

    it('returns an unsubscribe function that stops further callbacks', () => {
      const r = new WorkspaceRegistry()
      const fn = vi.fn()
      const off = r.onChange(fn)
      const a = newConn(); a.workspace = 'foo'
      r.register('foo', a)
      expect(fn).toHaveBeenCalledTimes(1)
      off()
      r.unregister('foo')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('fires once for a batch LRU eviction', () => {
      const r = new WorkspaceRegistry({ cap: 2, trim: 1 })
      const fn = vi.fn()
      const a = newConn(); a.workspace = 'a'; a.lastActivityTs = 1
      const b = newConn(); b.workspace = 'b'; b.lastActivityTs = 2
      r.register('a', a)
      r.register('b', b)
      r.onChange(fn)
      const c = newConn(); c.workspace = 'c'; c.lastActivityTs = 3
      r.register('c', c) // pushes over cap → evicts 'a' down to trim=1 (b and a leave)
      // one notify for the register and one for the eviction batch
      expect(fn).toHaveBeenCalledTimes(2)
    })
  })
})
