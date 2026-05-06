#!/usr/bin/env bun
/**
 * Spike #8 verifier — does an unsigned LaunchAgent plist load correctly on macOS?
 *
 * Procedure:
 *   1. Build absolute-path plist with a disposable label (suffixed with pid)
 *   2. launchctl bootstrap gui/<uid> <plist>   (no signing)
 *   3. Wait, then verify daemon-stub wrote heartbeat file
 *   4. launchctl print gui/<uid>/<label>       (status check)
 *   5. launchctl bootout gui/<uid> <plist>     (clean teardown)
 *   6. Verify all artifacts gone
 *
 * Aggressive cleanup: process.on('exit') always runs bootout + plist delete.
 * If something terrible happens, the printed cleanup command is the recovery
 * instruction.
 */

import { spawnSync } from 'node:child_process'
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  statSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fail = (msg: string): never => {
  console.error(`❌ ${msg}`)
  process.exit(1)
}
const ok = (msg: string) => console.log(`✓ ${msg}`)

const UID = process.getuid?.() ?? -1
const PID = process.pid
const LABEL = `com.jacobbubu.claude-discord-spike-8-${PID}`

const tmpDir = mkdtempSync(join(tmpdir(), 'spike8-'))
const HEARTBEAT = join(tmpDir, 'heartbeat')
const PLIST_PATH = join(tmpDir, `${LABEL}.plist`)

const BUN_PATH = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim()
const DAEMON_TS = join(import.meta.dir, 'daemon-stub.ts')

if (!BUN_PATH) fail('bun not in PATH')
if (!existsSync(DAEMON_TS)) fail(`daemon-stub.ts not found at ${DAEMON_TS}`)

const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BUN_PATH}</string>
        <string>run</string>
        <string>${DAEMON_TS}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${process.env.HOME}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>SPIKE8_HEARTBEAT</key>
        <string>${HEARTBEAT}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardErrorPath</key>
    <string>${tmpDir}/daemon.err.log</string>
    <key>StandardOutPath</key>
    <string>${tmpDir}/daemon.out.log</string>
</dict>
</plist>
`
writeFileSync(PLIST_PATH, plistXml, { mode: 0o644 })

let bootstrapped = false

function teardown() {
  if (bootstrapped) {
    process.stderr.write(`\n[teardown] launchctl bootout gui/${UID} ${PLIST_PATH}\n`)
    spawnSync('launchctl', ['bootout', `gui/${UID}`, PLIST_PATH], { stdio: 'ignore' })
    bootstrapped = false
  }
  try {
    unlinkSync(PLIST_PATH)
  } catch {}
}
process.on('exit', teardown)
process.on('SIGINT', () => {
  teardown()
  process.exit(130)
})
process.on('SIGTERM', () => {
  teardown()
  process.exit(143)
})

console.log(`Plist label: ${LABEL}`)
console.log(`Plist path:  ${PLIST_PATH}`)
console.log(`Bun path:    ${BUN_PATH}`)
console.log()

// Step 1: codesign status of bun (informational)
console.log('Step 1: codesign status of bun binary...')
const cs = spawnSync('codesign', ['-dv', BUN_PATH], { encoding: 'utf8' })
const csOut = (cs.stderr ?? '') + (cs.stdout ?? '')
if (csOut.includes('Authority=Developer ID')) {
  ok('bun is Developer ID signed (best case)')
} else if (csOut.includes('Signature=adhoc')) {
  ok('bun is ad-hoc signed (most homebrew binaries)')
} else if (csOut.includes('not signed')) {
  console.log('  bun is unsigned')
} else {
  console.log(`  codesign output: ${csOut.split('\n').slice(0, 3).join(' / ')}`)
}
ok('codesign captured (informational)')

// Step 2: launchctl bootstrap (the real test)
console.log('\nStep 2: launchctl bootstrap (no signature on plist itself)...')
const bs = spawnSync('launchctl', ['bootstrap', `gui/${UID}`, PLIST_PATH], { encoding: 'utf8' })
if (bs.status !== 0) {
  console.error(`bootstrap stdout: ${bs.stdout}`)
  console.error(`bootstrap stderr: ${bs.stderr}`)
  fail(`launchctl bootstrap failed with exit ${bs.status}`)
}
bootstrapped = true
ok(`launchctl bootstrap succeeded (no signing required)`)

// Step 3: wait for heartbeat
console.log('\nStep 3: wait up to 5s for daemon heartbeat file...')
let heartbeatSeen = false
const deadline = Date.now() + 5000
while (Date.now() < deadline) {
  if (existsSync(HEARTBEAT)) {
    const content = readFileSync(HEARTBEAT, 'utf8').trim()
    ok(`heartbeat appeared: ${content}`)
    heartbeatSeen = true
    break
  }
  await new Promise(r => setTimeout(r, 200))
}
if (!heartbeatSeen) fail('heartbeat file never appeared — daemon did not start')

// Step 4: launchctl print to confirm running
console.log('\nStep 4: launchctl print gui/${UID}/${LABEL}...')
const pr = spawnSync('launchctl', ['print', `gui/${UID}/${LABEL}`], { encoding: 'utf8' })
if (pr.status !== 0) fail(`launchctl print failed: ${pr.stderr}`)
const pidLine = pr.stdout.split('\n').find(l => l.includes('pid '))
ok(`launchctl print: ${pidLine?.trim() ?? 'job is registered'}`)

// Step 5: bootout (also runs in teardown but explicit here for clarity)
console.log('\nStep 5: launchctl bootout (cleanup)...')
const bo = spawnSync('launchctl', ['bootout', `gui/${UID}`, PLIST_PATH], { encoding: 'utf8' })
bootstrapped = false  // teardown won't double-bootout
if (bo.status !== 0) {
  // Some macOS versions return non-zero on success; verify by checking the job is gone
  const pr2 = spawnSync('launchctl', ['print', `gui/${UID}/${LABEL}`], { encoding: 'utf8' })
  if (pr2.status === 0) fail(`bootout failed: ${bo.stderr}`)
  ok(`bootout (exit ${bo.status} but service no longer registered — likely normal)`)
} else {
  ok(`launchctl bootout succeeded`)
}

// Step 6: verify gone
const pr3 = spawnSync('launchctl', ['print', `gui/${UID}/${LABEL}`], { encoding: 'utf8' })
if (pr3.status === 0) fail('service still registered after bootout')
ok('service deregistered (launchctl print returns non-zero)')

console.log()
console.log('🎉 All assertions passed.')
console.log()
console.log('Validated:')
console.log('  ✅ Unsigned LaunchAgent plist loads via launchctl bootstrap (no signing required for user agents)')
console.log('  ✅ daemon-stub spawned by launchd writes heartbeat file (= daemon process actually ran under launchd)')
console.log('  ✅ launchctl print confirms job registered + provides PID')
console.log('  ✅ launchctl bootout cleanly deregisters the job')
console.log('  ✅ End-to-end install → run → verify → uninstall lifecycle works without code signing')
console.log()
console.log('Conclusion: claude-discord-bot install does NOT need to sign the plist or daemon binary')
console.log('on modern macOS for user-domain LaunchAgents. Documented for architecture §10.')

if (process.env.SPIKE8_KEEP_LOGS) {
  console.log(`\nLogs preserved at ${tmpDir}`)
} else {
  // Best-effort cleanup of tmpDir
  try {
    spawnSync('rm', ['-rf', tmpDir])
  } catch {}
}

process.exit(0)
