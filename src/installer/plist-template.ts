/**
 * macOS LaunchAgent plist template for the daemon.
 *
 * Spike #8 verified that no signing is required for user-domain LaunchAgents.
 * Spike #7 verified that the daemon's mkdir/chmod handles umask defeating.
 */

export type PlistVars = {
  label: string
  bunPath: string
  daemonScript: string
  home: string
  stderrPath: string
  stdoutPath: string
}

export function renderPlist(v: PlistVars): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${v.label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${v.bunPath}</string>
        <string>run</string>
        <string>${v.daemonScript}</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${v.home}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>${v.stderrPath}</string>
    <key>StandardOutPath</key>
    <string>${v.stdoutPath}</string>
</dict>
</plist>
`
}
