/**
 * Architecture deltas §28: third line of defense against orphan plugin
 * processes.
 *
 * The plugin already exits on stdio close (mcp-server.ts `transport.onclose`)
 * and on raw stdin end/close (index.ts). This catches the residual case where
 * those signals don't fire: when the parent CC dies, the orphaned plugin is
 * reparented to launchd/init (pid 1 on macOS/Linux), so `process.ppid`
 * changes. Polling for that change is more robust than `kill(originalPpid, 0)`
 * — the latter is fooled if `originalPpid` gets reused by an unrelated process.
 */

export type OrphanWatcherOpts = {
  /** ppid captured at plugin startup (the real parent CC's pid). */
  originalPpid: number
  /** Current ppid getter. Injectable for tests; defaults to `() => process.ppid`. */
  getPpid?: () => number
  /** Called when the parent is detected gone. Defaults to `() => process.exit(0)`. */
  onOrphan?: () => void
  /** Poll interval in ms. Defaults to 5000. */
  intervalMs?: number
}

export function startOrphanWatcher(opts: OrphanWatcherOpts): { stop: () => void } {
  const getPpid = opts.getPpid ?? (() => process.ppid)
  const onOrphan = opts.onOrphan ?? (() => process.exit(0))
  const intervalMs = opts.intervalMs ?? 5_000

  let fired = false
  const timer = setInterval(() => {
    if (fired) return
    if (getPpid() !== opts.originalPpid) {
      fired = true
      onOrphan()
    }
  }, intervalMs)
  // Don't let this poll keep the process alive on its own.
  ;(timer as unknown as { unref?: () => void }).unref?.()

  return {
    stop() {
      clearInterval(timer)
    },
  }
}
