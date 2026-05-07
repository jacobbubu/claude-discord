/**
 * PermissionRelay text-response path. Button-click path needs heavier
 * Discord interaction mocking — covered manually via the live test.
 */

import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  defaultAccess,
  writeAccessFile,
  type Access,
} from '../access-control.ts'
import { Connection } from '../connection.ts'
import { PERMISSION_TEXT_RE, PermissionRelay, makeRequestId } from '../permission-relay.ts'
import { WorkspaceRegistry } from '../registry.ts'
import type { Paths } from '../../shared/paths.ts'
import { resolvePaths } from '../../shared/paths.ts'
import { makeMockGateway } from './integration/_mock-gateway.ts'

class FakeSocket {
  writes: string[] = []
  end() {}
  destroy() {}
  write(data: string) {
    this.writes.push(data)
    return true
  }
}

function setupRegistryWithWorkspace(name: string): { registry: WorkspaceRegistry; sock: FakeSocket } {
  const sock = new FakeSocket()
  const conn = new Connection(sock as never)
  conn.workspace = name
  conn.state = 'registered'
  const registry = new WorkspaceRegistry()
  registry.register(name, conn)
  return { registry, sock }
}

function setupRelay(extras: Partial<Access> = {}): {
  relay: PermissionRelay
  paths: Paths
  registry: WorkspaceRegistry
  sock: FakeSocket
} {
  const stateDir = mkdtempSync(join(tmpdir(), 'pr-'))
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'approved'), { recursive: true })
  const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
  writeAccessFile(paths.accessFile, { ...defaultAccess(), ...extras })
  const { registry, sock } = setupRegistryWithWorkspace('foo')
  const gateway = makeMockGateway()
  const relay = new PermissionRelay(gateway, registry, paths)
  return { relay, paths, registry, sock }
}

describe('PERMISSION_TEXT_RE', () => {
  it('accepts yes/no + 5-letter [a-km-z]', () => {
    expect(PERMISSION_TEXT_RE.test('yes abcde')).toBe(true)
    expect(PERMISSION_TEXT_RE.test('no abcde')).toBe(true)
    expect(PERMISSION_TEXT_RE.test('y abcde')).toBe(true)
    expect(PERMISSION_TEXT_RE.test('n abcde')).toBe(true)
    expect(PERMISSION_TEXT_RE.test('YES ABCDE')).toBe(true)
  })
  it('rejects bare yes/no without code', () => {
    expect(PERMISSION_TEXT_RE.test('yes')).toBe(false)
    expect(PERMISSION_TEXT_RE.test('y')).toBe(false)
  })
  it('rejects code containing l', () => {
    expect(PERMISSION_TEXT_RE.test('yes abcle')).toBe(false)
  })
  it('rejects wrong-length code', () => {
    expect(PERMISSION_TEXT_RE.test('yes abcd')).toBe(false)
    expect(PERMISSION_TEXT_RE.test('yes abcdef')).toBe(false)
  })
  it('rejects suffix junk', () => {
    expect(PERMISSION_TEXT_RE.test('yes abcde then more')).toBe(false)
  })
})

describe('makeRequestId', () => {
  it('produces a 5-letter code from [a-km-z]', () => {
    for (let i = 0; i < 20; i++) {
      const id = makeRequestId()
      expect(id).toMatch(/^[a-km-z]{5}$/)
    }
  })
})

describe('PermissionRelay.handleTextResponse', () => {
  let relay: PermissionRelay
  let registry: WorkspaceRegistry
  let sock: FakeSocket

  const seedPending = (rid: string) => {
    // Use private internals via cast — slice 6 doesn't expose a public seed
    ;(relay as unknown as {
      pending: Map<string, { workspace: string; tool_name: string; description: string; input_preview: string; messageRefs: unknown[] }>
    }).pending.set(rid, {
      workspace: 'foo',
      tool_name: 'reply',
      description: 'd',
      input_preview: '{}',
      messageRefs: [],
    })
  }

  beforeEach(() => {
    const setup = setupRelay({ allowFrom: ['u1'] })
    relay = setup.relay
    registry = setup.registry
    sock = setup.sock
  })

  it('non-matching text returns false', () => {
    expect(relay.handleTextResponse('u1', 'hello world')).toBe(false)
  })

  it('text matches but no pending entry → false', () => {
    expect(relay.handleTextResponse('u1', 'yes abcde')).toBe(false)
  })

  it('text matches but sender not in allowFrom → false', () => {
    seedPending('abcde')
    expect(relay.handleTextResponse('u-NOT-ALLOWED', 'yes abcde')).toBe(false)
  })

  it('valid yes → dispatches allow to plugin', () => {
    seedPending('abcde')
    const result = relay.handleTextResponse('u1', 'yes abcde')
    expect(result).toBe(true)
    expect(sock.writes.length).toBe(1)
    const sent = JSON.parse(sock.writes[0]!.trim())
    expect(sent.type).toBe('permission')
    expect(sent.behavior).toBe('allow')
    expect(sent.request_id).toBe('abcde')
  })

  it('valid no → dispatches deny to plugin', () => {
    seedPending('abcde')
    const result = relay.handleTextResponse('u1', 'no abcde')
    expect(result).toBe(true)
    const sent = JSON.parse(sock.writes[0]!.trim())
    expect(sent.behavior).toBe('deny')
  })

  it('after dispatch, pending is cleared (subsequent yes/no returns false)', () => {
    seedPending('abcde')
    relay.handleTextResponse('u1', 'yes abcde')
    expect(relay.handleTextResponse('u1', 'no abcde')).toBe(false)
  })

  it('does nothing if workspace plugin disconnected', () => {
    seedPending('abcde')
    registry.unregister('foo') // simulate plugin disconnect
    const result = relay.handleTextResponse('u1', 'yes abcde')
    // Still returns true because the regex/access check passed; the
    // dispatchToPlugin path logs a warn but the relay considers the request
    // handled (pending was deleted via finalize before dispatch ran).
    expect(result).toBe(true)
    // No write happened (no plugin connection)
    expect(sock.writes.length).toBe(0)
  })
})
