# Installed beta recovery — 2026-09-06

The installed application is **AFK Desk 0.10.0-beta.7**, found through the Windows
uninstall registry at `AppData/Local/Programs/AFK Desk`. Earlier GitHub/Codex-only
searches missed it. The earlier statement that no newer beta was found does not
apply to this installed build.

Its `resources/app.asar` was copied before extraction. Original and copied SHA-256:
`EDABB169E842B5A131D954108C1A19140747B5C0F955E3AA463E3BC772845545`.
Size: 537266004 bytes. The native `app.asar.unpacked` companion was also preserved.
Extraction succeeded after including that companion. No account data was read,
copied, deleted or migrated. No installed application was overwritten or launched.

## Recovered implementation

- Desktop renderer, HTML, styles, item textures and POV camera mathematics.
- Java POV snapshots and controls, multiple feed layout and HUD settings.
- Bedrock adapter and multi-edition manager.
- Automation engine/editor, persistent event history, alerts, proxy selection.
- Forge FML1/FML2/FML3 adapter, mod-list and channel configuration, client brands.
- Existing desktop persistence, proxy protection and compatibility logic.

Packaged runtime code was restored into `desktop/` on `recovery/installed-beta-7`.
The previous mobile fixes remain in the branch. The desktop package metadata was
merged with repository build/test scripts because packaged metadata omits those.
The lockfile was regenerated: this is a reconstructable development candidate,
not a byte-identical rebuild of the installed binary. Packaged beta tests, original
build logs, lockfile and mobile source were not present in the desktop archive.

## Fixes made after recovery

1. Forge/NeoForge profiles with Automatic version and no manual mod list now ping
   afresh instead of letting a remembered version bypass Forge auto-version hooks.
   Vanilla/default profiles retain existing remembered-version behavior.
2. Manual mods with automatic handshake/version defer FML generation selection
   until the Minecraft version is negotiated. Legacy 1.12.2 selects FML1 rather
   than prematurely choosing FML3.
3. Existing settings tests now account for recovered POV/theme defaults. Version
   tests enforce the Mineflayer range, excluding protocol-only 26.1 support.

The Forge regressions failed before fixes and passed afterward. Tests use injected
clients; actual modded servers and Microsoft authentication remain untested.

## Mod support limits

This implementation does not execute mod JARs. Fabric/Quilt branding and custom
channel registration cannot implement arbitrary mod packets or gameplay logic.
NeoForge uses the Forge adapter. Servers requiring matching client-side mods or
custom registries may not work. Explicit version plus automatic Forge list matching
and default-loader remembered-version detection still warrant live validation.
Do not advertise universal mod or server compatibility.

The AFKCC screenshots/changelog are product references, not recovered AFK Desk
code or evidence of parity. In particular a fully textured AFKCC scene does not
prove equivalent rendering in this recovered beta. The supplied MP4 has not been
frame-reviewed in this recovery pass.

## Android update data

The desktop archive contains no Android APK or React Native source. Current source
keeps `com.afkdeskmobile` and `afkdesk.mobile.accounts.v1`. The prior fixes protect
the last-account deletion, initial hydration and future login identity updates.
They do not prove the reported update-loss cause has been fixed.

Current Android release configuration uses a local debug signing key. A different
certificate prevents an in-place update; uninstalling to work around it removes
app-private data. Before a release, compare old/new APK package IDs, version codes
and signing certificates and test an actual upgrade with seeded settings. Retain
the existing signing key. Do not uninstall or clear app data as an upgrade step.
No Android SDK/adb was found at the default local SDK path during this pass.

Reference: [Android's app-update requirements](https://developer.android.com/google/play/app-updates).

## Remaining validation

Native Bedrock module rebuild/loading, Electron launch/POV behavior, Android
upgrade/signing, live Forge/NeoForge/Fabric servers and soak tests are not certified.
Macro inventory triggers, proxy cooldown selection and hung-action cancellation
also have source-review findings requiring separate tested fixes.

Status: recovered development source; NOT READY FOR RELEASE.

## Executed checks

- Desktop `node --test --test-reporter=tap test/*.test.cjs`: exit 0,
  145 passed, 0 failed, about 120 seconds. Includes local synthetic protocol and
  water matrices for 28 supported versions; not real modded-server certification.
- Mobile `node node_modules/jest/bin/jest.js --runInBand`: exit 0, 6 tests passed.
- Mobile `node node_modules/typescript/bin/tsc --noEmit`: exit 0.
- Desktop `patch-package --error-on-fail`: both existing patches applied.
- JavaScript syntax checks and `git diff --cached --check`: exit 0.

Initial runs exposed missing local dependency paths and pre-beta settings/version
test expectations. A clean dependency install, patch application and explicit
beta-default/version assertions resolved those failures; the final full run above
passed. Native install scripts were disabled, so native packaging is unverified.
