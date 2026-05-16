/**
 * PermissionRelay text-response path. Button-click path needs heavier
 * Discord interaction mocking — covered manually via the live test.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  defaultAccess,
  writeAccessFile,
  type Access,
} from '../access-control.ts'
import { Connection } from '../connection.ts'
import {
  PERMISSION_TEXT_RE,
  PermissionRelay,
  deriveAllowRule,
  makeRequestId,
  persistAllowRule,
} from '../permission-relay.ts'
import { WorkspaceRegistry } from '../registry.ts'
import type { Paths } from '../../shared/paths.ts'
import { resolvePaths } from '../../shared/paths.ts'
import { makeMockGateway } from './integration/_mock-gateway.ts'

class FakeSocket extends EventEmitter {
  writes: string[] = []
  end() {}
  destroy() {}
  write(data: string) {
    this.writes.push(data)
    return true
  }
  /** Simulate the hook process exiting → its socket closing (deltas §27). */
  simulateClose() {
    this.emit('close')
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
    // Use private internals via cast — public seed isn't exposed.
    ;(relay as unknown as {
      pending: Map<string, {
        target: { kind: 'plugin'; workspace: string }
        source: 'plugin' | 'cc-builtin'
        tool_name: string
        description: string
        input_preview: string
        messageRefs: unknown[]
        expiresAt: number
      }>
    }).pending.set(rid, {
      target: { kind: 'plugin', workspace: 'foo' },
      source: 'plugin',
      tool_name: 'reply',
      description: 'd',
      input_preview: '{}',
      messageRefs: [],
      expiresAt: Date.now() + 60 * 60 * 1000,
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

// ---------------------------------------------------------------------------
// Button + handlePluginRequest paths — heavier mocks for ButtonInteraction
// and gateway.client.users.fetch. Augments the existing makeMockGateway with
// a `users.fetch` shim that captures DM sends.
// ---------------------------------------------------------------------------

type DmSend = { content: string; components: unknown[] }

function setupRelayWithUserFetch(): {
  relay: PermissionRelay
  registry: WorkspaceRegistry
  paths: Paths
  sock: FakeSocket
  dms: DmSend[]
} {
  const stateDir = mkdtempSync(join(tmpdir(), 'pr-btn-'))
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'approved'), { recursive: true })
  const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
  writeAccessFile(paths.accessFile, { ...defaultAccess(), allowFrom: ['u1'] })

  const { registry, sock } = setupRegistryWithWorkspace('foo')

  const dms: DmSend[] = []
  const gateway = makeMockGateway()
  ;(gateway.client as unknown as {
    users: { fetch: (id: string) => Promise<{ id: string; send: (o: DmSend) => Promise<{ id: string }> }> }
  }).users = {
    fetch: async (userId: string) => ({
      id: userId,
      send: async (opts: DmSend) => {
        dms.push(opts)
        return { id: `dm-${dms.length}` }
      },
    }),
  }

  const relay = new PermissionRelay(gateway, registry, paths)
  return { relay, registry, paths, sock, dms }
}

function makeButtonInteraction(opts: {
  customId: string
  userId?: string
  messageContent?: string
}) {
  const reply = vi.fn().mockResolvedValue(undefined)
  const update = vi.fn().mockResolvedValue(undefined)
  return {
    reply,
    update,
    interaction: {
      customId: opts.customId,
      user: { id: opts.userId ?? 'u1' },
      message: { content: opts.messageContent ?? '🔐 Permission: Bash' },
      reply,
      update,
    },
  }
}

describe('PermissionRelay.handlePluginRequest', () => {
  it('immediately denies when allowFrom is empty (no users to ask)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pr-empty-'))
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    mkdirSync(join(stateDir, 'approved'), { recursive: true })
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    writeAccessFile(paths.accessFile, defaultAccess()) // empty allowFrom
    const { registry, sock } = setupRegistryWithWorkspace('foo')
    const relay = new PermissionRelay(makeMockGateway(), registry, paths)

    await relay.handlePluginRequest('foo', {
      type: 'permission_request',
      v: 1,
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
    })

    expect(sock.writes.length).toBe(1)
    const sent = JSON.parse(sock.writes[0]!.trim())
    expect(sent.behavior).toBe('deny')
    expect(sent.request_id).toBe('abcde')
    relay.stop()
  })

  it('sends DM with main prompt + buttons; folds request_id and 2nd line', async () => {
    const { relay, dms } = setupRelayWithUserFetch()
    await relay.handlePluginRequest('foo', {
      type: 'permission_request',
      v: 1,
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'run a quick ls\nin /tmp',
      input_preview: '{"command":"ls /tmp"}',
    })
    expect(dms.length).toBe(1)
    const dm = dms[0]!
    expect(dm.content).toContain('🔐 Permission: Bash')
    expect(dm.content).toContain('run a quick ls')
    expect(dm.content).not.toContain('in /tmp')
    expect(dm.content).not.toContain('abcde')
    expect(dm.components.length).toBe(1)
    relay.stop()
  })

  it('handles empty description', async () => {
    const { relay, dms } = setupRelayWithUserFetch()
    await relay.handlePluginRequest('foo', {
      type: 'permission_request',
      v: 1,
      request_id: 'mnopq',
      tool_name: 'Write',
      description: '',
      input_preview: '{}',
    })
    expect(dms[0]!.content).toBe('🔐 Permission: Write')
    relay.stop()
  })
})

describe('PermissionRelay.handleButton', () => {
  let relay: PermissionRelay
  let sock: FakeSocket

  beforeEach(async () => {
    const setup = setupRelayWithUserFetch()
    relay = setup.relay
    sock = setup.sock
    // Seed a pending request via real plugin-request path.
    await relay.handlePluginRequest('foo', {
      type: 'permission_request',
      v: 1,
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'run ls',
      input_preview: '{"command":"ls"}',
    })
    sock.writes.length = 0 // clear any incidental write (none expected)
  })

  it('returns false when customId does not match perm pattern', async () => {
    const { interaction } = makeButtonInteraction({ customId: 'unrelated:button' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await relay.handleButton(interaction as any)
    expect(result).toBe(false)
    relay.stop()
  })

  it('rejects unauthorized user with ephemeral "Not authorized."', async () => {
    const { interaction, reply } = makeButtonInteraction({
      customId: 'perm:allow:abcde',
      userId: 'u-stranger',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await relay.handleButton(interaction as any)
    expect(result).toBe(true)
    expect(reply).toHaveBeenCalledWith({ content: 'Not authorized.', ephemeral: true })
    relay.stop()
  })

  it('"more" expands content with description, input_preview, fallback hint', async () => {
    const { interaction, update } = makeButtonInteraction({ customId: 'perm:more:abcde' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(interaction as any)
    expect(update).toHaveBeenCalled()
    const arg = update.mock.calls[0]![0] as { content: string; components: unknown[] }
    expect(arg.content).toContain('tool_name: Bash')
    expect(arg.content).toContain('description: run ls')
    expect(arg.content).toContain('"command": "ls"')
    expect(arg.content).toContain('yes abcde')
    expect(arg.content).toContain('no abcde')
    expect(arg.components.length).toBe(1)
    relay.stop()
  })

  it('"more" reports "no longer pending" when entry gone', async () => {
    const { interaction, reply } = makeButtonInteraction({ customId: 'perm:more:zzzzz' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(interaction as any)
    expect(reply).toHaveBeenCalledWith({
      content: 'This permission request is no longer pending.',
      ephemeral: true,
    })
    relay.stop()
  })

  it('"more" handles malformed input_preview JSON by passing raw', async () => {
    // Reseed with bad JSON
    const { relay: relay2, sock: sock2 } = setupRelayWithUserFetch()
    await relay2.handlePluginRequest('foo', {
      type: 'permission_request',
      v: 1,
      request_id: 'wxyzy',
      tool_name: 'X',
      description: 'd',
      input_preview: 'not valid json',
    })
    sock2.writes.length = 0

    const { interaction, update } = makeButtonInteraction({ customId: 'perm:more:wxyzy' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay2.handleButton(interaction as any)
    const arg = update.mock.calls[0]![0] as { content: string }
    expect(arg.content).toContain('not valid json')
    relay2.stop()
  })

  it('"allow" claims pending and dispatches allow', async () => {
    const { interaction, update } = makeButtonInteraction({ customId: 'perm:allow:abcde' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(interaction as any)
    expect(sock.writes.length).toBe(1)
    const sent = JSON.parse(sock.writes[0]!.trim())
    expect(sent.behavior).toBe('allow')
    expect(sent.request_id).toBe('abcde')
    const upArg = update.mock.calls[0]![0] as { content: string; components: unknown[] }
    expect(upArg.content).toContain('✅ Allowed')
    expect(upArg.components.length).toBe(0)
    relay.stop()
  })

  it('"deny" claims pending and dispatches deny', async () => {
    const { interaction, update } = makeButtonInteraction({ customId: 'perm:deny:abcde' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(interaction as any)
    const sent = JSON.parse(sock.writes[0]!.trim())
    expect(sent.behavior).toBe('deny')
    const upArg = update.mock.calls[0]![0] as { content: string }
    expect(upArg.content).toContain('❌ Denied')
    relay.stop()
  })

  it('second click on already-claimed request shows "already answered"', async () => {
    const first = makeButtonInteraction({ customId: 'perm:allow:abcde' })
    const second = makeButtonInteraction({ customId: 'perm:deny:abcde' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(first.interaction as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(second.interaction as any)
    expect(sock.writes.length).toBe(1) // only first dispatch
    expect(second.reply).toHaveBeenCalledWith({
      content: 'This permission request was already answered (or expired).',
      ephemeral: true,
    })
    relay.stop()
  })
})

// ---------------------------------------------------------------------------
// handleCcRequest path (architecture deltas §15) — anonymous one-shot hook
// conn, dispatch back goes to the conn directly (not via registry).
// ---------------------------------------------------------------------------

describe('PermissionRelay.handleCcRequest', () => {
  it('sends DM with "🔐 CC tool" prefix (different from plugin path)', async () => {
    const { relay, dms } = setupRelayWithUserFetch()
    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'run ls',
      input_preview: '{"command":"ls"}',
    })
    expect(dms.length).toBe(1)
    expect(dms[0]!.content).toContain('🔐 CC tool: Bash')
    expect(dms[0]!.content).not.toContain('🔐 Permission:')
    relay.stop()
  })

  it('button allow dispatches `permission` reply directly to hook conn', async () => {
    const { relay } = setupRelayWithUserFetch()
    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'mnopq',
      tool_name: 'Read',
      description: '/tmp/x',
      input_preview: '{}',
    })
    hookSock.writes.length = 0

    const { interaction } = makeButtonInteraction({ customId: 'perm:allow:mnopq' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(interaction as any)

    expect(hookSock.writes.length).toBe(1)
    const sent = JSON.parse(hookSock.writes[0]!.trim())
    expect(sent.type).toBe('permission')
    expect(sent.behavior).toBe('allow')
    expect(sent.request_id).toBe('mnopq')
    relay.stop()
  })

  it('"yes <code>" text response also dispatches to hook conn', async () => {
    const { relay } = setupRelayWithUserFetch()
    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'wxyzy',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
    })
    hookSock.writes.length = 0

    const result = relay.handleTextResponse('u1', 'yes wxyzy')
    expect(result).toBe(true)
    expect(hookSock.writes.length).toBe(1)
    const sent = JSON.parse(hookSock.writes[0]!.trim())
    expect(sent.behavior).toBe('allow')
    relay.stop()
  })

  it('empty allowFrom → immediate deny on hook conn', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pr-cc-'))
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    mkdirSync(join(stateDir, 'approved'), { recursive: true })
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    writeAccessFile(paths.accessFile, defaultAccess()) // empty allowFrom
    const registry = new WorkspaceRegistry()
    const relay = new PermissionRelay(makeMockGateway(), registry, paths)

    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'zzzzz',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
    })

    expect(hookSock.writes.length).toBe(1)
    const sent = JSON.parse(hookSock.writes[0]!.trim())
    expect(sent.behavior).toBe('deny')
    expect(sent.request_id).toBe('zzzzz')
    relay.stop()
  })
})

// ---------------------------------------------------------------------------
// §16: source-bound routing — when hook supplies cwd and a registered
// workspace has matching cwd + lastInboundChatId, the button DM goes to
// that chat (not fan-out DM).
// ---------------------------------------------------------------------------

function setupRelayWithChannelFetch(): {
  relay: PermissionRelay
  registry: WorkspaceRegistry
  channelSends: Array<{ chatId: string; content: string; components: unknown[] }>
  dms: DmSend[]
} {
  const stateDir = mkdtempSync(join(tmpdir(), 'pr-deltas16-'))
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'approved'), { recursive: true })
  const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
  writeAccessFile(paths.accessFile, { ...defaultAccess(), allowFrom: ['u1'] })

  const registry = new WorkspaceRegistry()
  const channelSends: Array<{ chatId: string; content: string; components: unknown[] }> = []
  const dms: DmSend[] = []
  const gateway = makeMockGateway()

  ;(gateway.client as unknown as {
    channels: { fetch: (id: string) => Promise<unknown> }
  }).channels = {
    fetch: async (chatId: string) => ({
      send: async (opts: { content: string; components: unknown[] }) => {
        channelSends.push({ chatId, content: opts.content, components: opts.components })
        return { id: `m-${channelSends.length}` }
      },
    }),
  }
  ;(gateway.client as unknown as {
    users: { fetch: (id: string) => Promise<unknown> }
  }).users = {
    fetch: async (userId: string) => ({
      id: userId,
      send: async (opts: DmSend) => {
        dms.push(opts)
        return { id: `dm-${dms.length}` }
      },
    }),
  }

  const relay = new PermissionRelay(gateway, registry, paths)
  return { relay, registry, channelSends, dms }
}

describe('PermissionRelay.handleCcRequest §16 source-bound routing', () => {
  it('routes button to lastInboundChatId when cwd matches', async () => {
    const { relay, registry, channelSends, dms } = setupRelayWithChannelFetch()
    const sock = new FakeSocket()
    const conn = new Connection(sock as never)
    conn.workspace = 'free-research'
    conn.cwd = '/Users/x/free-research'
    conn.startTurn('cg-foo') // §35: active turn — daemon routes to Discord
    conn.state = 'registered'
    registry.register('free-research', conn)

    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'run ls',
      input_preview: '{"command":"ls"}',
      cwd: '/Users/x/free-research',
    })

    expect(channelSends.length).toBe(1)
    expect(channelSends[0]!.chatId).toBe('cg-foo')
    expect(channelSends[0]!.content).toContain('🔐 CC tool: Bash')
    expect(dms.length).toBe(0)
    relay.stop()
  })

  it('falls back to fan-out DM when cwd does not match any conn', async () => {
    const { relay, channelSends, dms } = setupRelayWithChannelFetch()

    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'mnopq',
      tool_name: 'Read',
      description: '/tmp/x',
      input_preview: '{}',
      cwd: '/no/such/cwd',
    })

    expect(channelSends.length).toBe(0)
    expect(dms.length).toBe(1)
    relay.stop()
  })

  it('§27: defers to CC TUI when the matched workspace is stale (never got an inbound)', async () => {
    const { relay, registry, channelSends, dms } = setupRelayWithChannelFetch()
    const sock = new FakeSocket()
    const conn = new Connection(sock as never)
    conn.workspace = 'free-research'
    conn.cwd = '/Users/x/free-research'
    // no lastInboundChatId / lastInboundTs → not Discord-active
    conn.state = 'registered'
    registry.register('free-research', conn)

    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'wxyzy',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
      cwd: '/Users/x/free-research',
    })

    // No Discord prompt at all — instead a defer reply straight to the hook conn.
    expect(channelSends.length).toBe(0)
    expect(dms.length).toBe(0)
    expect(hookSock.writes.length).toBe(1)
    const sent = JSON.parse(hookSock.writes[0]!.trim())
    expect(sent.type).toBe('cc_permission_defer')
    expect(sent.request_id).toBe('wxyzy')
    relay.stop()
  })

  it('§27: routes to Discord when the matched workspace is fresh (recent inbound)', async () => {
    const { relay, registry, channelSends, dms } = setupRelayWithChannelFetch()
    const sock = new FakeSocket()
    const conn = new Connection(sock as never)
    conn.workspace = 'free-research'
    conn.cwd = '/Users/x/free-research'
    conn.startTurn('cg-fresh') // §35: active turn
    conn.state = 'registered'
    registry.register('free-research', conn)

    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'qrstu',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
      cwd: '/Users/x/free-research',
    })

    expect(channelSends.length).toBe(1)
    expect(channelSends[0]!.chatId).toBe('cg-fresh')
    expect(hookSock.writes.length).toBe(0) // no defer
    relay.stop()
  })

  it('§27: stale wsConn → does NOT create a pending (a later button click finds nothing)', async () => {
    const { relay, registry } = setupRelayWithChannelFetch()
    const sock = new FakeSocket()
    const conn = new Connection(sock as never)
    conn.workspace = 'free-research'
    conn.cwd = '/Users/x/free-research'
    conn.state = 'registered'
    registry.register('free-research', conn)

    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'vwxyz',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
      cwd: '/Users/x/free-research',
    })

    const { interaction } = makeButtonInteraction({ customId: 'perm:allow:vwxyz' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(interaction as any)
    // No pending was created → the button reply says "no longer pending"; no
    // permission message dispatched to the hook conn beyond the earlier defer.
    expect(hookSock.writes.length).toBe(1) // just the defer
    relay.stop()
  })

  it('§27: hook conn close before answer → pending dropped (handleHookGiveup)', async () => {
    const { relay } = setupRelayWithUserFetch()
    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    // no workspace conn matched → fresh-check skipped → real pending created
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'klmno',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
    })
    hookSock.writes.length = 0

    // hook process exits before anyone answers → socket closes
    hookSock.simulateClose()
    await new Promise(r => setImmediate(r))

    // A late button click now finds no pending — it was cleaned up.
    const { interaction } = makeButtonInteraction({ customId: 'perm:allow:klmno' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await relay.handleButton(interaction as any)
    expect(hookSock.writes.length).toBe(0) // nothing dispatched — pending was gone
    relay.stop()
  })

  it('falls back to fan-out DM when cwd is missing from msg', async () => {
    const { relay, channelSends, dms } = setupRelayWithChannelFetch()

    const hookSock = new FakeSocket()
    const hookConn = new Connection(hookSock as never)
    await relay.handleCcRequest(hookConn, {
      type: 'cc_permission_request',
      v: 1,
      request_id: 'qrstu',
      tool_name: 'Bash',
      description: 'd',
      input_preview: '{}',
    })

    expect(channelSends.length).toBe(0)
    expect(dms.length).toBe(1)
    relay.stop()
  })
})

// ---------------------------------------------------------------------------
// §20: "Allow always" — persist tool to settings.json + dispatch allow
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs'

describe('persistAllowRule (§20)', () => {
  it('writes a new permissions.allow array to empty settings.json', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pr-allow-')), 'settings.json')
    writeFileSync(path, JSON.stringify({ otherKey: 'preserve me' }))
    const ok = persistAllowRule('Bash', path)
    expect(ok).toBe(true)
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.permissions.allow).toEqual(['Bash'])
    expect(after.otherKey).toBe('preserve me') // doesn't clobber other fields
  })

  it('appends to existing permissions.allow', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pr-allow-')), 'settings.json')
    writeFileSync(
      path,
      JSON.stringify({ permissions: { allow: ['Read', 'Glob'] } }),
    )
    persistAllowRule('Bash', path)
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.permissions.allow).toEqual(['Read', 'Glob', 'Bash'])
  })

  it('idempotent — re-add same tool does not duplicate', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pr-allow-')), 'settings.json')
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash'] } }))
    persistAllowRule('Bash', path)
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.permissions.allow).toEqual(['Bash'])
  })

  it('creates settings.json when file does not exist', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pr-allow-')), 'settings.json')
    const ok = persistAllowRule('Bash', path)
    expect(ok).toBe(true)
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.permissions.allow).toEqual(['Bash'])
  })

  it('returns false on parse error (corrupted settings.json)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pr-allow-')), 'settings.json')
    writeFileSync(path, 'not valid json {{{')
    const ok = persistAllowRule('Bash', path)
    expect(ok).toBe(false)
  })
})

describe('deriveAllowRule (§34 / §20.1)', () => {
  it('Bash + simple command → Tool(prefix:*)', () => {
    expect(deriveAllowRule('Bash', JSON.stringify({ command: 'git status -s' }))).toBe('Bash(git:*)')
    expect(deriveAllowRule('Bash', JSON.stringify({ command: 'npm test' }))).toBe('Bash(npm:*)')
  })

  it('Bash extracts only the first whitespace-delimited word', () => {
    expect(deriveAllowRule('Bash', JSON.stringify({ command: '  git   log  ' }))).toBe('Bash(git:*)')
    expect(deriveAllowRule('Bash', JSON.stringify({ command: 'git status && rm x' }))).toBe('Bash(git:*)')
  })

  it('Bash with empty / missing command → bare tool name', () => {
    expect(deriveAllowRule('Bash', JSON.stringify({ command: '' }))).toBe('Bash')
    expect(deriveAllowRule('Bash', JSON.stringify({ command: '   ' }))).toBe('Bash')
    expect(deriveAllowRule('Bash', JSON.stringify({}))).toBe('Bash')
  })

  it('Edit / Write / MultiEdit use the file_path as exact pattern', () => {
    expect(deriveAllowRule('Edit', JSON.stringify({ file_path: '/abs/a.ts' }))).toBe('Edit(/abs/a.ts)')
    expect(deriveAllowRule('Write', JSON.stringify({ file_path: '/abs/b.md' }))).toBe('Write(/abs/b.md)')
    expect(deriveAllowRule('MultiEdit', JSON.stringify({ file_path: '/abs/c.ts' }))).toBe('MultiEdit(/abs/c.ts)')
  })

  it('NotebookEdit uses notebook_path', () => {
    expect(deriveAllowRule('NotebookEdit', JSON.stringify({ notebook_path: '/a/b.ipynb' }))).toBe(
      'NotebookEdit(/a/b.ipynb)',
    )
  })

  it('file-path tools fall back to bare name when path is missing', () => {
    expect(deriveAllowRule('Edit', JSON.stringify({}))).toBe('Edit')
    expect(deriveAllowRule('NotebookEdit', JSON.stringify({ notebook_path: '' }))).toBe('NotebookEdit')
  })

  it('unknown tools always fall back to bare name', () => {
    expect(deriveAllowRule('SomeOther', JSON.stringify({ whatever: 'x' }))).toBe('SomeOther')
  })

  it('non-JSON / non-object input_preview falls back to bare name', () => {
    expect(deriveAllowRule('Bash', 'not json {{{')).toBe('Bash')
    expect(deriveAllowRule('Bash', 'null')).toBe('Bash')
    expect(deriveAllowRule('Bash', '"a string"')).toBe('Bash')
  })

  it('handleButton "Allow always" persists the derived pattern, not the bare name', async () => {
    const { relay, paths } = setupRelay({ allowFrom: ['u-1'] })
    // Pre-create an interaction-like object with the "always" customId
    const interactionMessage = { content: 'prompt' }
    let updatedWith: string | null = null
    const interaction = {
      customId: 'perm:always:abcde',
      user: { id: 'u-1' },
      message: interactionMessage,
      reply: vi.fn(),
      update: vi.fn().mockImplementation((opts: { content: string }) => {
        updatedWith = opts.content
        return Promise.resolve()
      }),
    }
    // Seed a pending entry directly via private map for focused testing.
    ;(relay as unknown as { pending: Map<string, unknown> }).pending.set('abcde', {
      target: { kind: 'plugin', workspace: 'foo' },
      source: 'cc-builtin',
      tool_name: 'Bash',
      description: 'run git status',
      input_preview: JSON.stringify({ command: 'git status -s' }),
      messageRefs: [],
      expiresAt: Date.now() + 60_000,
    })
    // Use a temp settings.json so the assertion is hermetic.
    const settingsPath = join(mkdtempSync(join(tmpdir(), 'pr-rule-')), 'settings.json')
    // Patch HOME so persistAllowRule's default falls back to the temp dir's parent.
    const savedHome = process.env.HOME
    try {
      // Force persistAllowRule to write somewhere safe by pre-populating the
      // target dir and pointing HOME there + creating .claude/settings.json.
      const homeDir = mkdtempSync(join(tmpdir(), 'pr-home-'))
      mkdirSync(join(homeDir, '.claude'), { recursive: true })
      process.env.HOME = homeDir
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await relay.handleButton(interaction as any)
      const written = JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8'))
      expect(written.permissions.allow).toEqual(['Bash(git:*)'])
      expect(updatedWith).toContain('Bash(git:*)')
    } finally {
      process.env.HOME = savedHome
    }
    // Silence the unused-var warning from settingsPath above (kept for clarity).
    void settingsPath
    relay.stop()
  })
})
