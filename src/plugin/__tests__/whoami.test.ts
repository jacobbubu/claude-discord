import { describe, expect, it } from 'vitest'
import { buildWhoamiResult } from '../whoami.ts'

describe('buildWhoamiResult', () => {
  it('returns ok tool_result with stringified JSON body', () => {
    const r = buildWhoamiResult({
      workspace: 'foo',
      daemon_socket: '/tmp/d.sock',
      agent: 'claude-code',
      plugin_version: '0.0.4',
      connected: true,
    })
    expect(r.type).toBe('tool_result')
    expect(r.id).toBe('whoami')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    const parsed = JSON.parse(r.result!)
    expect(parsed).toEqual({
      workspace: 'foo',
      daemon_socket: '/tmp/d.sock',
      agent: 'claude-code',
      plugin_version: '0.0.4',
      connected: true,
    })
  })

  it('reflects pre-register state (workspace null, connected false)', () => {
    const r = buildWhoamiResult({
      workspace: null,
      daemon_socket: '/tmp/d.sock',
      agent: 'claude-code',
      plugin_version: '?',
      connected: false,
    })
    if (!r.ok) throw new Error('unreachable')
    const parsed = JSON.parse(r.result!)
    expect(parsed.workspace).toBe(null)
    expect(parsed.connected).toBe(false)
    expect(parsed.plugin_version).toBe('?')
  })

  it('reflects auto-suffixed workspace name (architecture #34)', () => {
    const r = buildWhoamiResult({
      workspace: 'free-research-2',
      daemon_socket: '/tmp/d.sock',
      agent: 'claude-code',
      plugin_version: '0.0.4',
      connected: true,
    })
    if (!r.ok) throw new Error('unreachable')
    expect(JSON.parse(r.result!).workspace).toBe('free-research-2')
  })

  it('result is pretty-printed (2-space indent) for human reading', () => {
    const r = buildWhoamiResult({
      workspace: 'foo',
      daemon_socket: '/tmp/d.sock',
      agent: 'claude-code',
      plugin_version: '0.0.4',
      connected: true,
    })
    if (!r.ok) throw new Error('unreachable')
    expect(r.result!).toContain('\n  "workspace"')
  })
})
