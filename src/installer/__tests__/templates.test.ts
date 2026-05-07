import { describe, expect, it } from 'vitest'
import { renderPlist } from '../plist-template.ts'
import { renderSystemdUnit } from '../systemd-template.ts'

describe('renderPlist', () => {
  const v = {
    label: 'com.test.bot',
    bunPath: '/opt/homebrew/bin/bun',
    daemonScript: '/x/cli.ts',
    home: '/Users/test',
    stderrPath: '/Users/test/.claude/channels/discord/daemon.err.log',
    stdoutPath: '/Users/test/.claude/channels/discord/daemon.out.log',
  }

  it('substitutes all placeholders', () => {
    const out = renderPlist(v)
    expect(out).not.toMatch(/\$\{/)
    expect(out).toContain('com.test.bot')
    expect(out).toContain('/opt/homebrew/bin/bun')
    expect(out).toContain('/x/cli.ts')
    expect(out).toContain('/Users/test')
  })

  it('contains required launchd keys', () => {
    const out = renderPlist(v)
    expect(out).toContain('<key>Label</key>')
    expect(out).toContain('<key>ProgramArguments</key>')
    expect(out).toContain('<key>RunAtLoad</key>')
    expect(out).toContain('<key>KeepAlive</key>')
    expect(out).toContain('<key>StandardErrorPath</key>')
  })
})

describe('renderSystemdUnit', () => {
  const v = {
    description: 'claude-discord-bot daemon',
    bunPath: '/usr/bin/bun',
    daemonScript: '/x/cli.ts',
    stderrPath: '/home/test/.claude/channels/discord/daemon.err.log',
    stdoutPath: '/home/test/.claude/channels/discord/daemon.out.log',
  }

  it('includes ExecStart and Restart=always', () => {
    const out = renderSystemdUnit(v)
    expect(out).toContain('ExecStart=/usr/bin/bun run /x/cli.ts')
    expect(out).toContain('Restart=always')
    expect(out).toContain('[Install]')
    expect(out).toContain('WantedBy=default.target')
  })

  it('substitutes all placeholders', () => {
    const out = renderSystemdUnit(v)
    expect(out).not.toMatch(/\$\{/)
  })
})
