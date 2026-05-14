import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LineBuffer } from '../../protocol/ndjson.ts'
import { PROTOCOL_VERSION } from '../../protocol/version.ts'
import type { Paths } from '../../shared/paths.ts'
import { WorkspaceRegistry } from '../registry.ts'
import { startSocketServer, type SocketServer } from '../socket-server.ts'

let stateDir: string
let server: SocketServer
let registry: WorkspaceRegistry

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'sock-'))
  registry = new WorkspaceRegistry()
  const paths: Paths = {
    stateDir,
    envFile: join(stateDir, '.env'),
    accessFile: join(stateDir, 'access.json'),
    routingFile: join(stateDir, 'routing.json'),
    approvedDir: join(stateDir, 'approved'),
    inboxDir: join(stateDir, 'inbox'),
    socketPath: join(stateDir, 'daemon.sock'),
    outLog: join(stateDir, 'daemon.out.log'),
    errLog: join(stateDir, 'daemon.err.log'),
    daemonLog: join(stateDir, 'daemon.log'),
  }
  server = startSocketServer(paths, registry)
})

afterEach(async () => {
  await server.close()
})

const sendAndCollect = (
  socketPath: string,
  toSend: string,
  waitMs: number,
): Promise<string[]> =>
  new Promise(resolve => {
    const sock = connect(socketPath)
    const buf = new LineBuffer()
    const out: string[] = []
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(toSend))
    sock.on('data', chunk => {
      for (const line of buf.push(chunk as unknown as string)) out.push(line)
    })
    setTimeout(() => {
      sock.end()
      resolve(out)
    }, waitMs)
  })

describe('startSocketServer', () => {
  it('accepts register and replies with register_ack', async () => {
    const paths = {
      stateDir,
      socketPath: join(stateDir, 'daemon.sock'),
    }
    const registerLine =
      JSON.stringify({
        type: 'register',
        v: PROTOCOL_VERSION,
        agent: 'claude-code',
        cwd: '/Users/x/proj/foo',
        pid: 99,
        capabilities: ['reply'],
      }) + '\n'

    const replies = await sendAndCollect(paths.socketPath, registerLine, 200)
    expect(replies.length).toBeGreaterThan(0)
    const ack = JSON.parse(replies[0]!)
    expect(ack.type).toBe('register_ack')
    expect(ack.workspace).toBe('foo')
    expect(registry.has('foo')).toBe(true)
  })

  it('rejects register with unknown agent', async () => {
    const registerLine =
      JSON.stringify({
        type: 'register',
        v: PROTOCOL_VERSION,
        agent: 'codex',
        cwd: '/x/foo',
        pid: 1,
        capabilities: [],
      }) + '\n'

    const replies = await sendAndCollect(
      join(stateDir, 'daemon.sock'),
      registerLine,
      200,
    )
    const reject = JSON.parse(replies[0]!)
    expect(reject.type).toBe('register_reject')
    expect(reject.reason).toBe('unknown_agent')
  })

  it('echoes tool_call as tool_result (slice 2 stub behavior)', async () => {
    const lines =
      JSON.stringify({
        type: 'register',
        v: PROTOCOL_VERSION,
        agent: 'claude-code',
        cwd: '/x/foo',
        pid: 1,
        capabilities: ['reply'],
      }) +
      '\n' +
      JSON.stringify({
        type: 'tool_call',
        v: PROTOCOL_VERSION,
        id: 'tc-1',
        tool: 'reply',
        args: { chat_id: 'c1', text: 'hi' },
      }) +
      '\n'

    const replies = await sendAndCollect(join(stateDir, 'daemon.sock'), lines, 300)
    const messages = replies.map(r => JSON.parse(r))
    const result = messages.find(m => m.type === 'tool_result')
    expect(result).toBeDefined()
    expect(result.ok).toBe(true)
    expect(result.result).toContain('reply')
  })
})
