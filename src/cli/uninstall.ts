/**
 * `claude-discord-bot uninstall`
 *
 * Builds the same install plan and runs its rollback steps. Idempotent — if
 * the service isn't installed, the operations no-op (we tolerate non-zero
 * exits from launchctl/systemctl during uninstall).
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { resolvePaths } from '../shared/paths.ts'
import { buildPlan, type InstallPlan } from '../installer/plan.ts'
import { runRollback } from '../installer/apply.ts'

function resolveDaemonScript(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, 'index.ts')
}

export function uninstall(): void {
  const paths = resolvePaths()
  const planResult = buildPlan({ paths, daemonScript: resolveDaemonScript() })
  if (planResult.platform === 'unsupported') {
    process.stderr.write(`[error] unsupported platform: ${process.platform}\n`)
    process.exit(1)
  }

  const result = runRollback(planResult as InstallPlan)
  for (const s of result.steps) process.stdout.write(`  ${s}\n`)
  if (!result.ok) {
    process.stdout.write(
      `\n⚠ uninstall encountered non-fatal errors (likely service was already stopped): ${result.error}\n`,
    )
    return
  }
  process.stdout.write('\n✓ Uninstalled.\n')
}
