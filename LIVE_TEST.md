# Live e2e Test Checklist

This document walks through the **full live verification** of claude-discord
against a real Discord bot + real Claude Code. None of this is automated by
CI — it touches your actual Discord application and registers slash commands
to its guilds, so you run it deliberately.

If you just want to check that the daemon can log in to Discord, that's
covered by the lightweight smoke run we did during slice 6 — see the
`Acknowledgements` of progress in commit history. This document is for the
**full chain**: install → configure → pair → DM → CC tool reply round-trip.

## 0. Prerequisites

- Bun 1.x installed
- `bun install` already run in repo root
- macOS or Linux
- A Discord account
- About 15 minutes

## 1. Create a Discord bot application

> **Tip**: use a *fresh* test bot for this — the live test will register six
> slash commands (`/use /last /list /which /recent /status`) to all guilds the
> bot is in, which would clutter your existing bot's UI.

1. Open https://discord.com/developers/applications
2. **New Application** → name it (e.g. `claude-discord-test`)
3. Sidebar → **Bot** → give the bot a username (e.g. `claude-test`)
4. Scroll to **Privileged Gateway Intents** → enable **Message Content Intent**
   (without this, the bot receives messages with empty content — same upstream
   gotcha)
5. Scroll up to **Token** → **Reset Token** → copy the token (it's only
   shown once)

## 2. Invite the bot to a test server

Discord requires the bot and you to share a server before DMs work.

1. Sidebar → **OAuth2** → **URL Generator**
2. Scope: ✅ `bot`
3. Bot Permissions:
   - ✅ View Channels
   - ✅ Send Messages
   - ✅ Send Messages in Threads
   - ✅ Read Message History
   - ✅ Attach Files
   - ✅ Add Reactions
   - ✅ Manage Channels (so `/use` can rewrite channel topic)
4. Integration Type: `Guild Install`
5. Copy the generated URL → open in browser → add the bot to a test server

## 3. Configure claude-discord-bot

```bash
cd /path/to/claude-discord
bun run src/cli/index.ts configure <paste-token-here>
```

Verify:

```bash
ls -la ~/.claude/channels/discord/.env       # mode -rw------- (600)
ls -la ~/.claude/channels/discord/            # mode drwx------ (700)
```

## 4. Run the daemon (foreground for first test)

```bash
bun run src/cli/index.ts start
```

Expected stderr in the first ~2 seconds:

```
[info] daemon started — state dir: ~/.claude/channels/discord
[info] pid=NNNNN uid=501
[info] socket server listening on .../daemon.sock
[info] discord gateway connected as claude-test#NNNN
[info] slash: registered 6 commands to guild <id>
```

Once you see `slash: registered 6 commands to guild ...`, **switch to your
Discord client** and verify in any channel of that guild:

- Type `/` → autocomplete should show `use / last / list / which / recent / status`

Leave the daemon running.

## 5. Configure & start a Claude Code session

In a **new terminal**:

```bash
cd /path/to/some-project           # any project dir; the workspace name = basename
claude                              # CC starts; reads ./.mcp.json if present
```

If your project has a `.mcp.json` pointing at our plugin (see
`claude-discord/.mcp.json` for a template), CC will spawn the plugin
automatically. Otherwise pass the plugin via flags:

```bash
claude --mcp-config /path/to/claude-discord/.mcp.json
```

In the daemon's terminal you should now see:

```
[info] workspace registered: <project-basename> (agent=claude-code, pid=NNNNN)
```

## 6. Pair your Discord identity

From your Discord client, **DM the bot** any message (e.g. `hello`).

The bot should reply with:

```
Pairing required — run in your terminal:

claude-discord-bot pair <6-hex-code>
```

In another terminal:

```bash
bun run src/cli/index.ts pair <6-hex-code>
```

Expected output:

```
paired sender NNNNNNNNNNNNNNNNNN (was code XXXXXX)
```

Within ~5 seconds the bot should DM you `Paired! Say hi to Claude.`

(Internally: `claude-discord-bot pair` updates `access.json` allowFrom and
writes `approved/<senderId>` containing your DM channel id; the daemon's
approval-watcher polls every 5s, sees the file, sends the confirmation, and
deletes the file.)

## 7. Bind the DM channel to a workspace

Discord client, in your DM with the bot:

```
/use <project-basename>
```

Expected reply: `✅ switched to <project-basename>`. The DM "channel topic"
won't change for DMs (Discord doesn't allow setting topics on DM channels —
that's a guild-channel thing).

Now run `/list` and `/which` to verify routing state.

## 8. Test the round-trip

DM the bot:

```
hello, what files are in this project?
```

In CC's terminal, you should see Claude receive the message (rendered as
`<channel source="discord" ...>`) and start responding. Claude will likely
call `reply` to answer in Discord. You should see the reply land in your DM.

Claude may also use `react` (e.g. ✅ ack), `edit_message` (for streaming
progress), or `download_attachment` if you DM an image.

## 9. Test slash commands

In Discord (DM or in the test server's channel where the bot is):

| Command | Expected |
| --- | --- |
| `/list` | List of active workspaces, time-reverse |
| `/which` | Current channel binding |
| `/use <other>` | Switch (if another CC session is running for that workspace) |
| `/last` | Switch back to previous |
| `/recent 3` | Last 3 messages of current workspace |
| `/status` | Online/offline + last activity time |

## 10. Test pairing flow with a second user (optional)

Have a friend (or a second Discord account) DM the bot. They should get a
fresh 6-hex code. Either approve (`pair <code>`) or reject (`deny <code>`)
their request. Verify access.json reflects the change.

## 11. Test access policies (optional)

```bash
bun run src/cli/index.ts policy allowlist
# Now strangers DM the bot → silently dropped, no pairing reply

bun run src/cli/index.ts policy disabled
# Now everyone — including allowFrom — gets dropped silently
```

Don't forget to `policy pairing` or `policy allowlist` to restore.

## 12. Test guild channel opt-in (optional)

```bash
# Get the test channel id (right-click channel in Discord → Copy Channel ID;
# need Developer Mode in User Settings → Advanced first)
bun run src/cli/index.ts group add <channel-id>             # require @mention
bun run src/cli/index.ts group add <channel-id> --no-mention # respond to every message

# Test in that channel
@claude-test hello
```

## 13. Shut down + uninstall (optional cleanup)

```bash
# Foreground: Ctrl-C the daemon process

# If you ran `install` to register as a service:
bun run src/cli/index.ts uninstall

# Optionally clean state:
bun run src/cli/index.ts reset --all --including-token
```

## 14. Deregister slash commands (Discord-side cleanup)

Slash commands registered to a guild **persist** even after the daemon stops.
The cleanest way to remove them is to delete the bot application from the
Discord Developer Portal (which removes everything atomically), or to write
a small script that calls `Routes.applicationGuildCommands(appId, guildId)`
with an empty array.

For testing convenience, the daemon does **not** auto-deregister on
shutdown — restart cycles would otherwise re-register every time.

## What's verified after this checklist

- ✅ Discord bot creation + intents
- ✅ Token storage at correct mode
- ✅ Daemon login to Discord gateway
- ✅ Slash command registration per-guild
- ✅ Plugin spawn via MCP `.mcp.json`
- ✅ Workspace registration
- ✅ Pairing flow (DM → code → CLI pair → IPC file → "Paired!" reply)
- ✅ Inbound message routing (Discord DM → daemon → plugin → CC)
- ✅ Outbound tool calls (CC → plugin → daemon → discord.js → Discord)
- ✅ Slash commands functional (`/use` `/list` `/which` `/last` `/recent` `/status`)
- ✅ Access policy switching (pairing / allowlist / disabled)
- ✅ Guild channel opt-in + mention detection

Anything that fails this checklist is a bug — open an issue with the failing
step number and the daemon stderr around the failure.
