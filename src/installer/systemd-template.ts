/**
 * Linux systemd user-unit template for the daemon.
 *
 * User units (~/.config/systemd/user/) don't need root. `systemctl --user
 * enable --now` makes them auto-start on user login.
 */

export type SystemdVars = {
  description: string
  bunPath: string
  daemonScript: string
  stderrPath: string
  stdoutPath: string
}

export function renderSystemdUnit(v: SystemdVars): string {
  return `[Unit]
Description=${v.description}
After=network.target

[Service]
Type=simple
ExecStart=${v.bunPath} run ${v.daemonScript} start
Restart=always
RestartSec=5
StandardOutput=append:${v.stdoutPath}
StandardError=append:${v.stderrPath}

[Install]
WantedBy=default.target
`
}
