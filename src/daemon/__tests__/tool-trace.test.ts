import { ChannelType } from 'discord.js'
import { describe, expect, it } from 'vitest'
import type { CcToolTraceMsg } from '../../protocol/schema.ts'
import { PROTOCOL_VERSION } from '../../protocol/version.ts'
import { Connection } from '../connection.ts'
import type { DiscordGateway } from '../discord-gateway.ts'
import { WorkspaceRegistry } from '../registry.ts'
import { buildDiffText } from '../diff-image-renderer.ts'
import { formatBody, ToolTraceRelay, type DiffImageRenderer } from '../tool-trace.ts'

function makeTrace(overrides: Partial<CcToolTraceMsg> = {}): CcToolTraceMsg {
  return {
    type: 'cc_tool_trace',
    v: PROTOCOL_VERSION,
    tool_name: 'Bash',
    tool_input: '{"command":"git log -1"}',
    tool_response: 'commit abc',
    status: 'ok',
    cwd: '/work',
    ...overrides,
  }
}

type ChannelStub = {
  type: ChannelType
  threads?: { create: (o: { name: string; autoArchiveDuration: number }) => Promise<{ id: string }> }
  send?: (o: unknown) => Promise<unknown>
}

function makeGateway() {
  const channels = new Map<string, ChannelStub>()
  const created: Array<{ parentId: string; name: string; autoArchiveDuration: number }> = []
  const sent: Array<{ threadId: string; payload: unknown }> = []

  const addParent = (id: string, type: ChannelType): ChannelStub => {
    const ch: ChannelStub = {
      type,
      threads: {
        create: async opts => {
          const threadId = `thr-${id}-${created.length}`
          created.push({ parentId: id, ...opts })
          channels.set(threadId, {
            type: ChannelType.PublicThread,
            send: async payload => {
              sent.push({ threadId, payload })
              return { id: 'msg-x' }
            },
          })
          return { id: threadId }
        },
      },
    }
    channels.set(id, ch)
    return ch
  }

  const gateway = {
    client: {
      channels: {
        fetch: async (id: string) => channels.get(id) ?? null,
      },
    },
  } as unknown as DiscordGateway

  return { gateway, addParent, created, sent, channels }
}

function makeConn(
  cwd: string,
  chatId: string | null,
  preview = 'hello',
  // §35: explicit "is in turn" knob. Defaults to true whenever a chat id was
  // provided (the common "user just messaged me" case). Set false to test
  // "conn that was once active but turn ended" — daemon should drop trace.
  inTurn: boolean = chatId != null,
): Connection {
  const conn = new Connection({} as never)
  conn.workspace = 'work'
  conn.cwd = cwd
  conn.state = 'registered'
  conn.lastInboundPreview = preview
  if (chatId != null) {
    if (inTurn) {
      conn.startTurn(chatId) // sets lastInboundChatId + lastInboundTs + turnState=active
    } else {
      // Stale: a chat id is remembered but the turn has ended.
      conn.lastInboundChatId = chatId
      conn.lastInboundTs = Date.now() - 60 * 60_000
      // turnState stays 'idle' — that's the §35 signal for "not in a turn"
    }
  }
  return conn
}

describe('ToolTraceRelay.handle', () => {
  it('creates a thread on first trace and reuses it on the second', async () => {
    const reg = new WorkspaceRegistry()
    const conn = makeConn('/work', 'parent-1', 'last commit?')
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('parent-1', ChannelType.GuildText)

    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ tool_name: 'Bash', cwd: '/work' }))
    await relay.handle(makeTrace({ tool_name: 'Read', cwd: '/work' }))

    expect(g.created.length).toBe(1)
    expect(g.created[0]!.name).toBe('trace · last commit?')
    expect(g.created[0]!.autoArchiveDuration).toBe(60)
    expect(g.sent.length).toBe(2)
    // same thread for both
    expect(g.sent[0]!.threadId).toBe(g.sent[1]!.threadId)
    expect(conn.activeTraceThreadId).toBe(g.sent[0]!.threadId)
  })

  it('drops trace silently when parent channel is DM (no thread support)', async () => {
    const reg = new WorkspaceRegistry()
    const conn = makeConn('/work', 'dm-1')
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('dm-1', ChannelType.DM)

    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/work' }))

    expect(g.created.length).toBe(0)
    expect(g.sent.length).toBe(0)
    expect(conn.activeTraceThreadId).toBeNull()
  })

  it('drops when no workspace conn matches cwd', async () => {
    const reg = new WorkspaceRegistry()
    const g = makeGateway()
    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/nope' }))
    expect(g.created.length).toBe(0)
    expect(g.sent.length).toBe(0)
  })

  it('drops when conn has no lastInboundChatId yet (no turn started)', async () => {
    const reg = new WorkspaceRegistry()
    const conn = makeConn('/work', null)
    reg.register('work', conn)
    const g = makeGateway()
    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/work' }))
    expect(g.created.length).toBe(0)
  })

  it('§35: drops trace when the conn is bound but turn has ended (terminal-driven)', async () => {
    const reg = new WorkspaceRegistry()
    // bound to a channel but turnState is idle → not in a Discord turn
    const conn = makeConn('/work', 'parent-stale', 'old turn', /* inTurn */ false)
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('parent-stale', ChannelType.GuildText)
    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/work' }))
    expect(g.created.length).toBe(0)
    expect(g.sent.length).toBe(0)
    expect(conn.activeTraceThreadId).toBeNull()
  })

  it('starts a fresh thread after activeTraceThreadId is reset (new turn)', async () => {
    const reg = new WorkspaceRegistry()
    const conn = makeConn('/work', 'parent-2', 'turn one')
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('parent-2', ChannelType.GuildText)

    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/work' }))
    const firstThread = conn.activeTraceThreadId

    // simulate inbound-router clearing on new inbound
    conn.activeTraceThreadId = null
    conn.lastInboundPreview = 'turn two'
    await relay.handle(makeTrace({ cwd: '/work' }))

    expect(g.created.length).toBe(2)
    expect(g.created[1]!.name).toBe('trace · turn two')
    expect(conn.activeTraceThreadId).not.toBe(firstThread)
  })

  it('clamps thread name to 100 chars (Discord hard limit)', async () => {
    const reg = new WorkspaceRegistry()
    const long = 'x'.repeat(200)
    const conn = makeConn('/work', 'parent-3', long)
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('parent-3', ChannelType.GuildText)
    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/work' }))
    expect(g.created[0]!.name.length).toBeLessThanOrEqual(100)
  })

  it('prefers same-cwd conn with lastInboundChatId over the dead twin (§24 fix)', async () => {
    // Reproduce the production case: two workspaces auto-suffixed in same cwd,
    // only one bound to a Discord channel. Trace must land on the live one.
    const reg = new WorkspaceRegistry()
    const dead = makeConn('/work', null, '')
    dead.workspace = 'free-research'
    reg.register('free-research', dead)
    const live = makeConn('/work', 'parent-live', 'live turn')
    live.workspace = 'free-research-2'
    reg.register('free-research-2', live)

    const g = makeGateway()
    g.addParent('parent-live', ChannelType.GuildText)

    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/work' }))

    expect(g.created.length).toBe(1)
    expect(g.created[0]!.parentId).toBe('parent-live')
    expect(live.activeTraceThreadId).not.toBeNull()
    expect(dead.activeTraceThreadId).toBeNull()
  })

  it('falls back to first match when no same-cwd conn has lastInboundChatId', async () => {
    const reg = new WorkspaceRegistry()
    const a = makeConn('/work', null, '')
    a.workspace = 'ws-a'
    reg.register('ws-a', a)
    const b = makeConn('/work', null, '')
    b.workspace = 'ws-b'
    reg.register('ws-b', b)

    const g = makeGateway()
    const relay = new ToolTraceRelay(g.gateway, reg)
    await relay.handle(makeTrace({ cwd: '/work' }))
    // No conn had a lastInboundChatId — relay falls through and drops cleanly.
    expect(g.created.length).toBe(0)
  })
})

describe('ToolTraceRelay.archiveThread (deltas §37)', () => {
  function makeThreadGateway(stub: {
    fetched?: string | null
    archived?: boolean
    setArchived?: (v: boolean) => Promise<unknown>
    fetchThrows?: boolean
  }) {
    const calls: Array<{ id: string }> = []
    const setArchivedCalls: boolean[] = []
    const gateway = {
      client: {
        channels: {
          fetch: async (id: string) => {
            calls.push({ id })
            if (stub.fetchThrows) throw new Error('boom')
            if (stub.fetched === null) return null
            return {
              archived: stub.archived ?? false,
              setArchived:
                stub.setArchived ??
                (async (v: boolean) => {
                  setArchivedCalls.push(v)
                  return undefined
                }),
            }
          },
        },
      },
    } as unknown as DiscordGateway
    return { gateway, calls, setArchivedCalls }
  }

  it('archives an active trace thread (calls setArchived(true))', async () => {
    const reg = new WorkspaceRegistry()
    const { gateway, calls, setArchivedCalls } = makeThreadGateway({ archived: false })
    const relay = new ToolTraceRelay(gateway, reg)
    await relay.archiveThread('thr-foo')
    expect(calls).toEqual([{ id: 'thr-foo' }])
    expect(setArchivedCalls).toEqual([true])
  })

  it('no-op when the thread is already archived (idempotent)', async () => {
    const reg = new WorkspaceRegistry()
    const { gateway, setArchivedCalls } = makeThreadGateway({ archived: true })
    const relay = new ToolTraceRelay(gateway, reg)
    await relay.archiveThread('thr-foo')
    expect(setArchivedCalls).toEqual([])
  })

  it('swallow when channels.fetch returns null (thread deleted)', async () => {
    const reg = new WorkspaceRegistry()
    const { gateway, setArchivedCalls } = makeThreadGateway({ fetched: null })
    const relay = new ToolTraceRelay(gateway, reg)
    await expect(relay.archiveThread('thr-foo')).resolves.toBeUndefined()
    expect(setArchivedCalls).toEqual([])
  })

  it('swallow when channels.fetch throws', async () => {
    const reg = new WorkspaceRegistry()
    const { gateway } = makeThreadGateway({ fetchThrows: true })
    const relay = new ToolTraceRelay(gateway, reg)
    await expect(relay.archiveThread('thr-foo')).resolves.toBeUndefined()
  })

  it('swallow when setArchived itself throws (Discord permission / closed thread)', async () => {
    const reg = new WorkspaceRegistry()
    const { gateway } = makeThreadGateway({
      setArchived: async () => {
        throw new Error('archive denied')
      },
    })
    const relay = new ToolTraceRelay(gateway, reg)
    await expect(relay.archiveThread('thr-foo')).resolves.toBeUndefined()
  })
})

describe('formatBody', () => {
  it('joins input and output in two fenced blocks', () => {
    const body = formatBody(makeTrace({ tool_input: '{"x":1}', tool_response: 'ok' }))
    expect(body).toContain('**Input**')
    expect(body).toContain('```json\n{"x":1}\n```')
    expect(body).toContain('**Output**')
    expect(body).toContain('```\nok\n```')
  })

  it('truncates joined body when over 4000 chars (Discord embed.description cap)', () => {
    const huge = 'y'.repeat(3000)
    const body = formatBody(makeTrace({ tool_input: huge, tool_response: huge }))
    expect(body.length).toBeLessThanOrEqual(4000)
    expect(body).toContain('(truncated')
  })
})

describe('buildDiffText (deltas §39)', () => {
  it('Edit input → unified diff with - and + prefixed lines', () => {
    const out = buildDiffText(
      'Edit',
      JSON.stringify({
        file_path: '/src/foo.ts',
        old_string: 'const x = 1\nconst y = 2',
        new_string: 'const x = 10\nconst y = 20',
      }),
    )
    expect(out).not.toBeNull()
    expect(out).toContain('--- a/src/foo.ts')
    expect(out).toContain('+++ b/src/foo.ts')
    expect(out).toContain('-const x = 1')
    expect(out).toContain('+const x = 10')
    expect(out).toContain('-const y = 2')
    expect(out).toContain('+const y = 20')
  })

  it('MultiEdit input → accumulates each edit as its own hunk', () => {
    const out = buildDiffText(
      'MultiEdit',
      JSON.stringify({
        file_path: '/src/a.ts',
        edits: [
          { old_string: 'foo', new_string: 'bar' },
          { old_string: 'baz', new_string: 'qux' },
        ],
      }),
    )
    expect(out).not.toBeNull()
    expect(out).toContain('-foo')
    expect(out).toContain('+bar')
    expect(out).toContain('-baz')
    expect(out).toContain('+qux')
  })

  it('Write input → diff from /dev/null with + prefixed lines', () => {
    const out = buildDiffText(
      'Write',
      JSON.stringify({ file_path: '/src/new.ts', content: 'line1\nline2' }),
    )
    expect(out).not.toBeNull()
    expect(out).toContain('--- /dev/null')
    expect(out).toContain('+++ b/src/new.ts')
    expect(out).toContain('+line1')
    expect(out).toContain('+line2')
  })

  it('non-Edit/MultiEdit/Write tool → null', () => {
    expect(buildDiffText('Bash', JSON.stringify({ command: 'ls' }))).toBeNull()
    expect(buildDiffText('Read', JSON.stringify({ file_path: '/x' }))).toBeNull()
    expect(buildDiffText('Grep', JSON.stringify({ pattern: 'foo' }))).toBeNull()
  })

  it('missing file_path → null', () => {
    expect(buildDiffText('Edit', JSON.stringify({ old_string: 'a', new_string: 'b' }))).toBeNull()
  })

  it('Edit missing old_string or new_string → null', () => {
    expect(buildDiffText('Edit', JSON.stringify({ file_path: '/x' }))).toBeNull()
    expect(buildDiffText('Edit', JSON.stringify({ file_path: '/x', old_string: 'a' }))).toBeNull()
  })

  it('MultiEdit with empty edits array → null', () => {
    expect(buildDiffText('MultiEdit', JSON.stringify({ file_path: '/x', edits: [] }))).toBeNull()
  })

  it('malformed JSON input → null', () => {
    expect(buildDiffText('Edit', 'not json at all')).toBeNull()
  })
})

describe('ToolTraceRelay diff image integration (deltas §39)', () => {
  it('Edit trace → calls renderer; attaches PNG + sets embed.image', async () => {
    const reg = new WorkspaceRegistry()
    const conn = makeConn('/work', 'parent-1', 'foo')
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('parent-1', ChannelType.GuildText)

    const fakePath = '/tmp/fake-diff.png'
    const renderer: DiffImageRenderer = async () => fakePath
    const relay = new ToolTraceRelay(g.gateway, reg, renderer)
    await relay.handle(
      makeTrace({
        tool_name: 'Edit',
        tool_input: JSON.stringify({
          file_path: '/x.ts',
          old_string: 'a',
          new_string: 'b',
        }),
      }),
    )

    expect(g.sent.length).toBe(1)
    const payload = g.sent[0]!.payload as { embeds: unknown[]; files?: unknown[] }
    expect(payload.files?.length).toBe(1)
    // embed.image.url should reference the attachment by basename
    const embedJson = (payload.embeds[0] as { toJSON: () => Record<string, unknown> }).toJSON()
    expect(embedJson.image).toBeDefined()
    expect((embedJson.image as { url: string }).url).toContain('attachment://fake-diff.png')
  })

  it('Bash trace → renderer returns null; no files, no image', async () => {
    const reg = new WorkspaceRegistry()
    const conn = makeConn('/work', 'parent-1', 'foo')
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('parent-1', ChannelType.GuildText)

    let renderCalls = 0
    const renderer: DiffImageRenderer = async () => {
      renderCalls++
      return null
    }
    const relay = new ToolTraceRelay(g.gateway, reg, renderer)
    await relay.handle(makeTrace({ tool_name: 'Bash' }))

    expect(g.sent.length).toBe(1)
    const payload = g.sent[0]!.payload as { embeds: unknown[]; files?: unknown[] }
    expect(payload.files).toBeUndefined()
    expect(renderCalls).toBe(1) // renderer is still invoked but returns null for Bash
  })

  it('renderer throws → embed still sent, no files', async () => {
    const reg = new WorkspaceRegistry()
    const conn = makeConn('/work', 'parent-1', 'foo')
    reg.register('work', conn)
    const g = makeGateway()
    g.addParent('parent-1', ChannelType.GuildText)

    const renderer: DiffImageRenderer = async () => {
      throw new Error('silicon exploded')
    }
    const relay = new ToolTraceRelay(g.gateway, reg, renderer)
    await relay.handle(
      makeTrace({
        tool_name: 'Edit',
        tool_input: JSON.stringify({ file_path: '/x', old_string: 'a', new_string: 'b' }),
      }),
    )

    expect(g.sent.length).toBe(1)
    const payload = g.sent[0]!.payload as { embeds: unknown[]; files?: unknown[] }
    expect(payload.files).toBeUndefined()
  })
})
