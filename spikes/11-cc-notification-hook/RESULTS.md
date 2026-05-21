# Spike 11 — CC Notification hook payload discovery

**Goal:** find out which events trigger CC's `Notification` hook and what
payload each carries, especially when CC hits Anthropic API rate-limits
mid-tool-call (so we can surface that condition into Discord via daemon).

**Observation window:** 2026-05-19 → 2026-05-21
**Issue:** #137

## Background

A Discord-driven turn can fail when CC's API request to Anthropic gets
rate-limited (HTTP 429 "Server is temporarily limiting requests"). This
happens *after* CC calls into our plugin but *before* the tool executes —
so our plugin doesn't see it. The Discord user is left waiting silently.

CC ships a `Notification` hook event whose payload semantics aren't
documented publicly. cmux uses it for desktop alerts on idle / permission
events. Whether it also fires on API errors / rate-limit is the open
question.

## Setup

- `dump-notification.ts` — appends every hook invocation (timestamp, ppid,
  cwd, raw stdin, parsed JSON, env subset) as NDJSON to
  `/tmp/cc-notification-spike11.log`
- `~/.claude/settings.json` `hooks.Notification` points to the dumper
- Spike does not touch the daemon — pure observation

## Findings

Observation window 2026-05-19 → 2026-05-21, **265 real hook invocations**
captured (plus 1 manual sanity line). Full capture committed alongside
this file as `cc-notification-events.ndjson`.

### Payload shape

Every `Notification` hook invocation delivers this JSON on stdin:

```json
{
  "session_id": "090fc047-9e37-45e2-9721-528ffdcabe25",
  "transcript_path": "/Users/rongshen/.claude/projects/.../<session_id>.jsonl",
  "cwd": "/Users/rongshen/vibe-coding/claude_discord",
  "hook_event_name": "Notification",
  "message": "Claude is waiting for your input",
  "notification_type": "idle_prompt"
}
```

Keys are stable across all 265 events: `session_id`, `transcript_path`,
`cwd`, `hook_event_name`, `message`, `notification_type`.

### Event types — only two ever fired

| `notification_type`  | `message`                        | count |
| -------------------- | -------------------------------- | ----- |
| `idle_prompt`        | Claude is waiting for your input | 261   |
| `permission_prompt`  | Claude needs your permission     | 4     |

**No rate-limit / API-error / network-error notification type appeared.**

### Negative evidence for the 429 case

This is the decisive result. During the *same* observation window the
daemon log (`~/.claude/channels/discord/daemon.log`) recorded numerous
`typing-heartbeat: max 300000ms reached ... CC may be stuck` events — i.e.
turns that stalled for the full 5-minute cap, the observable symptom of CC
being throttled / blocked on the Anthropic API. **None of those stalls
produced any `Notification` hook event.** The hook fired only
`idle_prompt` (after a turn finishes and CC awaits input) and
`permission_prompt`.

This matches CC's hook model: `Notification` is a *"needs your attention"*
UX channel (idle / permission), **not** an error or telemetry channel. An
API 429 mid-turn is handled inside CC (internal retry) and emits no
`Notification`. The only hook event that eventually follows a
failed/abandoned turn is an ordinary `idle_prompt` — indistinguishable
from a normal completion.

## Conclusion / next step

**The CC `Notification` hook cannot be used to surface Anthropic API
rate-limits into Discord. Negative result.**

Recommended path:

1. **Do not build a `notification-hook.ts` daemon handler for 429
   detection** — the hook does not carry the signal.
2. **The 429 symptom is already covered by #136**: the typing-heartbeat
   safety cap posts a "⚠️ 可能卡住或被限流" notice to the channel after 5
   minutes of no reply. Symptom-based and coarse (5-min latency, generic
   wording) but reliable and CC-version-independent.
3. **For faster / 429-specific detection**, the only signal-bearing source
   is the session transcript. The `Notification` payload exposes
   `transcript_path`; the JSONL there records the actual API error. A
   daemon component could capture the transcript path (from any
   notification for a given `cwd`) and tail it for 429 records. This is a
   real but heavier follow-up — open a separate issue if explicit
   "被 Anthropic 限流" wording / sub-5-min detection is wanted.
4. **Cleanup**: the spike hook in `~/.claude/settings.json`
   (`hooks.Notification` → `dump-notification.ts`) can be removed now that
   observation is complete — it spawns a `bun` subprocess on every CC
   notification.

## How to re-read the raw capture

```bash
# committed snapshot:
cat spikes/11-cc-notification-hook/cc-notification-events.ndjson \
  | jq -c '.payload_parsed | {ts: .session_id, notification_type}'
```
