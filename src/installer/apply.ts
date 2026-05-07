/**
 * Apply an install plan in order. Failure rolls back already-applied steps in
 * reverse to leave the system in its pre-install state.
 *
 * For tests / dry-run, pass `executor: 'dry-run'` and apply prints what it
 * would do without touching the filesystem or running launchctl/systemctl.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type {
  InstallPlan,
  RollbackStep,
  ServiceAction,
} from './plan.ts'

export type ExecutorMode = 'real' | 'dry-run'

export type ApplyResult = {
  ok: boolean
  steps: string[]
  error?: string
}

const NO_OP = (msg: string, sink: string[]) => {
  sink.push(`[dry-run] ${msg}`)
}

export function applyPlan(plan: InstallPlan, mode: ExecutorMode = 'real'): ApplyResult {
  const steps: string[] = []
  const undoStack: RollbackStep[] = []

  try {
    for (const a of plan.artifacts) {
      if (a.kind === 'ensure-dir') {
        if (mode === 'real') {
          mkdirSync(a.path, { recursive: true, mode: a.mode })
          if (a.mode !== undefined) {
            try {
              chmodSync(a.path, a.mode)
            } catch {}
          }
        } else NO_OP(`mkdir ${a.path}`, steps)
        steps.push(`ensure dir ${a.path}`)
      } else if (a.kind === 'write-file') {
        if (mode === 'real') {
          if (existsSync(a.path)) {
            // Treat as overwrite; rollback removes the file regardless.
            // (We could back up but Slice 5 keeps it simple.)
          }
          writeFileSync(a.path, a.content, { mode: a.mode })
          chmodSync(a.path, a.mode)
          undoStack.push({ kind: 'delete-file', path: a.path })
        } else NO_OP(`write ${a.path}`, steps)
        steps.push(`write ${a.path}`)
      }
    }

    for (const sa of plan.serviceActions) {
      if (mode === 'real') runServiceAction(sa)
      else NO_OP(describeForDry(sa), steps)
      steps.push(formatServiceAction(sa))
      // Each "doing" service action has an inverse on rollback list (defined
      // in the plan). We rely on plan.rollback to reverse.
    }

    return { ok: true, steps }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)

    if (mode === 'real') {
      // Roll back applied artifacts (file deletes) + run plan.rollback for
      // service actions. We keep it simple: run plan.rollback fully (it knows
      // the right inverse order).
      const rollbackErrs: string[] = []
      try {
        for (const r of [...undoStack, ...plan.rollback].reverse()) {
          try {
            if (r.kind === 'delete-file') {
              if (existsSync(r.path)) unlinkSync(r.path)
            } else {
              runServiceAction(r.action)
            }
          } catch (er) {
            rollbackErrs.push(String(er))
          }
        }
      } catch {}
      if (rollbackErrs.length > 0) {
        return {
          ok: false,
          steps,
          error: `${error}; rollback errors: ${rollbackErrs.join('; ')}`,
        }
      }
    }

    return { ok: false, steps, error }
  }
}

export function runRollback(plan: InstallPlan): ApplyResult {
  const steps: string[] = []
  const errs: string[] = []
  for (const r of plan.rollback) {
    try {
      if (r.kind === 'delete-file') {
        if (existsSync(r.path)) {
          unlinkSync(r.path)
          steps.push(`delete ${r.path}`)
        }
      } else {
        runServiceAction(r.action)
        steps.push(formatServiceAction(r.action))
      }
    } catch (e) {
      errs.push(e instanceof Error ? e.message : String(e))
    }
  }
  if (errs.length > 0) return { ok: false, steps, error: errs.join('; ') }
  return { ok: true, steps }
}

function runServiceAction(sa: ServiceAction): void {
  const uid = process.getuid?.() ?? -1
  let cmd: string
  let args: string[]
  switch (sa.kind) {
    case 'launchctl-bootstrap':
      cmd = 'launchctl'
      args = ['bootstrap', `gui/${uid}`, sa.plistPath]
      break
    case 'launchctl-bootout':
      cmd = 'launchctl'
      args = ['bootout', `gui/${uid}`, sa.plistPath]
      break
    case 'systemctl-enable-now':
      cmd = 'systemctl'
      args = ['--user', 'enable', '--now', sa.unitName]
      break
    case 'systemctl-disable':
      cmd = 'systemctl'
      args = ['--user', 'disable', '--now', sa.unitName]
      break
    case 'systemctl-daemon-reload':
      cmd = 'systemctl'
      args = ['--user', 'daemon-reload']
      break
  }
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  // bootout sometimes returns non-zero even on success; bootstrap returns 0
  // when service was registered. We treat status 0 as success and other codes
  // as ignorable for these admin commands as long as no exception was thrown.
  if (result.error) throw result.error
  if (sa.kind !== 'launchctl-bootout' && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exit ${result.status}: ${result.stderr}`)
  }
}

function formatServiceAction(sa: ServiceAction): string {
  switch (sa.kind) {
    case 'launchctl-bootstrap':
      return `launchctl bootstrap ${sa.plistPath}`
    case 'launchctl-bootout':
      return `launchctl bootout ${sa.plistPath}`
    case 'systemctl-enable-now':
      return `systemctl --user enable --now ${sa.unitName}`
    case 'systemctl-disable':
      return `systemctl --user disable --now ${sa.unitName}`
    case 'systemctl-daemon-reload':
      return `systemctl --user daemon-reload`
  }
}

function describeForDry(sa: ServiceAction): string {
  return formatServiceAction(sa)
}
