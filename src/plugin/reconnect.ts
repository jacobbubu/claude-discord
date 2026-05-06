/**
 * Exponential backoff for plugin's daemon socket reconnect.
 * Sequence: 300ms → 600ms → 1.2s → 2.4s → 5s (cap), repeats at cap.
 */

const SEQUENCE_MS = [300, 600, 1_200, 2_400, 5_000] as const
const CAP_MS = 5_000

export function backoffDelayMs(attempt: number): number {
  if (attempt < SEQUENCE_MS.length) return SEQUENCE_MS[attempt]!
  return CAP_MS
}

export function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
