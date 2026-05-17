#!/usr/bin/env node
/**
 * Sync `.claude-plugin/plugin.json` version with the npm release version.
 *
 * Invoked by `@semantic-release/exec` `prepareCmd`. semantic-release passes
 * the next-release version as argv[2] (via the `${nextRelease.version}`
 * substitution in .releaserc.json).
 *
 * Why: the plugin is also distributed via the Claude Code marketplace (which
 * reads `.claude-plugin/plugin.json`), so its version must stay in lockstep
 * with the npm-published daemon version. Without this, marketplace users
 * could install a plugin whose protocol doesn't match the daemon they're
 * running.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-plugin-version: invalid version "${version}"`)
  process.exit(1)
}

const pluginPath = resolve(process.cwd(), '.claude-plugin', 'plugin.json')
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'))
plugin.version = version
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n')
console.log(`sync-plugin-version: .claude-plugin/plugin.json → ${version}`)
