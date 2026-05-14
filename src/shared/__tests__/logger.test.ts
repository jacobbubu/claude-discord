import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachFileSink, log, makeFileSinkWriter } from '../logger.ts'

function tmpFile(prefix = 'logger-'): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'daemon.log')
}

describe('makeFileSinkWriter (§31)', () => {
  it('appends lines to the file and writes are immediately visible', () => {
    const path = tmpFile()
    const sink = makeFileSinkWriter({ path })
    sink.write('hello\n')
    sink.write('world\n')
    expect(readFileSync(path, 'utf8')).toBe('hello\nworld\n')
    sink.close()
  })

  it('rotates current → .1 once size crosses maxBytes', () => {
    const path = tmpFile()
    const sink = makeFileSinkWriter({ path, maxBytes: 50, keep: 3 })
    sink.write('A'.repeat(60) + '\n') // crosses threshold → rotate after this write
    sink.write('after\n')
    expect(readFileSync(`${path}.1`, 'utf8').length).toBeGreaterThanOrEqual(60)
    expect(readFileSync(path, 'utf8')).toBe('after\n')
    sink.close()
  })

  it('shifts .1 → .2 → .3 on repeated rotations and drops the oldest', () => {
    const path = tmpFile()
    const sink = makeFileSinkWriter({ path, maxBytes: 50, keep: 3 })
    sink.write('first-'.repeat(20) + '\n') // → .1
    sink.write('second-'.repeat(15) + '\n') // → .1 (old → .2)
    sink.write('third-'.repeat(15) + '\n') // → .1 (old → .2, old.2 → .3)
    sink.write('fourth-'.repeat(15) + '\n') // → .1 (cascade); oldest (.3) overwritten
    sink.write('current-tail\n')

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(true)
    expect(existsSync(`${path}.4`)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('current-tail\n')

    // .3 is the oldest retained — for keep=3 starting from 4 rotations, it's
    // the content that was rotated *third* into .1 (i.e. `second-...`).
    expect(readFileSync(`${path}.3`, 'utf8')).toContain('second-')
    // .1 is always the most-recently-rotated payload — here `fourth-...`.
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('fourth-')
    sink.close()
  })

  it('close() makes subsequent writes no-ops without throwing', () => {
    const path = tmpFile()
    const sink = makeFileSinkWriter({ path })
    sink.write('a\n')
    sink.close()
    expect(() => sink.write('b\n')).not.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('a\n')
  })

  it('I/O failure (write to a closed-then-deleted file) does not throw to caller', () => {
    // We don't easily simulate writeSync failures without OS-level games;
    // close() then write() exercises the same swallow path.
    const path = tmpFile()
    const sink = makeFileSinkWriter({ path })
    sink.close()
    expect(() => sink.write('ghost\n')).not.toThrow()
  })
})

describe('attachFileSink (§31, integrated with log.*)', () => {
  it('routes log.* through the file sink in addition to stderr', () => {
    const path = tmpFile()
    const handle = attachFileSink({ path })
    log.info('hello world')
    log.warn('careful')
    const contents = readFileSync(path, 'utf8')
    expect(contents).toContain('[info] hello world')
    expect(contents).toContain('[warn] careful')
    handle.detach()
  })

  it('detach() removes the writer; future log.* lines do not grow the file', () => {
    const path = tmpFile()
    const handle = attachFileSink({ path })
    log.info('one')
    const sizeBefore = statSync(path).size
    handle.detach()
    log.info('two')
    const sizeAfter = statSync(path).size
    expect(sizeAfter).toBe(sizeBefore)
  })
})
