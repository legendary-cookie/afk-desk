# AFK Desk development record

Living log for the 0.10.0-beta.10 milestone and beyond. Newest entries first within each section.

## Baseline (2026-10-26)

- Source baseline: `main` @ `3004381` (PR #6 merged, 0.10.0-beta.9 source).
- Installed on the owner's machine: AFK Desk 0.10.0-beta.9 (`%LOCALAPPDATA%\Programs\AFK Desk`, data in `%APPDATA%\afkdesk`). **Read-only. Not modified, not reinstalled.**
- PR #7 (`codex/afk-desk-audit-takeover`, draft): documentation-only audits dated 2026-10-14. Findings were source-confirmed; none were fixed. This milestone fixes them.
- Host checks quoted by PR #7: desktop 222/222, mobile Jest 32/32, embedded engine 28/28. Embedded engine re-run today: 28/28.

## Milestone 0.10.0-beta.10 — stability and safety

Branch `milestone/0.10.0-beta.10` (from `main`). Work happens in isolated worktrees under `~/ao/wt/`, one per stream, with disjoint file ownership.

| Stream | Branch | Agent | Files owned | Findings |
| --- | --- | --- | --- | --- |
| Desktop session safety | `fix/desktop-session` | Claude Sonnet subagent | `main.cjs`, `store.cjs`, `beta-core.cjs`, `bedrock-bot-manager.cjs`, `multi-edition-manager.cjs` | D1, D2 (wiring + Bedrock), D3, D4, D6 |
| Desktop network/parsing | `fix/desktop-network` | Claude Sonnet subagent | `bot-manager.cjs`, `resource-pack.cjs`, new `net-policy.cjs` | D5, component recursion, D2 (Java), "already online" backoff + jitter |
| Android embedded engine | `fix/mobile-engine` | Codex (ChatGPT subscription) | `mobile/nodejs-assets/nodejs-project/**` | M2, M3, recursion, H4 pin, bridge validation |

Shared contract: every bot manager exposes `updateAccountConfig(account)`; `multi-edition-manager` routes by edition, and `main.cjs` calls it after a successful profile save.

### Blockers needing the owner

- **M1/H2: Android embedded runtime.** `nodejs-mobile` stops at 18.20.4 (Oct 2024); no Node 22 build exists upstream (checked npm and GitHub releases on 2026-10-26). Mineflayer 4.37.1 and minecraft-protocol 1.66.2 declare `node >=22`. Options: (a) identify the Node ≥22 APIs Mineflayer actually uses on our code paths and polyfill/patch them for 18; (b) build nodejs-mobile from Node 22 sources. Either needs real-device verification (emulator or phone). Host tests cannot certify this.
  - 2026-10-26 static scan (Haiku agent, grep-level): found no Node 20+/22-only API on the login, chat, physics, inventory or chunk paths of mineflayer, minecraft-protocol, prismarine-*, protodef, msal-node, uuid or socks. The only gap is `globalThis.crypto.randomUUID` in prismarine-auth `Util.nextUUID`, which has no callers. One project test uses `Promise.withResolvers` and fails on 18. Verdict: option (a) looks cheap. Next evidence step: run the engine suite and the local protocol matrix on a real Node 18.20.4 binary, then an on-device connect smoke.

## Completed

- **2026-10-26 — `fix/mobile-engine` merged (`db19e69`).** Codex implemented M2, M3, component recursion caps, H4 pins and bridge validation. Claude review found that the bridge validator accepted only string `requestId`s while `App.tsx` sends incrementing numbers, which would have rejected every command on device. The fixture tests had encoded the same wrong assumption. Fixed, with a regression test using the app's real id sequence. Host: `node --test` 34/34. Known limit: DNS rebinding window, because `fetch` re-resolves after validation. Not device-verified.
- **2026-10-26 — Android engine on real Node 18.20.4** (official nodejs.org win-x64 zip, SHA-256 verified against SHASUMS256.txt; kept outside the repo in `~/ao/wt/tools/node18`). This is the same Node version nodejs-mobile ships, but a desktop build, not the Android binary.
  - Engine suite: 32 pass, 0 fail, 4 skipped. The 4 skips are tick()-driven reconnect tests: Node 18's experimental MockTimers does not fire due timers from `tick()` when several are pending (`runAll()` does; isolated with a probe). That is a test-runner limitation; product timers are real `setTimeout`. Test-only fixes: `test/compat.cjs` (withResolvers stand-in, array/object mock-timer API).
  - Protocol matrix (`AFK_DESK_ENGINE=mobile`, loopback offline-mode servers): **all 28 versions 1.8.8–1.21.11 spawn, move, jump and send ≥7 packet types on Node 18.20.4.**
  - `globalThis.crypto` exists on desktop Node 18.20.4. The scan's only flagged gap is therefore closed on desktop, but this must still be confirmed on the nodejs-mobile build.
  - Remaining M1 evidence gap: an on-device (emulator or phone) connect smoke. The `engines >=22` declaration is conservative for our paths on host evidence.
- **2026-10-26 — `fix/desktop-session` merged (`8820275`).** D1 (`AccountStore.updateAccount` merges only lock slots after the await; deleted profiles are not resurrected), D2 (Bedrock `updateAccountConfig`, routing, save-path wiring), D3 (per-session join timers with an identity fence), D4 (deliver first, persist last, bounded `storage-warning`), D6 (`login-code` never persisted; code/device-code keys redacted). 12 new tests, verified to fail before the fix.
- **2026-10-26 — `fix/desktop-network` merged (`6a457e5`, `926c81e`).** D5 (`net-policy.cjs`: manual redirects, per-hop DNS validation, also blocks NAT64/6to4/fec0::/10), iterative component walkers (caps 64/4096), Java `updateAccountConfig`, ±20% reconnect jitter, ≥30 s backoff for "already logged in" kicks. 20 new tests.
- **Integration review fix (Claude).** The network agent's proxy gate *declined* server resource packs for proxied accounts, and a policy-blocked pack also went down the decline path. Many servers kick players who decline a required pack, so before this fix proxied accounts would have started getting kicked. Bots only use packs for menu artwork. Desktop and Android now **accept without downloading** when skipped by policy (proxy without opt-in, or a blocked destination). Genuine download failures keep the old decline behaviour. Regression tests were added in both engines.
- **2026-10-26 — Draft PR #8 opened** (`milestone/0.10.0-beta.10` → `main`).
- **2026-10-26 — Independent review (Codex, read-only)** found 3 issues. All were verified against the code before fixing and committed in `a7b9469` with fail-before-fix tests:
  - P1: on Android, IPv4-compatible IPv6 `::a.b.c.d` bypassed the private-address check (a probe reached `fetch` for `::10.0.0.1`). NAT64, 6to4 and site-local were aligned with desktop.
  - P2: resource-pack URLs carrying credentials were accepted; now rejected in both engines, on every hop.
  - P2: the desktop renderer dropped `storage-warning`; it now shows a toast and a console line. A contract test requires every emitted `bot:event` type to have a handler.
- **2026-10-26 — Dependency advisories (`fix/deps`, Sonnet; merged).** Production `npm audit`: desktop 5 → 0, engine 1 → 0 (axios 1.19.0→1.20.0 override; follow-redirects 1.16.2, brace-expansion 1.1.21, ip-address 10.7.5 via lockfile). Patches still apply. Claude then bumped **Electron 43.2.0 → 43.8.3**: it is a devDependency, but it is the shipped runtime, and 43.0.0–43.8.0 is affected. Real Electron smoke on 43.8.3: `AFK_DESK_SMOKE_PASS` (temporary user data). Remaining full-audit highs (5) are build-time only: @xmldom/xmldom, fast-uri, http-cache-semantics, js-yaml, undici via electron-builder. Re-check them before building the installer.
- **Current gate on the milestone branch:** desktop 259/259; engine Node 26 37/37; engine Node 18.20.4 33 pass / 4 skipped / 0 fail; Electron smoke pass.
- Codex sandbox note: `codex exec -s workspace-write` could not commit (worktree git metadata lives in the main repo's `.git`) or spawn `node --test` workers (EPERM). Plan for Codex runs: Codex edits, Claude runs the real test suite and commits after review.

### Verification levels

Every claim here is labeled source-level, host/simulated (unit tests, local offline protocol matrices), or real-device/real-server. Nothing in this milestone is real-server qualified unless stated.

## Expansion backlog (post-stability), informed by AFKCC (changelog Sep 2025 – Oct 2026)

Ordered by user value against implementation cost. AFKCC is cloud-hosted; AFK Desk is local-first, which keeps credentials on the user's machine. That is a differentiator to preserve.

1. **Macro engine (local).** Trigger → steps graph. Phase 1 triggers: join, world change, timer, chat message (regex), death, disconnect, inventory full, schedule. Phase 1 actions: chat, wait (fixed or random), use GUI / inventory slot, click item by name, hold/use item, drop/drop all, move, look, sneak/jump hold/release, attack, break block, reconnect/disconnect, if, repeat. Rules: one macro runs at a time per account unless "override running" is set; a failing step does not stop the macro; per-macro logs.
2. **Notifications and webhooks.** Discord webhook on disconnect, death, kick, and macro events; batched, with secret redaction in the UI and exports.
3. **Reliability.** Slower reconnect after "already online" kicks (in progress); auto-stop on permanent bans; optional "disconnect all accounts when one is banned".
4. **Account management.** Pinning, groups, bulk actions, account counter, import/export with secrets excluded.
5. **POV.** Multi-bot grid, freecam, scoreboard/bossbar/title overlays, tab list. Keep within a lightweight-renderer budget.
6. **Version support.** AFKCC supports 26.1–26.3. AFK Desk stops at 1.21.11. This depends on upstream minecraft-data / minecraft-protocol support; track it and do not hand-roll protocol support.

## 2026-10-27 — Android device verification and agent routing

- **Embedded Node 18 engine verified on an Android device (emulator).** The debug APK was built from `feature/macro-engine` with a throwaway debug key, x86_64 was added in the build copy only, and the JS was bundled. It ran on the Google emulator (Android 14, `sdk_gphone64_x86_64`).
  - The app launched, and the RN UI rendered.
  - Connect → the engine emitted "Connecting to 10.0.2.2…".
  - prismarine-auth on nodejs-mobile Node 18 obtained a real Microsoft device code (sign-in not completed).
  - This closes the main M1 risk at the connect and auth stages. Still not verified: a completed sign-in plus a live server session on device, ARM hardware, background or foreground-service survival, and upgrade over 0.9.2.
- **Android build notes for Windows** (add to mobile/BUILDING.md):
  - Use a short TMP path, e.g. `C:\afktmp`, or Gradle fails with "Unable to establish loopback connection".
  - Pass JVM options via `GRADLE_OPTS` / `org.gradle.jvmargs`, never `JAVA_TOOL_OPTIONS`. Its "Picked up…" stderr line makes prefab fail with CXX1210.
  - npm 11 blocks `nodejs-mobile-react-native`'s postinstall by default. Run `npm install-scripts approve nodejs-mobile-react-native` and then `npm rebuild nodejs-mobile-react-native`.
  - A debug build loads JS from Metro unless the bundle is generated into assets.
  - ARM-only APKs crash on x86_64 emulators (SoLoader looks in lib/x86_64). Consider shipping x86_64 for Chromebooks and emulators.
- **Safety note.** adb on this machine also sees a physical Android TV box over wireless debugging. All commands target `-s emulator-5554` explicitly; nothing is installed on the TV box.
- **Agent routing (owner has Codex and Antigravity subscriptions).**
  - Antigravity has two pools.
  - Gemini pool:
    - `gemini-4-argon-high` for hard implementation
    - `gemini-4-argon-medium` for normal work
    - `gemini-3.8-flash-*` for docs and mechanical tasks
  - Claude/GPT pool: `claude-sonnet-5-5-*` for independent reviews (a different family from the authors) and as a fallback when the Gemini pool is exhausted.
  - Codex is used for scoped implementation; its sandbox cannot run `node --test` (spawn EPERM) or commit, so it is not used for large refactors that need the suite.
  - Tool versions: codex-cli 0.162.1 (0.164.0 available), agy 1.4.7. Update between tasks, never while a job is running.
- **Codex model routing (2026-10-27).** Updated codex-cli 0.162.1 → 0.164.0 via `codex update`. The owner's `~/.codex/config.toml` defaults to `gpt-6-luna` (medium), described as "fast and affordable … for easier tasks". All earlier Codex jobs ran on it, which likely explains the incomplete R1 passes and the thin tests.
  - The owner's global config is left unchanged.
  - Every Codex job now passes `-m gpt-6.1-sol -c model_reasoning_effort="high"` for implementation.
  - `gpt-6-astra` is used for security-sensitive or hard work.
- **2026-10-27 — Antigravity Gemini quota exhausted.** The error was "Individual quota reached … Resets in 166h", so roughly 7 days.
  - The Bedrock forms UI job stopped mid-way; its partial changes are kept in the worktree.
  - Routing until the reset:
    - Antigravity work goes to its Claude pool (`claude-sonnet-5-5-*`) if that pool is separate.
    - Codex `gpt-6.1-sol` takes the rest, with Claude (lead) running tests and commits.
  - R2 security review (Codex `gpt-6-astra`) found 2 P1 issues and 8 P2 issues. Notably, a read token could become admin via session ids in the audit log, and remote admins could change remote-access settings and passwords. Fixes are in progress; nothing from R2 is merged until a re-review passes.
- **2026-10-27 — Antigravity Claude pool also exhausted** (it resets after about 5 h; the Gemini pool after about 7 days). R2 security fixes moved to Codex `gpt-6-astra`; Docker (R5) is on Codex `gpt-6.1-sol`. Claude runs every suite and commit.
