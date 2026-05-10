/**
 * Slash command registration + interaction handling.
 *
 * Slice 4 implements: /use, /last, /list, /which, /recent.
 * /status lands in slice 5 alongside permission Q&A polish.
 *
 * Auth: every command checks interaction.user.id against access.allowFrom;
 * unauthorized requests get a quiet ephemeral 'Not authorized.' reply.
 */

import {
  ActivityType,
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  InteractionContextType,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js'

// Make commands usable in guild text channels, bot DMs, and group/private DMs.
const ALL_CONTEXTS = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
] as const
import { readAccessFile } from './access-control.ts'
import type { DiscordGateway } from './discord-gateway.ts'
import type { WorkspaceRegistry } from './registry.ts'
import { shouldAutoDisplay, type RingBufferMap } from './ring-buffer.ts'
import type { RoutingTable } from './routing.ts'
import { log } from '../shared/logger.ts'
import type { Paths } from '../shared/paths.ts'

const RECENT_DEFAULT = 3
const RECENT_MAX = 5

export type SlashDeps = {
  gateway: DiscordGateway
  registry: WorkspaceRegistry
  routing: RoutingTable
  ringBuffers: RingBufferMap
  paths: Paths
  /** Optional button click intercept (used for permission Q&A buttons). */
  buttonIntercept?: (i: import('discord.js').ButtonInteraction) => Promise<boolean>
}

export function buildCommandList() {
  return [
    new SlashCommandBuilder()
      .setName('use')
      .setDescription('Switch this channel to a workspace')
      .setContexts(...ALL_CONTEXTS)
      .addStringOption(o =>
        o
          .setName('workspace')
          .setDescription('Workspace name')
          .setRequired(true)
          .setAutocomplete(true),
      ),
    new SlashCommandBuilder()
      .setName('last')
      .setDescription('Switch back to previous workspace')
      .setContexts(...ALL_CONTEXTS),
    new SlashCommandBuilder()
      .setName('list')
      .setDescription('List active workspaces (most recent first)')
      .setContexts(...ALL_CONTEXTS),
    new SlashCommandBuilder()
      .setName('which')
      .setDescription("Show this channel's current workspace binding")
      .setContexts(...ALL_CONTEXTS),
    new SlashCommandBuilder()
      .setName('recent')
      .setDescription('Show last N messages of current workspace')
      .setContexts(...ALL_CONTEXTS)
      .addIntegerOption(o =>
        o
          .setName('n')
          .setDescription(`Number of messages (default ${RECENT_DEFAULT}, max ${RECENT_MAX})`)
          .setMinValue(1)
          .setMaxValue(RECENT_MAX),
      ),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show online status of a workspace (default: this channel\'s binding)')
      .setContexts(...ALL_CONTEXTS)
      .addStringOption(o =>
        o
          .setName('workspace')
          .setDescription('Workspace name (default: current channel binding)')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  ].map(c => c.toJSON())
}

export async function registerSlashCommands(client: Client, token: string): Promise<void> {
  const appId = client.application?.id
  if (!appId) {
    log.warn('slash: client.application.id unavailable; skipping registration')
    return
  }
  const rest = new REST({ version: '10' }).setToken(token)
  const commands = buildCommandList()

  // Global registration — required for commands to appear in bot DMs (the
  // contexts list includes BotDM/PrivateChannel). Discord propagates global
  // commands lazily (~1 hour to all clients), so we ALSO register per-guild
  // below for instant availability in guild text channels.
  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands })
    log.info(`slash: registered ${commands.length} commands globally (DM-eligible; ~1h propagation)`)
  } catch (e) {
    log.warn(`slash: global register failed: ${e}`)
  }

  // Per-guild registration for instant propagation in guild contexts.
  for (const guildId of client.guilds.cache.keys()) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands })
      log.info(`slash: registered ${commands.length} commands to guild ${guildId}`)
    } catch (e) {
      log.warn(`slash: register to guild ${guildId} failed: ${e}`)
    }
  }
}

export function attachInteractionHandler(deps: SlashDeps): (i: Interaction) => void {
  return i => {
    void handle(deps, i).catch(e => log.warn(`slash interaction error: ${e}`))
  }
}

async function handle(deps: SlashDeps, i: Interaction): Promise<void> {
  if (i.isAutocomplete()) return handleAutocomplete(deps, i)
  if (i.isButton()) {
    if (deps.buttonIntercept && (await deps.buttonIntercept(i))) return
    return
  }
  if (!i.isChatInputCommand()) return
  if (!isAuthorized(deps, i.user.id)) {
    await i.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
    return
  }
  switch (i.commandName) {
    case 'use':
      return handleUse(deps, i)
    case 'last':
      return handleLast(deps, i)
    case 'list':
      return handleList(deps, i)
    case 'status':
      return handleStatusCmd(deps, i)
    case 'which':
      return handleWhich(deps, i)
    case 'recent':
      return handleRecent(deps, i)
  }
}

function isAuthorized(deps: SlashDeps, userId: string): boolean {
  return readAccessFile(deps.paths.accessFile).allowFrom.includes(userId)
}

async function handleAutocomplete(deps: SlashDeps, i: AutocompleteInteraction): Promise<void> {
  if (i.commandName !== 'use' && i.commandName !== 'status') return await i.respond([])
  const focus = i.options.getFocused().toLowerCase()
  const matches = deps.registry
    .list()
    .map(c => c.workspace ?? '')
    .filter(w => w && w.toLowerCase().includes(focus))
    .slice(0, 25)
  await i.respond(matches.map(w => ({ name: w, value: w }))).catch(() => {})
}

async function handleUse(deps: SlashDeps, i: ChatInputCommandInteraction): Promise<void> {
  const workspace = i.options.getString('workspace', true)
  if (!deps.registry.has(workspace)) {
    await i.reply({
      content: `workspace '${workspace}' is not online. start CC for it first.`,
      ephemeral: true,
    })
    return
  }

  const channelId = i.channelId
  deps.routing.set(channelId, workspace, Date.now())
  await applyTopic(deps, channelId, workspace)
  applyPresence(deps, workspace)
  await i.reply(`✅ switched to ${workspace}`)

  // Conditional auto-display of /recent context (FR-8.3)
  const buf = deps.ringBuffers.get(workspace)
  if (buf && shouldAutoDisplay(buf, channelId)) {
    const recent = buf.recent(RECENT_DEFAULT)
    if (recent.length > 0) {
      await deps.gateway.send(channelId, formatRecent(recent, workspace))
    }
  }
}

async function handleLast(deps: SlashDeps, i: ChatInputCommandInteraction): Promise<void> {
  const channelId = i.channelId
  const route = deps.routing.get(channelId)
  const prev = route?.history[0]
  if (!prev) {
    await i.reply({ content: 'no previous workspace to switch to.', ephemeral: true })
    return
  }
  if (!deps.registry.has(prev)) {
    await i.reply({
      content: `previous workspace '${prev}' is offline.`,
      ephemeral: true,
    })
    return
  }
  deps.routing.set(channelId, prev, Date.now())
  await applyTopic(deps, channelId, prev)
  applyPresence(deps, prev)
  await i.reply(`✅ switched back to ${prev}`)
}

async function handleList(deps: SlashDeps, i: ChatInputCommandInteraction): Promise<void> {
  const conns = deps.registry.list()
  if (conns.length === 0) {
    await i.reply({ content: 'no active workspaces.', ephemeral: true })
    return
  }
  // Most-recently-active first
  const sorted = [...conns].sort((a, b) => b.lastActivityTs - a.lastActivityTs)
  const lines = sorted.map(c => {
    const ts = Math.floor(c.lastActivityTs / 1000)
    return `• \`${c.workspace}\` (\`${c.agent}\`) — last activity <t:${ts}:R>`
  })
  await i.reply({ content: lines.join('\n'), ephemeral: true })
}

async function handleStatusCmd(
  deps: SlashDeps,
  i: ChatInputCommandInteraction,
): Promise<void> {
  const explicit = i.options.getString('workspace')
  let target: string | null = explicit
  if (!target) {
    const route = deps.routing.get(i.channelId)
    target = route?.workspace ?? null
  }
  if (!target) {
    await i.reply({
      content: 'no workspace specified and this channel has no binding.',
      ephemeral: true,
    })
    return
  }
  const conn = deps.registry.get(target)
  if (!conn) {
    await i.reply({ content: `\`${target}\` — offline`, ephemeral: true })
    return
  }
  const ts = Math.floor(conn.lastActivityTs / 1000)
  await i.reply({
    content: `\`${target}\` — online (\`${conn.agent}\`), last activity <t:${ts}:R>`,
    ephemeral: true,
  })
}

async function handleWhich(deps: SlashDeps, i: ChatInputCommandInteraction): Promise<void> {
  const route = deps.routing.get(i.channelId)
  if (!route) {
    await i.reply({ content: 'this channel has no workspace bound.', ephemeral: true })
    return
  }
  const conn = deps.registry.get(route.workspace)
  const status = conn ? 'online' : 'offline'
  const switched = Math.floor(route.switched_at / 1000)
  await i.reply({
    content: `bound to \`${route.workspace}\` — ${status}, switched <t:${switched}:R>`,
    ephemeral: true,
  })
}

async function handleRecent(deps: SlashDeps, i: ChatInputCommandInteraction): Promise<void> {
  const route = deps.routing.get(i.channelId)
  if (!route) {
    await i.reply({ content: 'this channel has no workspace bound.', ephemeral: true })
    return
  }
  const buf = deps.ringBuffers.get(route.workspace)
  if (!buf || buf.isEmpty()) {
    await i.reply({ content: '(no recent activity)', ephemeral: true })
    return
  }
  const n = i.options.getInteger('n') ?? RECENT_DEFAULT
  const limited = Math.min(Math.max(1, n), RECENT_MAX)
  const recent = buf.recent(limited)
  await i.reply({ content: formatRecent(recent, route.workspace), ephemeral: true })
}

function formatRecent(
  entries: { ts: number; channelId: string; direction: 'in' | 'out'; textPreview: string }[],
  workspace: string,
): string {
  const lines = entries.map(e => {
    const t = Math.floor(e.ts / 1000)
    const arrow = e.direction === 'in' ? '←' : '→'
    return `[<t:${t}:t> · <t:${t}:R>] ${arrow} ${e.textPreview}`
  })
  return `**${workspace}** recent ${entries.length}:\n${lines.join('\n')}`
}

async function applyTopic(deps: SlashDeps, channelId: string, workspace: string): Promise<void> {
  try {
    const ch = await deps.gateway.client.channels.fetch(channelId)
    if (ch && ch instanceof TextChannel) {
      await ch.setTopic(`[claude-discord] ${workspace}`)
    }
  } catch (e) {
    // DM channels and partial channels can't have topics; ignore quietly
    log.debug(`applyTopic: ${e}`)
  }
}

/**
 * Reflect current routing in the bot's global Discord presence (custom status).
 * DM has no channel-topic UI, so this is the only "always-visible" indicator
 * across guilds/DMs of which workspace the bot is currently routed to.
 *
 * Architecture deltas §12. Single global activity — only the most recent
 * `/use` / `/last` is reflected, intentionally.
 */
function applyPresence(deps: SlashDeps, workspace: string): void {
  try {
    deps.gateway.client.user?.setPresence({
      activities: [
        { name: workspace, type: ActivityType.Custom, state: workspace },
      ],
      status: 'online',
    })
  } catch (e) {
    log.debug(`applyPresence: ${e}`)
  }
}

// Silence unused-warning for ApplicationCommandOptionType (some lint configs)
void ApplicationCommandOptionType
