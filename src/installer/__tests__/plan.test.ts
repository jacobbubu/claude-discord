import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePaths } from '../../shared/paths.ts'
import {
  buildPlan,
  describePlan,
  describeServiceAction,
  detectPlatform,
  DAEMON_LABEL,
  SYSTEMD_UNIT,
} from '../plan.ts'

describe('detectPlatform', () => {
  it('returns macos | linux | unsupported for known platforms', () => {
    const p = detectPlatform()
    expect(['macos', 'linux', 'unsupported']).toContain(p)
  })
})

describe('buildPlan', () => {
  it('returns artifacts and service actions for the host platform', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'plan-'))
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    const result = buildPlan({
      paths,
      daemonScript: '/somewhere/cli.ts',
      bunPath: '/usr/local/bin/bun',
      home: '/Users/test',
    })

    if (result.platform === 'unsupported') {
      // CI on Windows/etc. — we just verify the plan reports unsupported
      expect(true).toBe(true)
      return
    }
    expect(result.label).toBe(DAEMON_LABEL)
    expect(result.artifacts.length).toBeGreaterThan(0)
    expect(result.serviceActions.length).toBeGreaterThan(0)
    expect(result.rollback.length).toBeGreaterThan(0)

    const writeFile = result.artifacts.find(a => a.kind === 'write-file')
    expect(writeFile).toBeDefined()
    expect((writeFile as { content: string }).content).toContain('/somewhere/cli.ts')
    expect((writeFile as { content: string }).content).toContain('/usr/local/bin/bun')

    if (result.platform === 'macos') {
      expect(result.paths.plist).toMatch(/Library\/LaunchAgents/)
      expect((writeFile as { content: string }).content).toContain('<plist')
      expect((writeFile as { content: string }).content).toContain(DAEMON_LABEL)
    } else if (result.platform === 'linux') {
      expect(result.paths.unit).toMatch(/systemd\/user/)
      expect((writeFile as { content: string }).content).toContain('[Unit]')
      expect((writeFile as { content: string }).content).toContain(SYSTEMD_UNIT.replace('.service', ''))
    }
  })
})

describe('describePlan', () => {
  it('produces human-readable lines', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'plan-'))
    const paths = resolvePaths({ CLAUDE_DISCORD_STATE_DIR: stateDir } as NodeJS.ProcessEnv)
    const r = buildPlan({
      paths,
      daemonScript: '/x/cli.ts',
      bunPath: '/usr/local/bin/bun',
      home: '/Users/test',
    })
    if (r.platform === 'unsupported') return
    const lines = describePlan(r)
    expect(lines.some(l => l.includes('Platform'))).toBe(true)
    expect(lines.some(l => l.includes(DAEMON_LABEL))).toBe(true)
    expect(lines.some(l => l.includes('Artifacts'))).toBe(true)
    expect(lines.some(l => l.includes('Service actions'))).toBe(true)
  })
})

describe('describeServiceAction', () => {
  it('renders each action kind to a one-line string', () => {
    expect(
      describeServiceAction({ kind: 'launchctl-bootstrap', plistPath: '/p' }),
    ).toMatch(/launchctl bootstrap/)
    expect(
      describeServiceAction({ kind: 'launchctl-bootout', plistPath: '/p' }),
    ).toMatch(/launchctl bootout/)
    expect(
      describeServiceAction({ kind: 'systemctl-enable-now', unitName: 'x.service' }),
    ).toMatch(/systemctl --user enable/)
    expect(
      describeServiceAction({ kind: 'systemctl-disable', unitName: 'x.service' }),
    ).toMatch(/systemctl --user disable/)
    expect(describeServiceAction({ kind: 'systemctl-daemon-reload' })).toMatch(
      /daemon-reload/,
    )
  })
})
