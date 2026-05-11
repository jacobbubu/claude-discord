/**
 * Tests for slash command *registration* (the global-only strategy, #71).
 * Drives registerSlashCommands with a fake Client + fake REST and asserts
 * exactly one global PUT (with the command list) plus one empty PUT per guild
 * (to purge stale per-guild commands left by older daemon versions).
 */

import { Routes } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import { buildCommandList, registerSlashCommands } from '../slash-commands.ts'

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
})
