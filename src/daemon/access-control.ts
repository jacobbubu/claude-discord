/**
 * access.json — sender-side access control (DM allowlist + pairing + guild
 * channel opt-in + mention detection).
 *
 * Ported from upstream's server.ts:104-318 with light cleanup and zod
 * validation. The state machine semantics are 1:1 with upstream:
 *   - dmPolicy: pairing | allowlist | disabled
 *   - pending: 6-hex codes, max 3 in flight, 1h expiry, 2 reply attempts
 *
 * Hot read on every inbound message, atomic write on mutation.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { z } from 'zod'
import { atomicWrite } from '../shared/atomic-write.ts'
import { log } from '../shared/logger.ts'

export const PendingEntrySchema = z.object({
  senderId: z.string(),
  chatId: z.string(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  replies: z.number().int().default(1),
})
export type PendingEntry = z.infer<typeof PendingEntrySchema>

export const GroupPolicySchema = z.object({
  requireMention: z.boolean().default(true),
  allowFrom: z.array(z.string()).default([]),
})
export type GroupPolicy = z.infer<typeof GroupPolicySchema>

export const AccessSchema = z.object({
  dmPolicy: z.enum(['pairing', 'allowlist', 'disabled']).default('pairing'),
  // Architecture deltas §14: guild channels default to 'open' (any channel
  // bot can read passes the opt-in gate). 'opt-in' restores prior behavior
  // (channel must be in `groups`); 'disabled' drops all guild channels.
  groupPolicy: z.enum(['open', 'opt-in', 'disabled']).default('open'),
  allowFrom: z.array(z.string()).default([]),
  // Architecture deltas §17: defaults applied to channels NOT in `groups`
  // when groupPolicy==='open'. Lets users opt out of "must @ bot" without
  // touching every new channel. Ignored when groupPolicy is 'opt-in'/'disabled'.
  groupPolicyDefaults: GroupPolicySchema.optional(),
  groups: z.record(z.string(), GroupPolicySchema).default({}),
  pending: z.record(z.string(), PendingEntrySchema).default({}),
  mentionPatterns: z.array(z.string()).optional(),
  ackReaction: z.string().optional(),
  replyToMode: z.enum(['off', 'first', 'all']).optional(),
  textChunkLimit: z.number().int().optional(),
  chunkMode: z.enum(['length', 'newline']).optional(),
})
export type Access = z.infer<typeof AccessSchema>

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    groupPolicy: 'open',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

export function readAccessFile(path: string): Access {
  if (!existsSync(path)) return defaultAccess()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const parsed = AccessSchema.safeParse(raw)
    if (!parsed.success) {
      const corrupt = `${path}.corrupt-${Date.now()}`
      log.warn(`access.json schema invalid; moving to ${corrupt}`)
      try {
        renameSync(path, corrupt)
      } catch {}
      return defaultAccess()
    }
    return parsed.data
  } catch {
    const corrupt = `${path}.corrupt-${Date.now()}`
    log.warn(`access.json parse failed; moving to ${corrupt}`)
    try {
      renameSync(path, corrupt)
    } catch {}
    return defaultAccess()
  }
}

export function writeAccessFile(path: string, a: Partial<Access>): void {
  // Merge with defaults so callers can pass partial configs (e.g. test
  // fixtures that don't care about every new field). Keeps on-disk shape
  // consistent with what readAccessFile would parse from a minimal file.
  const full = { ...defaultAccess(), ...a }
  atomicWrite(path, JSON.stringify(full, null, 2) + '\n', 0o600)
}

export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * Generate 6-hex pairing code. Matches upstream's `randomBytes(3).toString('hex')`.
 */
export function generatePairingCode(): string {
  return randomBytes(3).toString('hex')
}

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export type GateInput = {
  isDM: boolean
  senderId: string
  channelId: string
  /** For DM gate: the actual DM channel id (== channelId). */
  dmChannelId: string
  /** For guild messages: parent channel id when in a thread, else channelId. */
  guildChannelKey: string
  /** Whether the message is treated as mentioning the bot. */
  isMentioned: boolean
}

/**
 * Pure gate decision: given access + the inbound's classification, returns
 * what the daemon should do. Caller handles side effects (replying with
 * pairing code, mutating access on resend, etc.).
 *
 * For pairing-policy DMs that need a new code, the function ALSO has a
 * side effect: mutates `a.pending` (insert) and `a.pending[code].replies`
 * (increment on resend). Caller is responsible for persisting `a`.
 */
export function gate(a: Access, input: GateInput, now = Date.now()): GateResult {
  if (a.dmPolicy === 'disabled') return { action: 'drop' }

  if (input.isDM) {
    if (a.allowFrom.includes(input.senderId)) return { action: 'deliver' }
    if (a.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing policy — check existing pending for this sender
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.senderId === input.senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(a.pending).length >= 3) return { action: 'drop' }

    const code = generatePairingCode()
    a.pending[code] = {
      senderId: input.senderId,
      chatId: input.dmChannelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    return { action: 'pair', code, isResend: false }
  }

  // Guild channel — check groupPolicy then per-channel override.
  if (a.groupPolicy === 'disabled') return { action: 'drop' }

  const explicit = a.groups[input.guildChannelKey]
  // For 'open': unknown channels fall back to groupPolicyDefaults (deltas
  // §17) if set, else the safe default {requireMention: true, allowFrom: []}.
  // User can also override per-channel via `groups[<id>]`.
  // For 'opt-in': unknown channels are dropped (legacy strict behavior).
  const policy =
    explicit ??
    (a.groupPolicy === 'open'
      ? a.groupPolicyDefaults ?? { requireMention: true, allowFrom: [] }
      : null)
  if (!policy) return { action: 'drop' }

  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(input.senderId)) {
    return { action: 'drop' }
  }
  if ((policy.requireMention ?? true) && !input.isMentioned) {
    return { action: 'drop' }
  }
  return { action: 'deliver' }
}

/**
 * Test whether `text` matches any of `mentionPatterns` (case-insensitive
 * regex). Bad regex strings are silently skipped.
 */
export function matchesMentionPattern(text: string, patterns?: string[]): boolean {
  if (!patterns) return false
  for (const pat of patterns) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      /* ignore bad regex */
    }
  }
  return false
}
