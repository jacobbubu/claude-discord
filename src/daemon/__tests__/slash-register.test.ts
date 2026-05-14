/**
 * Tests for slash command *registration* (the global-only strategy, #71).
 * Drives registerSlashCommands with a fake Client + fake REST and asserts
 * exactly one global PUT (with the command list) plus one empty PUT per guild
 * (to purge stale per-guild commands left by older daemon versions).
 */

import { Routes } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import {
  buildCommandList,
  listWorkspacesByActivity,
  registerSlashCommands,
  workspaceListChanged,
} from '../slash-commands.ts'

type PutCall = { route: string; body: unknown }

function makeFakeRest() {
  const calls: PutCall[] = []
  const rest = {
    put: vi.fn(async (route: string, options: { body: unknown }) => {
      calls.push({ route, body: options.body })
      return undefined
    }),
  }
  return { rest: rest as unknown as Pick<import('discord.js').REST, 'put'>, calls }
}

function makeFakeClient(appId: string | undefined, guildIds: string[]) {
  return {
    application: appId ? { id: appId } : null,
    guilds: { cache: new Map(guildIds.map(g => [g, {}])) },
  } as unknown as import('discord.js').Client
}

describe('registerSlashCommands (#71: global-only)', () => {
  it('registers commands globally exactly once', async () => {
    const { rest, calls } = makeFakeRest()
    await registerSlashCommands(makeFakeClient('app1', []), 'tok', rest)
    const globalRoute = Routes.applicationCommands('app1')
    const globalCalls = calls.filter(c => c.route === globalRoute)
    expect(globalCalls).toHaveLength(1)
    expect(Array.isArray(globalCalls[0]!.body)).toBe(true)
    expect((globalCalls[0]!.body as unknown[]).length).toBe(buildCommandList().length)
  })

  it('clears per-guild commands (empty body) for every guild — no per-guild registration', async () => {
    const { rest, calls } = makeFakeRest()
    await registerSlashCommands(makeFakeClient('app1', ['g1', 'g2']), 'tok', rest)
    for (const g of ['g1', 'g2']) {
      const route = Routes.applicationGuildCommands('app1', g)
      const guildCalls = calls.filter(c => c.route === route)
      expect(guildCalls).toHaveLength(1)
      expect(guildCalls[0]!.body).toEqual([])
    }
    // total: 1 global + 1 per guild
    expect(calls).toHaveLength(3)
  })

  it('does nothing when client.application.id is unavailable', async () => {
    const { rest, calls } = makeFakeRest()
    await registerSlashCommands(makeFakeClient(undefined, ['g1']), 'tok', rest)
    expect(calls).toHaveLength(0)
  })

  it('a failing global PUT does not block per-guild cleanup', async () => {
    const calls: PutCall[] = []
    const rest = {
      put: vi.fn(async (route: string, options: { body: unknown }) => {
        if (route === Routes.applicationCommands('app1')) throw new Error('rate limited')
        calls.push({ route, body: options.body })
        return undefined
      }),
    } as unknown as Pick<import('discord.js').REST, 'put'>
    await registerSlashCommands(makeFakeClient('app1', ['g1']), 'tok', rest)
    expect(calls).toEqual([{ route: Routes.applicationGuildCommands('app1', 'g1'), body: [] }])
  })

  it('§29: passes the current workspace list into buildCommandList via getWorkspaces', async () => {
    const { rest, calls } = makeFakeRest()
    await registerSlashCommands(makeFakeClient('app1', []), 'tok', rest, () => ['foo', 'bar'])
    const globalBody = calls.find(c => c.route === Routes.applicationCommands('app1'))?.body as
      | Array<{ name: string; options?: Array<{ name: string; choices?: Array<{ value: string }> }> }>
      | undefined
    const use = globalBody?.find(c => c.name === 'use')
    const wsOpt = use?.options?.find(o => o.name === 'workspace')
    expect(wsOpt?.choices?.map(c => c.value).sort()).toEqual(['bar', 'foo'])
  })
})

describe('buildCommandList — static choices (§29)', () => {
  type CmdBody = { name: string; options?: Array<{ name: string; choices?: Array<{ name: string; value: string }> }> }
  const useOption = (cmds: unknown[]) => {
    const list = cmds as CmdBody[]
    const use = list.find(c => c.name === 'use')!
    return use.options!.find(o => o.name === 'workspace')!
  }
  const statusOption = (cmds: unknown[]) => {
    const list = cmds as CmdBody[]
    const status = list.find(c => c.name === 'status')!
    return status.options!.find(o => o.name === 'workspace')!
  }

  it('no workspaces → option has no choices (plain string fallback)', () => {
    const cmds = buildCommandList([])
    expect(useOption(cmds).choices).toBeUndefined()
    expect(statusOption(cmds).choices).toBeUndefined()
  })

  it('with workspaces → option carries name=value pairs', () => {
    const cmds = buildCommandList(['alpha', 'beta'])
    expect(useOption(cmds).choices).toEqual([
      { name: 'alpha', value: 'alpha' },
      { name: 'beta', value: 'beta' },
    ])
    expect(statusOption(cmds).choices).toEqual([
      { name: 'alpha', value: 'alpha' },
      { name: 'beta', value: 'beta' },
    ])
  })

  it('clamps to 25 (Discord choices cap)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `ws-${i}`)
    expect(useOption(buildCommandList(many)).choices?.length).toBe(25)
  })
})

describe('listWorkspacesByActivity (§29)', () => {
  it('returns empty for empty input', () => {
    expect(listWorkspacesByActivity([])).toEqual([])
  })

  it('orders most-recently-active first (descending lastActivityTs)', () => {
    expect(
      listWorkspacesByActivity([
        { workspace: 'old', lastActivityTs: 100 },
        { workspace: 'fresh', lastActivityTs: 300 },
        { workspace: 'mid', lastActivityTs: 200 },
      ]),
    ).toEqual(['fresh', 'mid', 'old'])
  })

  it('skips entries whose workspace name is null', () => {
    expect(
      listWorkspacesByActivity([
        { workspace: null, lastActivityTs: 999 },
        { workspace: 'foo', lastActivityTs: 1 },
      ]),
    ).toEqual(['foo'])
  })

  it('does not mutate the input array', () => {
    const input = [
      { workspace: 'a', lastActivityTs: 1 },
      { workspace: 'b', lastActivityTs: 2 },
    ]
    const snapshot = input.map(c => c.workspace)
    listWorkspacesByActivity(input)
    expect(input.map(c => c.workspace)).toEqual(snapshot)
  })
})

describe('workspaceListChanged (§29)', () => {
  it('returns false for identical lists', () => {
    expect(workspaceListChanged(['a', 'b'], ['a', 'b'])).toBe(false)
  })

  it('returns false when order differs but membership is the same', () => {
    expect(workspaceListChanged(['a', 'b'], ['b', 'a'])).toBe(false)
  })

  it('returns true when membership differs', () => {
    expect(workspaceListChanged(['a'], ['a', 'b'])).toBe(true)
    expect(workspaceListChanged(['a', 'b'], ['a', 'c'])).toBe(true)
  })

  it('returns false for two empty lists; true for empty vs non-empty', () => {
    expect(workspaceListChanged([], [])).toBe(false)
    expect(workspaceListChanged([], ['a'])).toBe(true)
  })
})
