/**
 * Integration: drive a fake inbound message all the way through inbound-router
 * → access gate → routing → plugin Connection (NDJSON write) → ring buffer.
 *
 * Plugin side is a real Connection with a fake Socket capturing writes.
 */

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultAccess,
  writeAccessFile,
  type Access,
} from '../../access-control.ts'
import { Connection } from '../../connection.ts'
import { makeInboundHandler } from '../../inbound-router.ts'
import { WorkspaceRegistry } from '../../registry.ts'
import { RingBufferMap } from '../../ring-buffer.ts'
import { RoutingTable } from '../../routing.ts'
import { makeFakeMessage, makeMockGateway } from './_mock-gateway.ts'

class FakeSocket {
  writes: string[] = []
  end() {}
  destroy() {}
  write(data: string) {
    this.writes.push(data)
    return true
  }
}

const seed = (overrides: Partial<Access> = {}): Access => ({
  ...defaultAccess(),
  ...overrides,
})

function buildEnv(stateDir: string, accessOverrides: Partial<Access> = {}) {
  mkdirSync(join(stateDir, 'approved'), { recursive: true, mode: 0o700 })
  mkdirSync(join(stateDir, 'inbox'), { recursive: true, mode: 0o700 })
  const accessFile = join(stateDir, 'access.json')
  writeAccessFile(accessFile, seed(accessOverrides))
  const routing = new RoutingTable(join(stateDir, 'routing.json'))
  const registry = new WorkspaceRegistry()
  const ringBuffers = new RingBufferMap()
  const gateway = makeMockGateway()
  return { gateway, registry, routing, ringBuffers, accessFile }
}

const flush = () => new Promise<void>(r => setImmediate(r))

describe('inbound-router integration', () => {
  it('first DM from unknown sender → pair reply + pending recorded', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'inb-'))
    const env = buildEnv(stateDir)
    const handler = makeInboundHandler(env)

    handler(
      makeFakeMessage({
        channelId: 'cdm1',
        authorId: 'u1',
        content: 'hi',
        isDM: true,
      }) as never,
    )
    await flush()
    await flush()

    expect(env.gateway.sentMessages.length).toBe(1)
    expect(env.gateway.sentMessages[0]!.content).toMatch(/Pairing required/)
    expect(env.gateway.sentMessages[0]!.content).toMatch(/[0-9a-f]{6}/)
    const access = JSON.parse(readFileSync(env.accessFile, 'utf8'))
    expect(Object.keys(access.pending)).toHaveLength(1)
  })

  it('DM from allowFrom sender + active workspace → plugin gets inbound + ring buffer pushed', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'inb-'))
    const env = buildEnv(stateDir, { allowFrom: ['u1'] })
    const handler = makeInboundHandler(env)

    // Register a fake plugin "foo"
    const sock = new FakeSocket()
    const conn = new Connection(sock as never)
    conn.workspace = 'foo'
    conn.state = 'registered'
    env.registry.register('foo', conn)
    // Architecture deltas §13: explicit binding required (no implicit fallback)
    env.routing.set('cdm1', 'foo', Date.now())

    handler(
      makeFakeMessage({ channelId: 'cdm1', authorId: 'u1', content: 'hello world' }) as never,
    )
    await flush()
    await flush()

    expect(env.gateway.sentMessages.length).toBe(0) // no pairing reply
    expect(sock.writes.length).toBe(1)
    const inbound = JSON.parse(sock.writes[0]!.trim())
    expect(inbound.type).toBe('inbound')
    expect(inbound.content).toBe('hello world')
    expect(inbound.user_id).toBe('u1')
    expect(inbound.chat_id).toBe('cdm1')

    const buf = env.ringBuffers.get('foo')
    expect(buf?.size).toBe(1)
    expect(buf?.recent(1)[0]?.direction).toBe('in')
    expect(buf?.recent(1)[0]?.textPreview).toBe('hello world')
  })

  it('DM from allowFrom sender + no active workspace → bot replies with offline notice', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'inb-'))
    const env = buildEnv(stateDir, { allowFrom: ['u1'] })
    const handler = makeInboundHandler(env)

    handler(
      makeFakeMessage({ channelId: 'cdm1', authorId: 'u1', content: 'hi' }) as never,
    )
    await flush()
    await flush()

    expect(env.gateway.sentMessages.length).toBe(1)
    expect(env.gateway.sentMessages[0]!.content).toMatch(/no workspace online/)
  })

  it('disabled policy drops everything (no replies, no plugin push)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'inb-'))
    const env = buildEnv(stateDir, { dmPolicy: 'disabled', allowFrom: ['u1'] })
    const handler = makeInboundHandler(env)

    const sock = new FakeSocket()
    const conn = new Connection(sock as never)
    conn.workspace = 'foo'
    conn.state = 'registered'
    env.registry.register('foo', conn)

    handler(
      makeFakeMessage({ channelId: 'cdm1', authorId: 'u1', content: 'hi' }) as never,
    )
    await flush()
    await flush()

    expect(env.gateway.sentMessages.length).toBe(0)
    expect(sock.writes.length).toBe(0)
  })

  it('guild channel without opt-in drops', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'inb-'))
    const env = buildEnv(stateDir, { allowFrom: ['u1'] })
    const handler = makeInboundHandler(env)

    handler(
      makeFakeMessage({
        channelId: 'cg1',
        authorId: 'u1',
        content: 'hi',
        isDM: false,
        mentionsBot: true,
      }) as never,
    )
    await flush()
    await flush()

    expect(env.gateway.sentMessages.length).toBe(0)
  })

  it('guild channel opted-in + mention required + mentions=true → routes', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'inb-'))
    const env = buildEnv(stateDir, {
      allowFrom: ['u1'],
      groups: { cg1: { requireMention: true, allowFrom: [] } },
    })
    const handler = makeInboundHandler(env)

    const sock = new FakeSocket()
    const conn = new Connection(sock as never)
    conn.workspace = 'foo'
    conn.state = 'registered'
    env.registry.register('foo', conn)
    // Architecture deltas §13: explicit binding required.
    env.routing.set('cg1', 'foo', Date.now())

    handler(
      makeFakeMessage({
        channelId: 'cg1',
        authorId: 'u1',
        content: 'hello',
        isDM: false,
        mentionsBot: true,
      }) as never,
    )
    await flush()
    await flush()

    expect(sock.writes.length).toBe(1)
    const inbound = JSON.parse(sock.writes[0]!.trim())
    expect(inbound.content).toBe('hello')
  })
})
