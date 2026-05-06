#!/usr/bin/env bun
/**
 * Spike #8 daemon stub: writes a heartbeat file every second.
 * Used to confirm a launchctl-spawned daemon actually runs.
 */

import { writeFileSync } from 'node:fs'

const HEARTBEAT_FILE = process.env.SPIKE8_HEARTBEAT ?? '/tmp/spike8-heartbeat'

let count = 0
setInterval(() => {
  count++
  try {
    writeFileSync(HEARTBEAT_FILE, `${count} ${Date.now()} ${process.pid}\n`)
  } catch (e) {
    process.stderr.write(`spike8: heartbeat write failed: ${e}\n`)
  }
}, 1000)

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
