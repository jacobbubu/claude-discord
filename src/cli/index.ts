#!/usr/bin/env bun
/**
 * claude-discord-bot CLI entry.
 *
 * Slice 3 status:
 *   ✓ start, configure (slice 1)
 *   ✓ pair, deny, allow, remove, policy, group add/rm, set (slice 3)
 *   ⏳ dev / reset / stop / restart / logs / install / uninstall / status (slice 4/5)
 */

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
import { install } from './install.ts'
import { start } from './start.ts'
import { status } from './status.ts'
import { uninstall } from './uninstall.ts'

const program = new Command()
program
  .name('claude-discord-bot')
  .description('machine-level agent gateway daemon for Discord × Claude Code')
  .version('0.0.1')

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
  .command('status')
  .description('show daemon health and service state')
  .action(async () => {
    await status()
  })

// Remaining slice-6 stubs.
program.command('dev').description('foreground daemon with file watch (Slice 6)').action(notYet('dev', 'Slice 6'))
program.command('reset').description('clear state then start (Slice 6)').action(notYet('reset', 'Slice 6'))
program.command('stop').description('stop service (Slice 6)').action(notYet('stop', 'Slice 6'))
program.command('restart').description('stop + start (Slice 6)').action(notYet('restart', 'Slice 6'))
program.command('logs').description('tail daemon logs (Slice 6)').action(notYet('logs', 'Slice 6'))

program.parseAsync(process.argv)
