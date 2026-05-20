/**
 * Unit tests for slash command handlers.
 *
 * Drives `attachInteractionHandler` directly with hand-rolled mock
 * Interactions instead of going through MockClient — keeps the surface
 * narrow and asserts handler logic without discord.js Client glue.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeAccessFile } from '../access-control.ts'
import { Connection } from '../connection.ts'
import type { DiscordGateway } from '../discord-gateway.ts'
import { WorkspaceRegistry } from '../registry.ts'
import { RingBufferMap } from '../ring-buffer.ts'
import { RoutingTable } from '../routing.ts'
import { attachInteractionHandler, type SlashDeps } from '../slash-commands.ts'
import { initStateDir } from '../../shared/init-state-dir.ts'
import { resolvePaths, type Paths } from '../../shared/paths.ts'

type ReplyArg = { content: string; ephemeral?: boolean } | string
type ReplySpy = ReturnType<typeof vi.fn<(arg: ReplyArg) => Promise<unknown>>>

function makeChatInputInteraction(opts: {
  commandName: string
  userId?: string
  channelId?: string
  string?: Record<string, string>
  integer?: Record<string, number>
}): { interaction: unknown; reply: ReplySpy } {
  const reply: ReplySpy = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    isAutocomplete: () => false,
    isButton: () => false,
    isChatInputCommand: () => true,
    commandName: opts.commandName,
    user: { id: opts.userId ?? 'u-1' },
    channelId: opts.channelId ?? 'c-1',
    options: {
      getString: (name: string, _required?: boolean) => opts.string?.[name] ?? null,
      getInteger: (name: string) => opts.integer?.[name] ?? null,
      getFocused: () => '',
    },
    reply,
  }
  return { interaction, reply }
}

function makeAutocompleteInteraction(opts: {
  commandName: string
  focused?: string
}): { interaction: unknown; respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    isAutocomplete: () => true,
    isButton: () => false,
    isChatInputCommand: () => false,
    commandName: opts.commandName,
    options: { getFocused: () => opts.focused ?? '' },
    respond,
  }
  return { interaction, respond }
}

function makeButtonInteraction(opts: { customId: string; userId?: string; channelId?: string }): {
  interaction: unknown
  update: ReturnType<typeof vi.fn>
  reply: ReplySpy
} {
  const update = vi.fn().mockResolvedValue(undefined)
  const reply: ReplySpy = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    isAutocomplete: () => false,
    isButton: () => true,
    isChatInputCommand: () => false,
    customId: opts.customId,
    user: { id: opts.userId ?? 'u-1' },
    channelId: opts.channelId ?? 'c-1',
    update,
    reply,
  }
  return { interaction, update, reply }
}

const updateContent = (update: ReturnType<typeof vi.fn>): string => {
  const arg = update.mock.calls[0]?.[0] as { content?: string } | undefined
  return arg?.content ?? ''
}

const replyContent = (reply: ReplySpy): string => {
  const arg = reply.mock.calls[0]?.[0] as ReplyArg
  return typeof arg === 'string' ? arg : (arg?.content ?? '')
}

describe('slash-commands', () => {
  let paths: Paths
  let registry: WorkspaceRegistry
  let routing: RoutingTable
  let ringBuffers: RingBufferMap
  let gateway: DiscordGateway
  let deps: SlashDeps
  let dispatch: (i: unknown) => void

  beforeEach(() => {
    const stateDir = mkdtempSync(join(tmpdir(), 'slash-test-'))
    paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    initStateDir(paths)
    writeAccessFile(paths.accessFile, {
      dmPolicy: 'pairing',
      allowFrom: ['u-1'],
      groups: {},
      pending: {},
    })

    registry = new WorkspaceRegistry()
    routing = new RoutingTable(paths.routingFile)
    ringBuffers = new RingBufferMap()

    gateway = {
      client: {
        // pinned-indicator (§53) calls channels.fetch on every bind. Returning
        // null short-circuits the indicator branch quietly — routing + reply
        // logic still runs, which is what the slash-command tests assert.
        // Indicator behavior itself is covered in pinned-indicator.test.ts.
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
        user: { id: 'bot-self' },
      } as never,
      send: vi.fn().mockResolvedValue({ id: 'm-fake' }),
      isRecentSent: () => false,
      getDmRecipient: () => null,
      noteDmRecipient: () => {},
      shutdown: async () => {},
    }

    deps = { gateway, registry, routing, ringBuffers, paths }
    dispatch = attachInteractionHandler(deps) as unknown as (i: unknown) => void
  })

  afterEach(() => {
    routing.stopWatching()
  })

  // Register a mock plugin connection under a workspace name.
  function registerWorkspace(name: string, agent = 'claude-code'): Connection {
    const sock = {
      write: vi.fn(),
      end: vi.fn(),
      destroyed: false,
    } as never
    const conn = new Connection(sock)
    conn.workspace = name
    conn.agent = agent
    conn.state = 'registered'
    registry.register(name, conn)
    return conn
  }

  describe('authorization', () => {
    it('rejects unauthorized users with ephemeral "Not authorized."', async () => {
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'list',
        userId: 'u-stranger',
      })
      dispatch(interaction)
      // attachInteractionHandler is sync wrapper around async handle, await microtask
      await new Promise(r => setImmediate(r))
      expect(reply).toHaveBeenCalledWith({ content: 'Not authorized.', ephemeral: true })
    })
  })

  describe('/list', () => {
    it('reports "no active workspaces" when registry empty', async () => {
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'list' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toContain('no active workspaces')
    })

    it('lists workspaces sorted by last activity, most recent first', async () => {
      const c1 = registerWorkspace('foo')
      const c2 = registerWorkspace('bar')
      // Force bar to be more recent
      c1.lastActivityTs = 1000
      c2.lastActivityTs = 2000

      const { interaction, reply } = makeChatInputInteraction({ commandName: 'list' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const content = replyContent(reply)
      expect(content).toContain('`bar`')
      expect(content).toContain('`foo`')
      expect(content.indexOf('bar')).toBeLessThan(content.indexOf('foo'))
    })
  })

  describe('/use', () => {
    it('rejects switching to offline workspace', async () => {
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'use',
        string: { workspace: 'ghost' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/not online/)
    })

    it('binds channel to workspace and replies "✅ switched"', async () => {
      registerWorkspace('foo')
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'use',
        channelId: 'c-1',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toContain('✅ switched to foo')
      expect(routing.get('c-1')?.workspace).toBe('foo')
    })

    it('triggers the pinned workspace indicator on switch (§53)', async () => {
      registerWorkspace('foo')
      const { interaction } = makeChatInputInteraction({
        commandName: 'use',
        channelId: 'c-1',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      // bind path goes through syncIndicator, which fetches the channel.
      const fetchSpy = (gateway.client as unknown as { channels: { fetch: ReturnType<typeof vi.fn> } }).channels.fetch
      expect(fetchSpy).toHaveBeenCalledWith('c-1')
    })

    it('reply includes target workspace pid + last-active timestamp (#67)', async () => {
      const conn = registerWorkspace('foo')
      conn.pid = 12345
      conn.lastActivityTs = 1700000000_000 // arbitrary fixed ts → unix seconds 1700000000
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'use',
        channelId: 'c-1',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const content = replyContent(reply)
      expect(content).toContain('✅ switched to foo')
      expect(content).toContain('pid 12345')
      expect(content).toContain('<t:1700000000:f>')
    })

    it('omits pid when register didn\'t carry one (forward-compat with older plugins)', async () => {
      const conn = registerWorkspace('foo')
      conn.pid = null
      conn.lastActivityTs = 1700000000_000
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'use',
        channelId: 'c-1',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const content = replyContent(reply)
      expect(content).not.toContain('pid')
      expect(content).toContain('<t:1700000000:f>')
    })
  })

  describe('/use — channel↔workspace 1:1 enforcement (#75)', () => {
    const flush = () => new Promise(r => setImmediate(r))

    it('switching to a workspace already bound elsewhere → shows Move/Cancel buttons, does NOT switch', async () => {
      registerWorkspace('foo')
      routing.set('c-old', 'foo')
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'use',
        channelId: 'c-1',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await flush()
      const arg = reply.mock.calls[0]?.[0] as { content: string; components?: unknown[] }
      expect(arg.content).toContain('already bound to')
      expect(arg.content).toContain('<#c-old>')
      expect(arg.components?.length).toBe(1)
      // not switched
      expect(routing.get('c-1')).toBeNull()
      expect(routing.get('c-old')?.workspace).toBe('foo')
    })

    it('re-/use the same workspace in the same channel just refreshes (no conflict prompt)', async () => {
      registerWorkspace('foo')
      routing.set('c-1', 'foo')
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'use',
        channelId: 'c-1',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await flush()
      const arg = reply.mock.calls[0]?.[0] as ReplyArg
      expect(typeof arg === 'string' ? arg : arg.content).toContain('✅ switched to foo')
      expect(typeof arg === 'object' ? (arg as { components?: unknown[] }).components : undefined).toBeUndefined()
    })

    it('"Move it here" button: clears the old binding and binds this channel', async () => {
      registerWorkspace('foo')
      routing.set('c-old', 'foo')
      const { interaction, update } = makeButtonInteraction({ customId: 'use-move:foo', channelId: 'c-1' })
      dispatch(interaction)
      await flush()
      expect(routing.get('c-old')).toBeNull()
      expect(routing.get('c-1')?.workspace).toBe('foo')
      expect(updateContent(update)).toContain('✅ moved')
      expect(updateContent(update)).toContain('<#c-old>')
    })

    it('"Cancel" button: leaves all bindings unchanged', async () => {
      registerWorkspace('foo')
      routing.set('c-old', 'foo')
      const { interaction, update } = makeButtonInteraction({ customId: 'use-cancel', channelId: 'c-1' })
      dispatch(interaction)
      await flush()
      expect(routing.get('c-old')?.workspace).toBe('foo')
      expect(routing.get('c-1')).toBeNull()
      expect(updateContent(update)).toContain('cancelled')
    })

    it('"Move it here" when the workspace went offline → no-op message, no binding change', async () => {
      routing.set('c-old', 'foo') // 'foo' never registered
      const { interaction, update } = makeButtonInteraction({ customId: 'use-move:foo', channelId: 'c-1' })
      dispatch(interaction)
      await flush()
      expect(updateContent(update)).toMatch(/no longer online/)
      expect(routing.get('c-1')).toBeNull()
      expect(routing.get('c-old')?.workspace).toBe('foo')
    })

    it('unauthorized user clicking a use-move button gets "Not authorized." and nothing changes', async () => {
      registerWorkspace('foo')
      routing.set('c-old', 'foo')
      const { interaction, reply, update } = makeButtonInteraction({
        customId: 'use-move:foo',
        channelId: 'c-1',
        userId: 'intruder',
      })
      dispatch(interaction)
      await flush()
      expect(replyContent(reply)).toBe('Not authorized.')
      expect(update).not.toHaveBeenCalled()
      expect(routing.get('c-1')).toBeNull()
      expect(routing.get('c-old')?.workspace).toBe('foo')
    })
  })

  describe('/which', () => {
    it('reports unbound channel', async () => {
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'which' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/has no workspace bound/)
    })

    it('reports binding + online status', async () => {
      registerWorkspace('foo')
      routing.set('c-1', 'foo', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'which' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/bound to `foo` — online/)
    })

    it('reports binding + offline status when workspace not in registry', async () => {
      routing.set('c-1', 'gone', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'which' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/bound to `gone` — offline/)
    })
  })

  describe('/last', () => {
    it('returns when channel has no previous workspace', async () => {
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'last' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/no previous workspace/)
    })

    it('switches back when previous workspace is online', async () => {
      registerWorkspace('foo')
      registerWorkspace('bar')
      // First /use foo, then /use bar — history[0] becomes foo
      routing.set('c-1', 'foo', 1)
      routing.set('c-1', 'bar', 2)
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'last' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toContain('✅ switched back to foo')
      expect(routing.get('c-1')?.workspace).toBe('foo')
    })

    it('triggers the pinned workspace indicator on /last (§53)', async () => {
      registerWorkspace('foo')
      registerWorkspace('bar')
      routing.set('c-1', 'foo', 1)
      routing.set('c-1', 'bar', 2)
      const fetchSpy = (gateway.client as unknown as { channels: { fetch: ReturnType<typeof vi.fn> } }).channels.fetch
      const callsBefore = fetchSpy.mock.calls.length
      const { interaction } = makeChatInputInteraction({ commandName: 'last' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      // /last re-binds → syncIndicator → channels.fetch fires for c-1.
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore)
      expect(fetchSpy).toHaveBeenLastCalledWith('c-1')
    })

    it('rejects when previous workspace is offline', async () => {
      registerWorkspace('bar')
      routing.set('c-1', 'foo', 1)
      routing.set('c-1', 'bar', 2)
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'last' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/'foo' is offline/)
    })
  })

  describe('/status', () => {
    it('explicit workspace online', async () => {
      registerWorkspace('foo')
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'status',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/`foo` — online/)
    })

    it('explicit workspace offline', async () => {
      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'status',
        string: { workspace: 'ghost' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/`ghost` — offline/)
    })

    it('falls back to current channel binding', async () => {
      registerWorkspace('foo')
      routing.set('c-1', 'foo', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'status' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/`foo` — online/)
    })

    it('reports "no workspace specified" when no binding and no arg', async () => {
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'status' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/no workspace specified/)
    })
  })

  describe('/recent', () => {
    it('rejects unbound channel', async () => {
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'recent' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/has no workspace bound/)
    })

    it('reports "(no recent activity)" when ring buffer empty', async () => {
      registerWorkspace('foo')
      routing.set('c-1', 'foo', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'recent' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/no recent activity/)
    })

    it('renders recent entries with arrows', async () => {
      registerWorkspace('foo')
      routing.set('c-1', 'foo', Date.now())
      const buf = ringBuffers.for('foo')
      buf.push({ channelId: 'c-1', direction: 'in', text: 'hello' })
      buf.push({ channelId: 'c-1', direction: 'out', text: 'world' })

      const { interaction, reply } = makeChatInputInteraction({ commandName: 'recent' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const content = replyContent(reply)
      expect(content).toContain('foo')
      expect(content).toContain('← hello')
      expect(content).toContain('→ world')
    })

    it('clamps n to RECENT_MAX', async () => {
      registerWorkspace('foo')
      routing.set('c-1', 'foo', Date.now())
      const buf = ringBuffers.for('foo')
      for (let i = 0; i < 10; i++) {
        buf.push({ channelId: 'c-1', direction: 'in', text: `m${i}` })
      }

      const { interaction, reply } = makeChatInputInteraction({
        commandName: 'recent',
        integer: { n: 99 },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const content = replyContent(reply)
      // RECENT_MAX = 5
      expect(content.match(/← m/g)?.length).toBeLessThanOrEqual(5)
    })
  })

  describe('/cancel (§36)', () => {
    it('rejects unbound channel', async () => {
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'cancel' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/还没绑定/)
    })

    it('rejects when bound workspace is offline', async () => {
      routing.set('c-1', 'ghost', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'cancel' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/离线/)
    })

    it('rejects when workspace has no active turn (idle)', async () => {
      registerWorkspace('foo')
      routing.set('c-1', 'foo', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'cancel' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/没有进行中的回合/)
    })

    it('sets cancelPending when workspace is mid-turn and acks', async () => {
      const conn = registerWorkspace('foo')
      conn.startTurn('c-1')
      routing.set('c-1', 'foo', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'cancel' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(conn.cancelPending).toBe(true)
      expect(replyContent(reply)).toMatch(/已请求取消/)
    })

    it('idempotent — repeat /cancel says "already cancelling"', async () => {
      const conn = registerWorkspace('foo')
      conn.startTurn('c-1')
      conn.cancelPending = true
      routing.set('c-1', 'foo', Date.now())
      const { interaction, reply } = makeChatInputInteraction({ commandName: 'cancel' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(replyContent(reply)).toMatch(/已在取消中/)
    })
  })

  describe('autocomplete', () => {
    it('responds with empty array for non-completable command', async () => {
      const { interaction, respond } = makeAutocompleteInteraction({ commandName: 'list' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(respond).toHaveBeenCalledWith([])
    })

    it('returns workspace names matching focused prefix', async () => {
      registerWorkspace('foo')
      registerWorkspace('foobar')
      registerWorkspace('baz')

      const { interaction, respond } = makeAutocompleteInteraction({
        commandName: 'use',
        focused: 'foo',
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const calls = respond.mock.calls[0]?.[0] as Array<{ name: string; value: string }>
      const names = calls.map(c => c.name)
      expect(names).toContain('foo')
      expect(names).toContain('foobar')
      expect(names).not.toContain('baz')
    })
  })

  describe('button intercept', () => {
    it('forwards button interactions to buttonIntercept', async () => {
      const intercept = vi.fn().mockResolvedValue(true)
      const localDeps = { ...deps, buttonIntercept: intercept }
      const localDispatch = attachInteractionHandler(localDeps) as unknown as (i: unknown) => void

      const { interaction } = makeButtonInteraction({ customId: 'perm:allow:abcde' })
      localDispatch(interaction)
      await new Promise(r => setImmediate(r))
      expect(intercept).toHaveBeenCalledWith(interaction)
    })
  })
})
