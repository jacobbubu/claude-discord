/**
 * Unit tests for §57 (issue #148) AskQuestionRelay — send + pending-map +
 * button resolve + validation + shutdown semantics. Mocks DiscordGateway
 * (just `client.channels.fetch` → a fake channel with `send`).
 */

import type { ButtonInteraction } from 'discord.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscordGateway } from '../discord-gateway.ts'
import { AskQuestionRelay } from '../ask-question-relay.ts'

function makeGateway() {
  const sendMock = vi.fn().mockResolvedValue({ id: 'msg-fake-1' })
  const channel = {
    isTextBased: () => true,
    send: sendMock,
  }
  const fetchMock = vi.fn().mockResolvedValue(channel)
  const gateway = {
    client: {
      channels: { fetch: fetchMock },
      user: { id: 'bot-self' },
    },
  } as unknown as DiscordGateway
  return { gateway, sendMock, fetchMock }
}

function makeButtonInteraction(customId: string, userId = 'user-X') {
  const update = vi.fn().mockResolvedValue(undefined)
  const reply = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    customId,
    user: { id: userId },
    isButton: () => true,
    update,
    reply,
  } as unknown as ButtonInteraction
  return { interaction, update, reply }
}

/** Pull the customIds discord.js wrote into the ActionRow components, in
 *  order — lets the test simulate a button click without exposing the
 *  relay's private pending-id. */
function customIdsFromSendOpts(opts: unknown): string[] {
  const o = opts as { components: { components: { data: { custom_id?: string } }[] }[] }
  const ids: string[] = []
  for (const row of o.components) {
    for (const c of row.components) {
      const id = c.data.custom_id
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

describe('AskQuestionRelay (§57)', () => {
  afterEach(() => vi.useRealTimers())

  it('ask() sends a message with embed + buttons and counts as pending', async () => {
    const { gateway, sendMock } = makeGateway()
    const r = new AskQuestionRelay(gateway)
    const p = r.ask('chan-1', '选哪个?', [{ label: 'A' }, { label: 'B' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(sendMock).toHaveBeenCalledTimes(1)
    const opts = sendMock.mock.calls[0]![0] as { embeds: unknown[]; components: unknown[] }
    expect(opts.embeds.length).toBe(1)
    expect(opts.components.length).toBe(1) // 1 row for 2 buttons
    expect(r.pendingCount).toBe(1)
    r.stop() // unblock the awaiting promise
    await p
  })

  it('handleButton resolves ask() with the chosen index and label', async () => {
    const { gateway, sendMock } = makeGateway()
    const r = new AskQuestionRelay(gateway)
    const p = r.ask('chan-1', '选哪个?', [{ label: 'A' }, { label: 'B', description: '第二项' }])
    await Promise.resolve()
    await Promise.resolve()

    const ids = customIdsFromSendOpts(sendMock.mock.calls[0]![0])
    expect(ids.length).toBe(2)
    const { interaction, update } = makeButtonInteraction(ids[1]!, 'user-7')
    const consumed = await r.handleButton(interaction)

    expect(consumed).toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
    const result = await p
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.index).toBe(1)
      expect(result.label).toBe('B')
    }
    expect(r.pendingCount).toBe(0)
    r.stop()
  })

  it('handleButton returns false for an unrelated customId', async () => {
    const { gateway } = makeGateway()
    const r = new AskQuestionRelay(gateway)
    const consumed = await r.handleButton(makeButtonInteraction('perm:allow:abcde').interaction)
    expect(consumed).toBe(false)
    r.stop()
  })

  it('handleButton sends an ephemeral expired reply for unknown aq id', async () => {
    const { gateway } = makeGateway()
    const r = new AskQuestionRelay(gateway)
    const { interaction, update, reply } = makeButtonInteraction('aq:nope1234:0')
    const consumed = await r.handleButton(interaction)
    expect(consumed).toBe(true)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    r.stop()
  })

  it('ask() rejects with < 2 options', async () => {
    const { gateway, sendMock } = makeGateway()
    const r = new AskQuestionRelay(gateway)
    const result = await r.ask('chan-1', 'q', [{ label: 'only' }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/at least 2/)
    expect(sendMock).not.toHaveBeenCalled()
    r.stop()
  })

  it('ask() rejects with > 25 options', async () => {
    const { gateway, sendMock } = makeGateway()
    const r = new AskQuestionRelay(gateway)
    const opts = Array.from({ length: 26 }, (_, i) => ({ label: `O${i}` }))
    const result = await r.ask('chan-1', 'q', opts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/too many/)
    expect(sendMock).not.toHaveBeenCalled()
    r.stop()
  })

  it('stop() resolves outstanding pending with a shutdown error', async () => {
    const { gateway } = makeGateway()
    const r = new AskQuestionRelay(gateway)
    const p = r.ask('chan-1', 'q', [{ label: 'A' }, { label: 'B' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(r.pendingCount).toBe(1)
    r.stop()
    expect(r.pendingCount).toBe(0)
    const result = await p
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/shutting down/)
  })
})
