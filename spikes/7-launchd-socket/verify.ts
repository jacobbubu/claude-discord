#!/usr/bin/env bun
/**
 * Spike #7 verifier — non-invasive checks.
 *
 * Validates:
 *   1. daemon-stub.ts when run manually creates a socket with mode 0o600
 *   2. parent dir has mode 0o700
 *   3. socket is owned by current user (uid match)
 *   4. another shell process from the same user can connect (peer access)
 *   5. plist-template.xml is valid plist (plutil -lint), with placeholders rendered
 *
 * Does NOT install via launchctl (that's manual; see RESULTS.md "Real launchctl test"
 * section for the procedure to run by hand).
 */

import { spawn, type ChildProcess, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

const fail = (msg: string): never => {
  console.error(`❌ ${msg}`)
  process.exit(1)
}
const ok = (msg: string) => console.log(`✓ ${msg}`)

const tmpDir = mkdtempSync(join(tmpdir(), 'spike7-'))
const SOCKET = join(tmpDir, 'daemon.sock')
const env = { ...process.env, SPIKE7_SOCKET: SOCKET }

// Step 1: spawn daemon-stub
console.log('Step 1: spawning daemon-stub...')
const daemon: ChildProcess = spawn('bun', ['run', 'daemon-stub.ts'], {
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise(r => setTimeout(r, 500))

if (!existsSync(SOCKET)) fail('socket file not created within 500ms')
ok(`socket exists: ${SOCKET}`)

// Step 2: socket file mode
const sockStat = statSync(SOCKET)
const sockMode = sockStat.mode & 0o777
if (sockMode !== 0o600) {
  fail(`socket mode = ${sockMode.toString(8)}; expected 600`)
}
ok(`socket mode = 0o600`)

// Step 3: parent dir mode
const dirStat = statSync(tmpDir)
const dirMode = dirStat.mode & 0o777
// mkdtempSync uses 0o700 by default, daemon-stub also chmods to 0o700
if (dirMode !== 0o700) {
  fail(`parent dir mode = ${dirMode.toString(8)}; expected 700`)
}
ok(`parent dir mode = 0o700`)

// Step 4: daemon owner = current user
const myUid = process.getuid?.() ?? -1
if (sockStat.uid !== myUid) {
  fail(`socket uid = ${sockStat.uid}, current uid = ${myUid}`)
}
ok(`socket owner = current user (uid ${myUid})`)

// Step 5: same-user connect succeeds
console.log('Step 5: connect from same shell user...')
await new Promise<void>((resolve, reject) => {
  const sock = connect(SOCKET)
  sock.on('connect', () => {
    sock.write('hello\n')
  })
  sock.on('data', d => {
    if (d.toString().startsWith('echo: hello')) {
      sock.end()
      resolve()
    } else {
      reject(new Error(`unexpected echo: ${d.toString()}`))
    }
  })
  sock.on('error', reject)
})
ok('same-user connect + echo works')

// Step 6: validate plist template format
console.log('Step 6: rendering plist + plutil -lint...')
const plistTemplate = readFileSync('plist-template.xml', 'utf8')
const rendered = plistTemplate
  .replaceAll('{BUN_PATH}', '/opt/homebrew/bin/bun')
  .replaceAll('{INSTALL_DIR}', '/Users/spike-test/install')
  .replaceAll('{HOME}', '/Users/spike-test')

const renderedPath = join(tmpDir, 'rendered.plist')
writeFileSync(renderedPath, rendered)
const lint = spawnSync('plutil', ['-lint', renderedPath], { encoding: 'utf8' })
if (lint.status !== 0) {
  fail(`plutil -lint failed: ${lint.stdout} ${lint.stderr}`)
}
ok(`plist syntax valid (plutil -lint passed)`)

// Step 7: spot-check key plist properties
const inspect = spawnSync('plutil', ['-p', renderedPath], { encoding: 'utf8' })
if (!inspect.stdout.includes('"Label" => "com.jacobbubu.claude-discord-spike-7"'))
  fail('Label key missing or wrong')
if (!inspect.stdout.includes('"RunAtLoad" => true')) fail('RunAtLoad not set')
if (!inspect.stdout.includes('"KeepAlive" => true')) fail('KeepAlive not set')
ok('Label / RunAtLoad / KeepAlive all set as expected')

// Cleanup
daemon.kill('SIGTERM')
await new Promise(r => setTimeout(r, 200))

console.log('')
console.log('🎉 All assertions passed.')
console.log('')
console.log('Validated:')
console.log('  ✅ daemon creates Unix socket with mode 0o600')
console.log('  ✅ parent dir mode 0o700')
console.log('  ✅ socket owned by current user (no privilege escalation)')
console.log('  ✅ same-user connect + echo works (peer access OK)')
console.log('  ✅ plist template syntax valid (plutil -lint passed)')
console.log('  ✅ plist required keys present (Label / RunAtLoad / KeepAlive)')
console.log('')
console.log('Manual follow-up (not run here, see RESULTS.md):')
console.log('  ⏳ Real launchctl bootstrap of plist (proves launchd-spawned daemon')
console.log('     has same socket permissions as manual-run daemon)')
console.log('  ⏳ Cross-user denial (requires second user account on machine)')
process.exit(0)
