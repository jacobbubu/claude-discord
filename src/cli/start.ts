/**
 * `claude-discord-bot start`
 *
 * Foreground daemon. Slice 1 stub: initializes state directory, then idles
 * until SIGTERM/SIGINT/stdin EOF. Real Discord + plugin wiring lands in
 * subsequent slices.
 */

import { runDaemon } from '../daemon/index.ts'

export function start(): void {
  void runDaemon()
}
