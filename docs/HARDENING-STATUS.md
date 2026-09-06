# Recovered beta hardening — 2026-09-06

This continues the installed 0.10.0-beta.7 recovery at `61a2f27`. It does not replace or modify the installed application or its account data. The recovered POV, controls, Java/Bedrock adapters, mod profiles, inventory operations, automation editor, proxy pool, and existing settings remain in source.

## Implemented

| Area | Behavior now enforced | Evidence |
| --- | --- | --- |
| Desktop persistence | Invalid JSON/schema and unreadable files fail closed; mutations preserve existing bytes. Startup and runtime errors show recovery messages. | Store and main-security tests |
| Desktop IPC | Every registered handler requires the exact main window/main frame and local application document. Navigation, popups and permissions denied. | IPC and main-security tests |
| Microsoft login | Isolated window navigation restricted to Microsoft HTTPS domains; permission requests denied. Mobile opens the fixed Microsoft device-login endpoint. | IPC and external-links tests |
| Profile paths | Desktop Java/Bedrock and mobile Java reject traversal, path separators, alternate streams and reserved aliases before connection creation. Existing safe IDs retained. | Profile-path and bot-manager tests |
| Session lifecycle | Old desktop/mobile end events cannot remove replacement sessions. Mobile retry attempts reset only after 60 seconds stable; connection/configuration watchdog and device-login grace added. | Bot-manager and lifecycle tests |
| Startup/shutdown | Pending startup timers canceled on manual connect/disconnect/delete and quit; startup reads current account configuration. Failed connect releases assigned proxy lease. | Main source and integration review; no real app lifecycle smoke claimed |
| Edition routing | An active session/retry cannot silently switch between Java and Bedrock; failed connects preserve routing. | Multi-edition tests |
| Forge | Automatic loader refreshes status metadata instead of stale remembered selection. Fixed-version detection uses the configured proxy and preserves explicit game version. Manual mod lists choose handshake after negotiation. | Modded-recovery and bot-manager tests |
| Macros/proxies | Failed sticky proxies excluded during cooldown; changed inventory triggers macros. Stop/deadline interrupts waits and prevents subsequent steps. | Beta-core tests |
| Resource packs | Download bytes enforced while streaming; timeout/errors cancel. Four concurrent downloads, eight cached results, managed disk ZIP cache limited to eight files/300 MB. Invalid ZIPs not cached. | Resource-pack tests in both engines |
| Mobile proxy secrets | OS secure storage, immutable revisions and verified readback before plaintext removal; serialized snapshot commits; old referenced secrets retired only after commit. | Account-storage and rendered lifecycle tests |
| Mobile links | Real URL parser accepts HTTP/S only, rejects credentials/custom schemes; browser failures become visible alerts. | External-links tests |
| Android service | Starts/updates for active sessions, stops at zero; count notification and contextual permission; no empty sticky restart after process death. | Foreground helper tests and native source review; native runtime unverified |
| Android release safety | Original release signing credentials required; no debug-signing fallback. Stable application/storage IDs retained; update instructions forbid uninstall as mismatch workaround. | Gradle source review; native build blocked |

The engineering harness and test-driven workflow were used for bounded implementation slices and independent integration review, not another long-running whole-repository scan.

## Verification boundaries

Final post-upgrade checks on this Windows host (Node 26.8.1):

- Desktop: `node --test test/*.test.cjs` — exit 0, 198 passed, 0 failed (about 120 seconds).
- Embedded mobile engine: `node --test test/*.test.cjs` — exit 0, 27 passed.
- Mobile application: `npm test -- --runInBand` — exit 0, 31 passed across five suites.
- Mobile: `tsc --noEmit` and `eslint . --quiet` — exit 0.
- Desktop JavaScript syntax checks and `git diff --check` — exit 0.
- Browser: `python test/ui-smoke.py` with workspace-local Playwright 1.62.0 and installed headless Edge — exit 0. Existing chat/inventory/settings/layout flows plus POV open/filter/focus/WASD/coordinate action/map/pause/close passed, with no captured page errors. Bridge and world data are synthetic; this does not prove a live textured world or actual bot actions. Set `PYTHONPATH` to the workspace `work/ui-test-deps` and `AFK_DESK_TEST_BROWSER` to the installed Edge executable to reproduce.
- Desktop and embedded engine: `npm audit --omit=dev --json` — exit 0, zero reported vulnerabilities in each production tree after the scoped UUID override. See `DEPENDENCY-SECURITY.md`; this does not include the top-level mobile framework/toolchain.

The actual npm invocation used `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"` because the normal user npm shim is broken. Full TAP evidence is supplied in the output directory.

The desktop action/water matrices use local synthetic protocol fixtures across 28 versions, 1.8.8 through 1.21.11. They are not proof of Microsoft authentication, arbitrary modpacks, public servers, Bedrock native operation or real POV rendering. Keychain and Android bridge tests mock native boundaries; they are not hardware-backed-storage or APK upgrade proof.

Android `gradlew.bat :app:preReleaseBuild --offline --console=plain` exited 1 before project configuration: the Gradle wrapper distribution was unavailable and its network download was denied. No Android device/SDK was configured. iOS requires macOS/Xcode and pods. No installer has been built or deployed in this pass.

## Still open — do not label the application fully fixed

- Arbitrary client-side mods, JAR execution and every server type are not supported by a protocol-handshake adapter. Unsupported mechanics require a compatible full-client backend or explicit adapter work; no universal compatibility claim is made.
- Real server tests for Forge/FML1/FML2/FML3, Java authentication, native Bedrock, POV interactions and long background sessions remain outstanding. Servers disabling status responses need manual mod configuration. Explicit handshake override without a manual mod list still follows detected server metadata.
- Minecraft authentication token caches are unchanged; proxy-password encryption does not mean all authentication material is encrypted.
- Resource URL redirects and private-network destinations remain permitted. Streaming limits are not comprehensive SSRF protection. Resource caches are bounded per loader, not across all possible processes; in-use parsed resources can outlive cache eviction.
- A stopped macro cannot undo a bot operation already dispatched. Later steps are stopped; cancellation of an in-flight operation depends on the underlying API.
- Interrupted/ambiguous mobile snapshot writes may leave unreferenced secure revisions intentionally. Device-only secure references require re-entry when moved to another device. Older app builds do not understand these references; do not downgrade after migration without a compatible recovery plan.
- The original Android update data-loss cause has not been reproduced on a device. An actual old-to-new signed APK upgrade and original-key availability must be checked before distribution. Existing erased data cannot be reconstructed from absent backups.
- Native build, packaging and UI verification results must be checked separately. Current React Native/tooling dependency advisories are not resolved by the gameplay-engine dependency batch. Broad framework migration, complete CI/release hardening and exact AFKCC visual/feature parity are unfinished.

## Rollback

The installed beta and original recovered archive are untouched. To examine the pre-hardening source without discarding current work, create a separate worktree at `61a2f27`. Do not reset or overwrite a dirty checkout. Dependency remediation is kept in a separate commit for independent reversal. Source rollback is not a safe data-format downgrade after secure-storage migration; preserve an authorized data backup and use a compatible build.

Android signing guidance: [Android app signing](https://developer.android.com/studio/publish/app-signing). Secure-storage API: [React Native Keychain](https://oblador.github.io/react-native-keychain/docs/api/functions/setGenericPassword/).
