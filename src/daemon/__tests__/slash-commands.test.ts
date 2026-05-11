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

function makeButtonInteraction(opts: { customId: string; userId?: string }): {
  interaction: unknown
} {
  const interaction = {
    isAutocomplete: () => false,
    isButton: () => true,
    isChatInputCommand: () => false,
    customId: opts.customId,
    user: { id: opts.userId ?? 'u-1' },
  }
  return { interaction }
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
        channels: {
          fetch: vi.fn().mockResolvedValue(null), // applyTopic falls through quietly
        },
        user: {
          setPresence: vi.fn(),
        },
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

    it('updates bot custom status (presence) on switch (deltas §12)', async () => {
      registerWorkspace('foo')
      const { interaction } = makeChatInputInteraction({
        commandName: 'use',
        channelId: 'c-1',
        string: { workspace: 'foo' },
      })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const setPresence = (gateway.client as unknown as { user: { setPresence: ReturnType<typeof vi.fn> } }).user.setPresence
      expect(setPresence).toHaveBeenCalled()
      const arg = setPresence.mock.calls[0]![0] as { activities: Array<{ name: string }>; status: string }
      expect(arg.activities[0]!.name).toBe('foo')
      expect(arg.status).toBe('online')
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

    it('updates bot custom status on /last (deltas §12)', async () => {
      registerWorkspace('foo')
      registerWorkspace('bar')
      routing.set('c-1', 'foo', 1)
      routing.set('c-1', 'bar', 2)
      const { interaction } = makeChatInputInteraction({ commandName: 'last' })
      dispatch(interaction)
      await new Promise(r => setImmediate(r))
      const setPresence = (gateway.client as unknown as { user: { setPresence: ReturnType<typeof vi.fn> } }).user.setPresence
      const arg = setPresence.mock.calls[0]![0] as { activities: Array<{ name: string }> }
      expect(arg.activities[0]!.name).toBe('foo')
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
