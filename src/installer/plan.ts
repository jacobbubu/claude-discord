/**
 * Generate an install plan: a serialisable description of every artifact and
 * service action needed to register the daemon, plus the reverse rollback steps.
 *
 * The CLI's install / uninstall consume this plan; --dry-run prints it without
 * executing.
 */

import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Paths } from '../shared/paths.ts'
import { renderPlist } from './plist-template.ts'
import { renderSystemdUnit } from './systemd-template.ts'

export type SupportedPlatform = 'macos' | 'linux'

export type Artifact =
  | { kind: 'ensure-dir'; path: string; mode?: number }
  | { kind: 'write-file'; path: string; content: string; mode: number }

export type ServiceAction =
  | { kind: 'launchctl-bootstrap'; plistPath: string }
  | { kind: 'launchctl-bootout'; plistPath: string }
  | { kind: 'systemctl-enable-now'; unitName: string }
  | { kind: 'systemctl-disable'; unitName: string }
  | { kind: 'systemctl-daemon-reload' }

export type RollbackStep =
  | { kind: 'delete-file'; path: string }
  | { kind: 'service-action'; action: ServiceAction }

export type InstallPlan = {
  platform: SupportedPlatform
  label: string
  artifacts: Artifact[]
  serviceActions: ServiceAction[]
  rollback: RollbackStep[]
  paths: {
    plist?: string
    unit?: string
  }
}

export const DAEMON_LABEL = 'com.jacobbubu.claude-discord-bot'
export const SYSTEMD_UNIT = 'claude-discord-bot.service'

export function detectPlatform(): SupportedPlatform | 'unsupported' {
  switch (platform()) {
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return 'unsupported'
  }
}

function whichBun(): string {
  const found = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim()
  return found || '/usr/local/bin/bun'
}

/**
 * Caller passes the resolved daemon entry script path (e.g.
 * `${REPO}/src/cli/index.ts` for dev; `${install_dir}/dist/cli.js` after build).
 */
export type PlanInput = {
  paths: Paths
  daemonScript: string
  bunPath?: string
  home?: string
}

export function buildPlan(input: PlanInput): InstallPlan | { platform: 'unsupported' } {
  const plat = detectPlatform()
  if (plat === 'unsupported') return { platform: 'unsupported' }

  const home = input.home ?? homedir()
  const bunPath = input.bunPath ?? whichBun()

  if (plat === 'macos') return buildMacOsPlan(input, home, bunPath)
  return buildLinuxPlan(input, home, bunPath)
}

function buildMacOsPlan(input: PlanInput, home: string, bunPath: string): InstallPlan {
  const plistPath = join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`)
  const stderrPath = input.paths.errLog
  const stdoutPath = input.paths.outLog

  const content = renderPlist({
    label: DAEMON_LABEL,
    bunPath,
    daemonScript: input.daemonScript,
    home,
    stderrPath,
    stdoutPath,
  })

  return {
    platform: 'macos',
    label: DAEMON_LABEL,
    artifacts: [
      { kind: 'ensure-dir', path: dirname(plistPath), mode: 0o755 },
      { kind: 'ensure-dir', path: input.paths.stateDir, mode: 0o700 },
      { kind: 'write-file', path: plistPath, content, mode: 0o644 },
    ],
    serviceActions: [{ kind: 'launchctl-bootstrap', plistPath }],
    rollback: [
      { kind: 'service-action', action: { kind: 'launchctl-bootout', plistPath } },
      { kind: 'delete-file', path: plistPath },
    ],
    paths: { plist: plistPath },
  }
}

function buildLinuxPlan(input: PlanInput, home: string, bunPath: string): InstallPlan {
  const unitDir = join(home, '.config', 'systemd', 'user')
  const unitPath = join(unitDir, SYSTEMD_UNIT)
  const stderrPath = input.paths.errLog
  const stdoutPath = input.paths.outLog

  const content = renderSystemdUnit({
    description: 'claude-discord-bot daemon',
    bunPath,
    daemonScript: input.daemonScript,
    stderrPath,
    stdoutPath,
  })

  return {
    platform: 'linux',
    label: DAEMON_LABEL,
    artifacts: [
      { kind: 'ensure-dir', path: unitDir, mode: 0o755 },
      { kind: 'ensure-dir', path: input.paths.stateDir, mode: 0o700 },
      { kind: 'write-file', path: unitPath, content, mode: 0o644 },
    ],
    serviceActions: [
      { kind: 'systemctl-daemon-reload' },
      { kind: 'systemctl-enable-now', unitName: SYSTEMD_UNIT },
    ],
    rollback: [
      { kind: 'service-action', action: { kind: 'systemctl-disable', unitName: SYSTEMD_UNIT } },
      { kind: 'delete-file', path: unitPath },
      { kind: 'service-action', action: { kind: 'systemctl-daemon-reload' } },
    ],
    paths: { unit: unitPath },
  }
}

export function describePlan(plan: InstallPlan): string[] {
  const lines: string[] = [`Platform: ${plan.platform}`, `Label:    ${plan.label}`, '']
  lines.push('Artifacts:')
  for (const a of plan.artifacts) {
    if (a.kind === 'ensure-dir')
      lines.push(`  • ensure dir ${a.path} (mode ${(a.mode ?? 0).toString(8)})`)
    else lines.push(`  • write ${a.path} (mode ${a.mode.toString(8)}, ${a.content.length}B)`)
  }
  lines.push('')
  lines.push('Service actions:')
  for (const sa of plan.serviceActions) {
    lines.push(`  • ${describeServiceAction(sa)}`)
  }
  return lines
}

export function describeServiceAction(sa: ServiceAction): string {
  switch (sa.kind) {
    case 'launchctl-bootstrap':
      return `launchctl bootstrap gui/<uid> ${sa.plistPath}`
    case 'launchctl-bootout':
      return `launchctl bootout gui/<uid> ${sa.plistPath}`
    case 'systemctl-enable-now':
      return `systemctl --user enable --now ${sa.unitName}`
    case 'systemctl-disable':
      return `systemctl --user disable --now ${sa.unitName}`
    case 'systemctl-daemon-reload':
      return `systemctl --user daemon-reload`
  }
}
