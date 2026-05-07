import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPlan } from '../apply.ts'
import type { InstallPlan } from '../plan.ts'

describe('applyPlan dry-run', () => {
  it('reports steps without touching the filesystem', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'apply-'))
    const plan: InstallPlan = {
      platform: 'macos',
      label: 'test',
      artifacts: [
        { kind: 'ensure-dir', path: join(tmp, 'never-created'), mode: 0o700 },
        {
          kind: 'write-file',
          path: join(tmp, 'never-created', 'plist'),
          content: 'fake',
          mode: 0o644,
        },
      ],
      serviceActions: [
        { kind: 'launchctl-bootstrap', plistPath: join(tmp, 'never-created', 'plist') },
      ],
      rollback: [],
      paths: { plist: join(tmp, 'never-created', 'plist') },
    }
    const result = applyPlan(plan, 'dry-run')
    expect(result.ok).toBe(true)
    expect(result.steps.length).toBeGreaterThan(0)
    expect(result.steps.some(s => s.includes('mkdir'))).toBe(true)
    expect(result.steps.some(s => s.includes('write'))).toBe(true)
    expect(result.steps.some(s => s.includes('launchctl bootstrap'))).toBe(true)

    // No filesystem state created
    expect(existsSync(join(tmp, 'never-created'))).toBe(false)
  })
})
