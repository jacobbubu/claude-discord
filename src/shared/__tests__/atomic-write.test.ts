import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWrite } from '../atomic-write.ts'

describe('atomicWrite', () => {
  it('writes content with strict mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-'))
    const target = join(dir, 'a.txt')
    atomicWrite(target, 'hello\n', 0o600)
    expect(readFileSync(target, 'utf8')).toBe('hello\n')
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('overwrites existing file atomically (no .tmp residue)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-'))
    const target = join(dir, 'a.txt')
    writeFileSync(target, 'old\n', { mode: 0o600 })
    atomicWrite(target, 'new\n', 0o600)
    expect(readFileSync(target, 'utf8')).toBe('new\n')
    expect(existsSync(`${target}.tmp.${process.pid}`)).toBe(false)
  })
})
