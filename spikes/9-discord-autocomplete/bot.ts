#!/usr/bin/env bun
/**
 * Spike #9 — discord.js application command 自动补全
 *
 * Builds /use <workspace> with autocomplete + interaction handlers.
 *
 * Modes:
 *   STATIC (default): build the SlashCommandBuilder, dump JSON, exit.
 *     No network. Validates that discord.js 14 API surface supports
 *     autocomplete the way our PRD/architecture assumes.
 *
 *   LIVE: when SPIKE9_TEST_BOT_TOKEN and SPIKE9_TEST_GUILD_ID are set,
 *     register the command per-guild and run the bot. /use suggestion
 *     handler returns a fake workspace list so we can verify autocomplete
 *     actually fires in the Discord client.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js'

const TOKEN = process.env.SPIKE9_TEST_BOT_TOKEN
const GUILD_ID = process.env.SPIKE9_TEST_GUILD_ID

const FAKE_WORKSPACES = [
  'claude_discord',
  'claude_discord-2',
  'eos',
  'intro-to-foundry',
  'moltis',
  'sandbox',
]

function buildUseCommand() {
  return new SlashCommandBuilder()
    .setName('use')
    .setDescription('Switch this channel to a workspace')
    .addStringOption(o =>
      o
        .setName('workspace')
        .setDescription('Workspace name')
        .setRequired(true)
        .setAutocomplete(true),
    )
}

function buildRecentCommand() {
  return new SlashCommandBuilder()
    .setName('recent')
    .setDescription('Show last N messages of current workspace')
    .addIntegerOption(o =>
      o.setName('n').setDescription('Number of messages').setMinValue(1).setMaxValue(5),
    )
}

async function staticCheck(): Promise<void> {
  console.log('Mode: STATIC (no network)\n')

  const useCmd = buildUseCommand().toJSON()
  console.log('SlashCommandBuilder /use → JSON:')
  console.log(JSON.stringify(useCmd, null, 2))
  console.log()

  const useOpt = useCmd.options?.[0] as any
  if (useOpt?.type !== 3) throw new Error(`expected type=3 (string); got ${useOpt?.type}`)
  if (useOpt.autocomplete !== true) throw new Error('autocomplete flag NOT propagated to JSON')
  if (useOpt.required !== true) throw new Error('required flag missing')
  console.log('✓ /use payload has type:3 (string) + autocomplete:true + required:true')

  const recentCmd = buildRecentCommand().toJSON()
  const recentOpt = recentCmd.options?.[0] as any
  if (recentOpt?.type !== 4) throw new Error(`expected type=4 (integer); got ${recentOpt?.type}`)
  if (recentOpt.min_value !== 1 || recentOpt.max_value !== 5) {
    throw new Error(`recent.n bounds wrong: min=${recentOpt.min_value} max=${recentOpt.max_value}`)
  }
  console.log('✓ /recent payload has type:4 (integer) + min:1 max:5')

  console.log()
  console.log('Verified discord.js 14 API surface supports:')
  console.log('  - addStringOption().setAutocomplete(true)')
  console.log('  - addIntegerOption().setMinValue(1).setMaxValue(5)')
  console.log('  - .toJSON() emits Discord-compatible application command payload')
  console.log()
  console.log('To run in LIVE mode (registers commands + connects to Discord):')
  console.log('  SPIKE9_TEST_BOT_TOKEN=... SPIKE9_TEST_GUILD_ID=... bun run bot.ts')
}

async function liveMode(token: string, guildId: string): Promise<void> {
  console.log('Mode: LIVE (will register commands + connect bot)\n')

  // Step 1: register commands per-guild (instant; global takes up to 1h)
  const commands = [buildUseCommand(), buildRecentCommand()].map(c => c.toJSON())
  const rest = new REST({ version: '10' }).setToken(token)
  console.log('Step 1: registering commands per-guild...')

  const tempClient = new Client({ intents: [GatewayIntentBits.Guilds] })
  await tempClient.login(token)
  const appId = tempClient.application?.id
  await tempClient.destroy()
  if (!appId) throw new Error('failed to read application id from bot login')

  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands })
  console.log(`✓ registered ${commands.length} commands to guild ${guildId}`)

  // Step 2: run bot, handle interactions
  console.log('Step 2: starting bot. Try /use and /recent in Discord, then Ctrl-C to stop.')
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })

  client.on('interactionCreate', async (i: Interaction) => {
    if (i.isAutocomplete()) return handleAutocomplete(i)
    if (i.isChatInputCommand()) return handleChatInput(i)
  })

  client.once('ready', c => {
    console.log(`Bot online as ${c.user.tag}`)
    console.log('Ctrl-C to stop and clean up.')
  })

  await client.login(token)

  // Cleanup on Ctrl-C: deregister guild commands
  const cleanup = async () => {
    console.log('\nCleaning up: deregistering guild commands...')
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] })
      console.log('✓ guild commands removed')
    } catch (e) {
      console.error('cleanup failed:', e)
    }
    client.destroy()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

async function handleAutocomplete(i: AutocompleteInteraction) {
  if (i.commandName !== 'use') return
  const focus = i.options.getFocused().toLowerCase()
  const matches = FAKE_WORKSPACES.filter(w => w.toLowerCase().includes(focus)).slice(0, 25)
  await i.respond(matches.map(w => ({ name: w, value: w })))
  console.log(`autocomplete: focus="${focus}" matches=${matches.length}`)
}

async function handleChatInput(i: ChatInputCommandInteraction) {
  if (i.commandName === 'use') {
    const ws = i.options.getString('workspace', true)
    await i.reply({ content: `(spike) would switch this channel to: ${ws}`, ephemeral: true })
    console.log(`/use ${ws}`)
  } else if (i.commandName === 'recent') {
    const n = i.options.getInteger('n') ?? 3
    await i.reply({ content: `(spike) would show ${n} recent messages`, ephemeral: true })
    console.log(`/recent ${n}`)
  }
}

if (TOKEN && GUILD_ID) {
  await liveMode(TOKEN, GUILD_ID)
} else {
  await staticCheck()
}
