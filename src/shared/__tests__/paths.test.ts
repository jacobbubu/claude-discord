import { describe, expect, it } from 'vitest'
import { resolvePaths } from '../paths.ts'

describe('resolvePaths', () => {
  it('uses CLAUDE_DISCORD_STATE_DIR override when set', () => {
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: '/tmp/spike' } as NodeJS.ProcessEnv)
    expect(paths.stateDir).toBe('/tmp/spike')
    expect(paths.envFile).toBe('/tmp/spike/.env')
    expect(paths.accessFile).toBe('/tmp/spike/access.json')
    expect(paths.routingFile).toBe('/tmp/spike/routing.json')
    expect(paths.approvedDir).toBe('/tmp/spike/approved')
    expect(paths.inboxDir).toBe('/tmp/spike/inbox')
    expect(paths.socketPath).toBe('/tmp/spike/daemon.sock')
  })

  it('falls back to ~/.claude/channels/discord/ when override absent', () => {
    const paths = resolvePaths({} as NodeJS.ProcessEnv)
    expect(paths.stateDir).toMatch(/\.claude\/channels\/discord$/)
    expect(paths.envFile).toMatch(/\.claude\/channels\/discord\/\.env$/)
  })

  it('socket path lives inside state dir', () => {
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: '/tmp/x' } as NodeJS.ProcessEnv)
    expect(paths.socketPath.startsWith(paths.stateDir + '/')).toBe(true)
  })

  it('exposes the daemon-owned rotating log path (§31) alongside the legacy out/err logs', () => {
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: '/tmp/x' } as NodeJS.ProcessEnv)
    expect(paths.daemonLog).toBe('/tmp/x/daemon.log')
    expect(paths.outLog).toBe('/tmp/x/daemon.out.log')
    expect(paths.errLog).toBe('/tmp/x/daemon.err.log')
  })
})
