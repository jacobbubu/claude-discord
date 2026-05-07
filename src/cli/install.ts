/**
 * `claude-discord-bot install [--dry-run]`
 *
 * Generates an install plan, applies it (or prints in dry-run mode), then
 * verifies the service is running. Failure rolls back automatically.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { initStateDir } from '../shared/init-state-dir.ts'
import { resolvePaths } from '../shared/paths.ts'
import { applyPlan } from '../installer/apply.ts'
import { buildPlan, describePlan, type InstallPlan } from '../installer/plan.ts'
import { verifyInstall } from '../installer/verify.ts'

function die(msg: string): never {
  process.stderr.write(`[error] ${msg}\n`)
  process.exit(1)
}

/**
 * Resolve the daemon entry script path. Production builds may want
 * `${INSTALL_DIR}/dist/cli.js`; dev installs (this slice) point at the
 * repo's src/cli/index.ts.
 */
function resolveDaemonScript(): string {
  // src/cli/install.ts → repo root via src/cli → src → repo
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, 'index.ts')
}

export type InstallOpts = { dryRun?: boolean }

export function install(opts: InstallOpts = {}): void {
  const paths = resolvePaths()
  initStateDir(paths)

  const planResult = buildPlan({ paths, daemonScript: resolveDaemonScript() })
  if (planResult.platform === 'unsupported') {
    die(`unsupported platform: ${process.platform}`)
  }
  const plan: InstallPlan = planResult as InstallPlan

  const lines = describePlan(plan)
  process.stdout.write(`Install plan:\n  ${lines.join('\n  ')}\n\n`)

  if (opts.dryRun) {
    const result = applyPlan(plan, 'dry-run')
    process.stdout.write('Dry-run (no changes applied):\n')
    for (const s of result.steps) process.stdout.write(`  ${s}\n`)
    return
  }

  process.stdout.write('Applying plan...\n')
  const result = applyPlan(plan, 'real')
  for (const s of result.steps) process.stdout.write(`  ${s}\n`)

  if (!result.ok) {
    die(`install failed: ${result.error}`)
  }

  const verified = verifyInstall(plan)
  if (verified.ok) {
    process.stdout.write(`\n✓ Installed and running. ${verified.detail}\n`)
  } else {
    process.stdout.write(`\n⚠ Installed but verify could not confirm running: ${verified.detail}\n`)
  }
}
