# Review of GitHub main at 861e9a7

The supplied review examined the published `main` branch, while this working branch includes later beta recovery and fixes. This is the result of checking its actionable findings against the current working tree on 2026-09-28.

| Review finding | Current state |
| --- | --- |
| Desktop auto-deposit may take an identical locked stack | Confirmed; exact-slot transfer now used for auto-deposit, manual deposit, and partial drops. Regression tests reproduce the previous locked-stack loss. |
| Android auto-deposit can resume after disabling during reconnect delay | Confirmed; reconnect state is updated without a live session. Reconnect regression test added. |
| Old desktop/mobile disconnect event can remove a new session | Already guarded by session identity in both current engines. Desktop regression exists. |
| Long model-parent chain overflows parser stack | Confirmed; desktop and Android traversal now bound to 64 parents with a safe fallback. A 12,000-model desktop fixture reproduced the error before the fix. |
| Bad resource artwork breaks inventory or menu rendering | Confirmed; per-item and title appearance failures now fall back to standard presentation. |
| Pack download buffers an undeclared oversized response | Already uses streaming byte limits, aborts, concurrency cap, and cache limits in the current engines. |
| Android final-account deletion, login identity, and storage hydration | Already fixed and covered by mounted UI tests. |
| Android event listener cleanup | Confirmed; cleanup now removes the three subscriptions returned by the bridge. Mounted UI test added. |
| Desktop browser smoke misses version API | Already corrected and exercised against the beta.8 UI. |
| `adm-zip` 0.6.0 advisory | Confirmed after the review; both engines now resolve 0.6.1. See desktop/SECURITY.md for current audit scope. |

Still open for a later milestone: resource-pack downloads can follow redirects to local/private network destinations, and the pack fetch path does not inherit the configured game proxy. A safe policy must include DNS resolution and redirect checks while allowing intentional private packs. The embedded Android Node 18 runtime also remains below Mineflayer's declared Node 22 requirement; desktop test results cannot certify Android runtime operation. Mobile UI tests cover account lifecycle but not every screen or background-service condition. Real-server, long-running, and physical-device tests remain unperformed.

The current installed Windows beta.8 predates the fixes made after this review. The source fixes are labeled beta.9 and should not be described as an updated local installation or an official published release until packaged and verified separately.
