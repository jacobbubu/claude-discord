import { describe, expect, it } from 'vitest'
import { LineBuffer, encode } from '../ndjson.ts'
import { PROTOCOL_VERSION } from '../version.ts'

describe('LineBuffer', () => {
  it('emits complete lines from a single chunk', () => {
    const buf = new LineBuffer()
    const lines = buf.push('a\nb\nc\n')
    expect(lines).toEqual(['a', 'b', 'c'])
    expect(buf.pending()).toBe('')
  })

  it('holds incomplete trailing line', () => {
    const buf = new LineBuffer()
    expect(buf.push('a\nb')).toEqual(['a'])
    expect(buf.pending()).toBe('b')
    expect(buf.push('c\n')).toEqual(['bc'])
  })

  it('skips empty lines', () => {
    const buf = new LineBuffer()
    expect(buf.push('a\n\nb\n')).toEqual(['a', 'b'])
  })

  it('handles fragmented multi-line', () => {
    const buf = new LineBuffer()
    expect(buf.push('foo')).toEqual([])
    expect(buf.push('bar\nbaz\n')).toEqual(['foobar', 'baz'])
  })
})

describe('encode', () => {
  it('JSON-stringifies and appends newline', () => {
    const wire = encode({ type: 'heartbeat', v: PROTOCOL_VERSION })
    expect(wire.endsWith('\n')).toBe(true)
    expect(JSON.parse(wire.trim())).toEqual({ type: 'heartbeat', v: PROTOCOL_VERSION })
  })
})
