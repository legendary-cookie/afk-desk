# Recovered audit verification

Date: 2026-10-14 (Asia/Singapore).
Audited source: `3004381c3585bb68c5e480f48ae56d07ae40394d`, equal to fetched `origin/main` when verified.

The recovered work consisted of three read-only audits. The resulting deliverables are [desktop](2026-10-14-desktop.md), [mobile](2026-10-14-mobile.md), and [CI/dependencies/docs](2026-10-14-hygiene.md). This publication changes documentation only. Findings remain open follow-up work; completing an audit is not fixing every issue it identifies.

## Fresh checks

Windows host: Node 26.8.1, npm 11.19.0. Commands below use npm's CLI through Node because of the host's npm shim. `npm` denotes `node <node-install>/node_modules/npm/bin/npm-cli.js` in actual invocations.

| Working directory | Command | Exit | Observation |
| --- | --- | --- | --- |
| desktop | `npm ci --no-audit --no-fund` | 0 | 478 packages; Mineflayer 4.37.1 and physics 1.11.1 patches applied. |
| mobile | `npm ci --no-audit --no-fund` | 0 | 1,060 packages; npm warned about unapproved native-package install scripts. This is not native installation proof. |
| mobile/nodejs-assets/nodejs-project | `npm ci --no-audit --no-fund` | 0 | 148 packages; both versioned patches applied. |
| desktop | `node --test` | 0 | 222 pass, 0 fail, about 130 seconds; includes local desktop/mobile-engine protocol matrices. |
| mobile | `npm test -- --runInBand` | 0 | 32 pass across five suites, 0 fail. |
| mobile/nodejs-assets/nodejs-project | `node --test` | 0 | 28 pass, 0 fail. |
| mobile | `node node_modules/typescript/bin/tsc --noEmit` | 0 | No reported type errors. |
| mobile | `node node_modules/eslint/bin/eslint.js . --quiet` | 0 | No reported lint errors. |
| desktop | `python test/ui-smoke.py` with installed Edge via `AFK_DESK_TEST_BROWSER` | 0 | Fixture UI flows and POV pass at desktop/compact/narrow layouts; screenshot visually reviewed. Bridge/world are synthetic; no live bot action. |
| desktop | `node node_modules/electron/cli.js . --smoke-test` | 0 | `AFK_DESK_SMOKE_PASS` reports version 0.10.0-beta.9, accountCount 0, supportedVersions 28, bridge true. Source Electron uses temporary userData and disables startup connections. |
| desktop | `npm audit --omit=dev --json` | 1 | 3 affected packages: 2 high, 1 moderate. |
| mobile | `npm audit --omit=dev --json` | 1 | 36 affected packages: 1 critical, 29 high, 6 moderate; package-graph counts include framework tooling. |
| mobile/nodejs-assets/nodejs-project | `npm audit --omit=dev --json` | 1 | 1 moderate affected package. |
| Each package root | `npm outdated --json` | 1 | Updates offered; no upgrades made. |
| repository | `gh api repos/legendary-cookie/afk-desk/releases` | 0 | beta.9 Windows release exists; Android 0.9.2 assets exist. |
| repository | `git diff --check` | 0 | No whitespace errors in reports. |

Optional native install scripts for electron-winstaller/raknet-native/nodejs-mobile were flagged by npm's host install policy. The tests and source Electron smoke succeeded using their exercised paths; those warnings are not waived or converted to packaging passes. No dependency policy changed.

## Additional disposable probes

No network was used by these probes. Fake inputs and temporary output directories only:

- Both exported `parseInteractiveChat` helpers throw host `RangeError` for a 12,000-level empty component chain. Network decoder reachability remains unproven.
- `PersistentEventStore` preserves a fake login `code` and throws `ENOTDIR` when its parent path is a file. Real credentials and installed log directories were untouched.
- Injected Bedrock timers/clients show a disconnected session's delayed join callback queues its message on a replacement session: `OLD_JOIN_SENT_BY_REPLACEMENT true`.

These probes ran through `node -e` and exited 0 after catching/asserting the observed conditions. They supplement source traces; they are not a live-server penetration test.

## Completion and limits

Desktop and mobile reports were revalidated and corrected where the original interpretation exceeded evidence. The missing hygiene audit was completed. No source fix, dependency upgrade, installer release, application replacement or user-data migration was performed. Original checkouts and installed data remain intact; dependency installs occurred only in the isolated audit checkout. Two untracked sample files emitted by the native-mobile package setup were excluded from publication.

Android/iOS native builds, physical/emulated-device sessions, OS process death/background restrictions, Keychain hardware protection, signed old-to-new APK upgrades, real Microsoft login/token ACL inspection, native Bedrock and authenticated/public/modded-server tests were not performed. None is implied by green host checks. Registry advisories and source-confirmed findings remain open. Current audit completion does not supersede those release qualification boundaries.

Rollback: revert the documentation commit or close its draft PR. No runtime/configuration rollback is necessary.
