#!/usr/bin/env bun
/**
 * claude-discord-bot CLI entry.
 *
 * Slice 1 implements: start / configure
 * Subcommand stubs registered for: dev / reset / stop / restart / logs /
 *   install / uninstall / status / pair / deny / allow / remove / policy /
 *   group / set
 *
 * The stubs print "not implemented in slice 1" so the help surface accurately
 * advertises the eventual command set without misleading anyone.
 */

import { Command } from 'commander'
import { configure } from './configure.ts'
import { start } from './start.ts'

const program = new Command()
program
  .name('claude-discord-bot')
  .description(
    'machine-level agent gateway daemon for Discord × Claude Code',
  )
  .version('0.0.1')

program.command('start').description('run daemon in foreground').action(() => start())

program
  .command('configure')
  .description('write Discord bot token to .env')
  .argument('<token>', 'Discord bot token from Developer Portal')
  .action((token: string) => configure(token))

const notYet = (name: string) => () => {
  process.stderr.write(`${name} is not implemented in slice 1; see issue #11 follow-up slices.\n`)
  process.exit(2)
}
program.command('dev').description('foreground daemon with file watch (Slice 5)').action(notYet('dev'))
program.command('reset').description('clear state then start (Slice 5)').action(notYet('reset'))
program.command('stop').description('stop service (Slice 5)').action(notYet('stop'))
program.command('restart').description('stop + start (Slice 5)').action(notYet('restart'))
program.command('logs').description('tail daemon logs (Slice 5)').action(notYet('logs'))
program.command('install').description('register service via launchd / systemd (Slice 5)').action(notYet('install'))
program.command('uninstall').description('remove service (Slice 5)').action(notYet('uninstall'))
program.command('status').description('show daemon health (Slice 4)').action(notYet('status'))
program.command('pair').description('approve a pairing code (Slice 3)').argument('<code>').action(notYet('pair'))
program.command('deny').description('reject a pairing code (Slice 3)').argument('<code>').action(notYet('deny'))
program.command('allow').description('add user to allowlist (Slice 3)').argument('<senderId>').action(notYet('allow'))
program.command('remove').description('remove user from allowlist (Slice 3)').argument('<senderId>').action(notYet('remove'))
program.command('policy').description('set DM policy (Slice 3)').argument('<mode>').action(notYet('policy'))

const groupCmd = program.command('group').description('guild channel opt-in (Slice 3)')
groupCmd.command('add').argument('<channelId>').action(notYet('group add'))
groupCmd.command('rm').argument('<channelId>').action(notYet('group rm'))

program
  .command('set')
  .description('configure delivery key (Slice 3)')
  .argument('<key>')
  .argument('<value>')
  .action(notYet('set'))

program.parseAsync(process.argv)
