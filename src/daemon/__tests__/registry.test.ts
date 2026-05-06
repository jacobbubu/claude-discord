import { describe, expect, it } from 'vitest'
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
})
