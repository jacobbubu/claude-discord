/**
 * Controlled e2e #1 — first-pairing flow.
 *
 *   1. Stranger DMs the bot
 *   2. Daemon replies with "Pairing required ... claude-discord-bot pair <6-hex>"
 *   3. Test extracts code, calls cmdPair (= what the CLI does)
 *   4. cmdPair mutates access.json + writes approved/<senderId>
 *   5. Approval watcher polls (interval 50ms in test), daemon sends "Paired!"
 *      to the original DM channel
 *   6. Same user DMs again — gate now passes; with no plugin connected the
 *      daemon falls through to "no workspace online" reply
 *   7. Shutdown is clean
 *
 * No real Claude Code, no real Discord. The whole flow runs in-process
 * against the MockClient; this is the canonical regression test for the
 * daemon's pairing/access path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cmdPair } from '../../../cli/access-mutate.ts'
import { buildHarness, type Harness } from './_harness.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const lastSentInDm = (h: Harness, senderId: string): string | undefined => {
  const dm = h.client.allChannels.get(`dm-${senderId}`)
  if (!dm) return undefined
  const last = dm.history.at(-1)
  // Bot messages have author.bot = true
  if (!last || !last.author.bot) return undefined
  return last.content
}

const allBotMessagesInDm = (h: Harness, senderId: string): string[] => {
  const dm = h.client.allChannels.get(`dm-${senderId}`)
  if (!dm) return []
  return dm.history.filter(m => m.author.bot).map(m => m.content)
}

describe('controlled e2e — first pairing', () => {
  let h: Harness
  let savedExit: typeof process.exit
  let savedEnv: string | undefined

  beforeEach(async () => {
    h = await buildHarness()
    savedExit = process.exit
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`)
    }) as typeof process.exit
    savedEnv = process.env.CLAUDE_DISCORD_STATE_DIR
    process.env.CLAUDE_DISCORD_STATE_DIR = h.paths.stateDir
  })

  afterEach(async () => {
    process.exit = savedExit
    if (savedEnv === undefined) delete process.env.CLAUDE_DISCORD_STATE_DIR
    else process.env.CLAUDE_DISCORD_STATE_DIR = savedEnv
    await h.shutdown()
  })

  it('full pairing flow: DM → code → cmdPair → Paired! → routed', async () => {
    const senderId = 'u-99999999'

    // 1. Stranger DM
    h.client.injectMessage({
      userId: senderId,
      username: 'stranger',
      content: 'hello bot',
      isDM: true,
    })

    // Give inbound-router an event-loop turn to process
    await wait(20)

    // 2. Bot replied with pairing code
    const reply = lastSentInDm(h, senderId)
    expect(reply).toMatch(/Pairing required/)
    const codeMatch = reply!.match(/claude-discord-bot pair ([0-9a-f]{6})/)
    expect(codeMatch).not.toBeNull()
    const code = codeMatch![1]!

    // 3. CLI pair
    cmdPair(code!)

    // 4. Approval watcher (50ms interval) sends "Paired!"
    // Allow up to 200ms for the watcher to pick up the file
    let pairedSeen = false
    for (let i = 0; i < 10 && !pairedSeen; i++) {
      await wait(50)
      pairedSeen = allBotMessagesInDm(h, senderId).some(s => s.includes('Paired!'))
    }
    expect(pairedSeen).toBe(true)

    // 5. Subsequent DM passes the gate (now in allowFrom). With no plugin
    //    connected the daemon falls through to "no workspace online".
    h.client.injectMessage({
      userId: senderId,
      username: 'stranger',
      content: 'now I am paired',
      isDM: true,
    })
    await wait(20)
    const finalReply = lastSentInDm(h, senderId)
    expect(finalReply).toMatch(/no workspace online/)
  })
})
