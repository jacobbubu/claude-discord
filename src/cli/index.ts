#!/usr/bin/env bun
/**
 * claude-discord-bot CLI entry.
 *
 * Slice 3 status:
 *   ✓ start, configure (slice 1)
 *   ✓ pair, deny, allow, remove, policy, group add/rm, set (slice 3)
 *   ⏳ dev / reset / stop / restart / logs / install / uninstall / status (slice 4/5)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import {
  cmdAllow,
  cmdDeny,
  cmdGroupAdd,
  cmdGroupRm,
  cmdPair,
  cmdPolicy,
  cmdRemove,
  cmdSet,
  cmdStatus as cmdAccessStatus,
} from './access-mutate.ts'
import { configure } from './configure.ts'
import { dev } from './dev.ts'
import { install } from './install.ts'
import { installHook, uninstallHook } from './install-hook.ts'
import { logs } from './logs.ts'
import { reset } from './reset.ts'
import { restart } from './restart.ts'
import { start } from './start.ts'
import { status } from './status.ts'
import { stop } from './stop.ts'
import { uninstall } from './uninstall.ts'

/**
 * Read the runtime version from package.json so `--version` doesn't lie
 * when the file gets bumped (the old hardcoded literal had drifted to 0.0.1
 * while real releases were 0.0.40+).
 */
function readPackageVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const program = new Command()
program
  .name('claude-discord-bot')
  .description('machine-level agent gateway daemon for Discord × Claude Code')
  .version(readPackageVersion())

program.command('start').description('run daemon in foreground').action(() => start())

program
  .command('configure')
  .description('write Discord bot token to .env')
  .argument('<token>', 'Discord bot token from Developer Portal')
  .action((token: string) => configure(token))

// Access subcommands (slice 3)
program
  .command('pair')
  .description('approve a pairing code (writes allowFrom + IPC for daemon to send Paired!)')
  .argument('<code>', '6-hex pairing code from inbound DM')
  .action((code: string) => cmdPair(code))

program
  .command('deny')
  .description('discard a pending pairing code without notifying sender')
  .argument('<code>')
  .action((code: string) => cmdDeny(code))

program
  .command('allow')
  .description('add a Discord user snowflake to allowFrom directly')
  .argument('<senderId>', 'Discord user snowflake (numeric)')
  .action((id: string) => cmdAllow(id))

program
  .command('remove')
  .description('remove a Discord user snowflake from allowFrom')
  .argument('<senderId>')
  .action((id: string) => cmdRemove(id))

program
  .command('policy')
  .description('set DM policy: pairing | allowlist | disabled')
  .argument('<mode>')
  .action((mode: string) => cmdPolicy(mode))

const groupCmd = program
  .command('group')
  .description('guild channel opt-in (subcommands: add | rm)')

groupCmd
  .command('add')
  .description('enable a guild channel; flags: --no-mention, --allow id1,id2')
  .argument('<channelId>', 'Discord channel snowflake (numeric)')
  .option('--no-mention', 'process every message in the channel (skip mention requirement)')
  .option('--allow <ids>', 'comma-separated user snowflakes that can trigger the bot in this channel')
  .action((channelId: string, opts: { mention?: boolean; allow?: string }) => {
    cmdGroupAdd(channelId, {
      noMention: opts.mention === false,
      allow: opts.allow
        ? opts.allow
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : undefined,
    })
  })

groupCmd
  .command('rm')
  .description('disable a guild channel')
  .argument('<channelId>')
  .action((channelId: string) => cmdGroupRm(channelId))

program
  .command('set')
  .description('configure delivery key: ackReaction | replyToMode | textChunkLimit | chunkMode | mentionPatterns')
  .argument('<key>')
  .argument('<value>')
  .action((key: string, value: string) => cmdSet(key, value))

// Slice 4/5 subcommands stubbed for help-surface honesty.
const notYet = (name: string, slice: string) => () => {
  process.stderr.write(`${name} is not implemented yet (lands in ${slice}).\n`)
  process.exit(2)
}

program.command('access').description('show access summary').action(() => cmdAccessStatus())

program
  .command('install')
  .description('register daemon as launchd (macOS) / systemd (Linux) user service')
  .option('--dry-run', 'print install plan without applying')
  .action((opts: { dryRun?: boolean }) => install({ dryRun: opts.dryRun }))

program
  .command('uninstall')
  .description('reverse of install (idempotent)')
  .action(() => uninstall())

program
  .command('install-hook')
  .description('register PreToolUse hook in ~/.claude/settings.json so CC permission requests route to Discord (deltas §15)')
  .action(() => installHook())

program
  .command('uninstall-hook')
  .description('remove the PreToolUse hook from ~/.claude/settings.json')
  .action(() => uninstallHook())

program
  .command('status')
  .description('show daemon health and service state')
  .action(async () => {
    await status()
  })

program.command('dev').description('foreground daemon with file watch').action(() => dev())

program
  .command('reset')
  .description('clear local state files (scoped by flags)')
  .option('--routing', 'clear routing.json')
  .option('--inbox', 'clear inbox/*')
  .option('--pending', 'clear pending pairings in access.json')
  .option('--all', 'clear routing + inbox + pending')
  .option('--including-token', 'also delete .env (token)')
  .option('--including-acl', 'also reset access.json to defaults (allowFrom + groups + mentionPatterns wiped)')
  .action((opts: { routing?: boolean; inbox?: boolean; pending?: boolean; all?: boolean; includingToken?: boolean; includingAcl?: boolean }) =>
    reset(opts),
  )

program.command('stop').description('stop the installed service (without uninstalling)').action(() => stop())

program.command('restart').description('stop + start the installed service').action(() => restart())

program
  .command('logs')
  .description('tail daemon logs')
  .option('-f, --follow', 'follow logs (tail -F)')
  .action((opts: { follow?: boolean }) => logs({ follow: opts.follow }))

// notYet remains imported but unused — silence lint
void notYet

program.parseAsync(process.argv)
