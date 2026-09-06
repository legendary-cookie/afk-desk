# Light audit — 2026-09-06

Baseline: `861e9a789ce406c6be577104c3678da76bf29d45` (v0.9.2).
Scope: a focused follow-up to the August source review, prioritizing small,
testable mobile correctness improvements. This is not a completed exhaustive
security audit or a release certification.

| Priority | Finding | Evidence / affected component | Follow-up |
| --- | --- | --- | --- |
| P1 confirmed | Final account returns after restart | `mobile/App.tsx` persists only nonempty arrays | Persist empty arrays after successful hydration; rendered restart regression |
| P1 confirmed data mutation; live auth impact untested | Identity event overwrites Microsoft login principal | `mobile/App.tsx` assigns identity username to saved username | Store display name separately; test next connection after remount |
| P1 confirmed protocol drift; live proxy impact untested | Mobile hand-builds modern server commands | Mobile `bot-manager.cjs` bypasses Mineflayer `chat` | Use upstream serializer as desktop does; regression test |
| P1 confirmed | Proxy passwords stored in plaintext | Whole mobile account serialized to AsyncStorage | Separate secure-storage migration project; transactional migration and device tests required |
| P1 source-review finding | Android service starts without connections and is sticky | `MainActivity.kt`, `AfkForegroundService.kt` | Native lifecycle changes require background/device validation |
| P1 source-review finding | Resource-pack networking lacks sufficient bounds | Desktop/mobile `resource-pack.cjs` | Streaming limits, redirect/address policy and cache budgets require a focused security slice |
| P1 needs live validation | Embedded Node 18 versus dependencies declaring Node 22 | Mobile runtime and embedded engine manifests/locks | Actual embedded-runtime tests before release |
| P2 confirmed | Public source test/build instructions omit prerequisites | Root/desktop README and mobile BUILDING | Correct commands; native builds remain platform-dependent |

The first three fixes are small and preserve account IDs, existing authentication
cache paths, proxy fields and game-version compatibility patches. Existing records
whose login name was already overwritten cannot be reconstructed automatically;
the user must correct that account's login field if authentication needs it.

## Beta check

Current GitHub heads/tags were rechecked on September 6. Main remains `861e9a7`;
there is no newer beta branch/tag. Historical unpublished source `269f37e` declares
0.9.0 and is an ancestor of 0.9.2: its version picker and interactive chat features
are already present. The August scoped recovery also found an older 0.8.3 APK,
not a newer beta. Deleted refs, private forks and binaries outside that search
remain unknown. No older binary was installed over user data.

## Release position

NOT READY FOR RELEASE. The narrow fixes do not resolve the credential-storage,
resource-pack, native lifecycle, runtime-support or packaging verification backlog.
Keep current compatibility patches until their replacements have equivalent tests.
No telemetry, cloud service or subscription is introduced.
