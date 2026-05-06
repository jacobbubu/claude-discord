# installer/

Daemon system-service installer (launchd on macOS, systemd on Linux).

**Slice 1 status**: empty stub. Spike #7 + #8 validated the launchd
plist + bootstrap path; production module lands in **Slice 5**.

When implemented:

- `plan.ts` — platform-aware install plan generation (artifacts + actions +
  rollback steps)
- `apply-launchd.ts` — macOS-specific apply: write plist, `launchctl bootstrap`
- `apply-systemd.ts` — Linux: write user unit, `systemctl --user enable --now`
- `plist-template.ts` — string template for the LaunchAgent plist
- (No-op `verify` step that confirms service is running after apply)

See `_bmad-output/planning-artifacts/architecture.md` §10. Reference
implementation pattern: openclaw `dist/daemon-install-plan.shared-*.js` +
`daemon-install-helpers-*.js`.
