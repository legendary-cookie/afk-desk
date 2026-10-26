# Macro engine v2: design

Status: **draft for review** · Branch `feature/macro-engine` (from `milestone/0.10.0-beta.10`) · 2026-10-26

## 1. Goal

Turn AFK Desk's beta "automations" into a local, declarative macro system that covers what AFKCC users rely on daily: trigger → steps, conditions, loops, notifications. It must stay lightweight, keep credentials on the user's machine, and never break existing profiles.

Non-goals for v2: a node-graph canvas editor, a public macro marketplace, scripting with arbitrary code, captcha bypass, and anything that evades server anti-bot systems. These are excluded deliberately. AFK Desk should run the bot the way a player could, at player-like rates.

## 2. What exists today (verified in source)

| Piece | Where | Notes |
| --- | --- | --- |
| Quick-chat "macros" | `settings.macros`, renderer `renderMacroPad` | Global buttons that send one chat message. Unrelated to the engine; kept as is. |
| Automations | `account.automations[]`, normalized by `normalizeAutomations` (`electron/beta-core.cjs`) | Per-account, ≤100 per account, steps ≤200, nesting ≤8. |
| Triggers | `manual, connected, disconnected, chat (contains), health (below), inventory (any change), window (open), timer (interval)` | |
| Steps | `chat, wait, move, look, drop, deposit, equip, clickGui, attackNearest, useHeld, notify, set, if, repeat` | Executed by `executeMacroStep` (`main.cjs:615`). |
| Runner | `MacroEngine` (`beta-core.cjs:182`) | One run per account, 1000-step and 5-minute caps, run/stop over IPC, `macro` events. |
| UI | Automation dialog in `renderer.js` | List, step editor, JSON toggle, test button. |
| Bedrock | `bedrockCapabilities().macros = 'chat/wait/notify only'` | |

### Defects in the current engine, to fix as part of v2

1. **Level-triggered health and inventory.** `health` fires on every 2 s telemetry tick while health is below the threshold. Overlapping runs then throw "already running", and the error is swallowed. Any inventory change re-fires `inventory`.
2. **Timers ignore connection state.** The interval keeps firing while offline, so every run fails.
3. **Swallowed failures.** `handleEvent` and `run` failures from triggers use `.catch(() => {})`, so the user never learns why a macro didn't run.
4. **A failing step aborts the whole macro.** AFKCC found users expect the macro to continue past a failed step (changelog, 20 Aug 2026).
5. **No release of held inputs on stop.** Once hold actions exist, a stopped, deleted or disabled macro must release held clicks and controls (AFKCC, 6 Oct 2026).
6. **Hard caps that block real use.** A 5-minute runtime and `repeat` ≤100 make long AFK loops impossible. Replace them with rate budgets (§6).
7. **Re-normalization on every event.** The whole automation list is normalized on every telemetry tick, which is wasted CPU across many accounts.

## 3. Architecture

```
electron/macro/
  model.cjs      schema v2, normalize/validate, migrate v1 → v2 (pure)
  triggers.cjs   bot events → trigger matches (edge detection, cooldowns, hysteresis) (pure)
  actions.cjs    action registry: name → { validate, capabilities, run(ctx, facade) }
  engine.cjs     scheduler, per-account runner, budgets, held-input ledger, run logs
  facade.cjs     thin adapter: BotManager / BedrockBotManager → stable action API
```

- **Pure core.** `model`, `triggers`, `actions` and `engine` take no Electron or Mineflayer imports. Timers and the bot facade are injected. This makes them unit-testable with fake timers, and later portable to the Android engine (`mobile/nodejs-assets/nodejs-project`, Node 18-compatible syntax only).
- **Facade.** The facade is the only code that talks to bot managers. It maps actions to existing methods: `sendChat`, `setControlState`, `lookDelta`, `worldAction`, `clickWindowSlot`, `closeWindow`, `dropItems`, `depositSlot`, `equipInventoryItem`, `moveInventorySlot`, `disconnect`, and `connect`. New bot-manager helpers are listed in §5.
- **Wiring.** `beta-core.cjs` keeps exporting `MacroEngine` as a re-export during transition, so `main.cjs` changes stay small.
- **Capabilities.** Each action declares `capabilities: ['java'] | ['java','bedrock']`. Unsupported actions are disabled in the editor with the reason shown, and are rejected at run time with a clear log line.

## 4. Data model (schema v2)

Macros move from per-account to a **library with targets**. This matches the "All accounts" selector in AFKCC and avoids copy-pasting the same macro onto 20 accounts.

```jsonc
// <userData>/macros.json   { "version": 2, "macros": [ ... ] }
{
  "id": "uuid",
  "name": "Join /afk",
  "enabled": true,
  "targets": { "mode": "accounts", "accountIds": ["…"] },   // mode: all | accounts | tags
  "trigger": { "type": "join", "cooldownMs": 0 },
  "stopWhen": [ { "type": "playerAppears", "radius": 16, "ignoreOwnAccounts": true } ],
  "concurrency": "skip",            // skip | override (abort running macro on this account)
  "onError": "continue",            // continue | stop
  "defaultDelayMs": 1000,           // AFKCC default; 0 allowed
  "steps": [ { "type": "chat", "message": "/afk" }, { "type": "wait", "ms": 1500, "jitterMs": 500 } ]
}
```

- **Variables.** Variables are per run, written by `set` and by chat-trigger regex capture groups (`{1}`, `{name}`). They can be interpolated into `chat` and `notify` text. Interpolation is plain string substitution, never evaluated.
- **Migration.** On first start, `account.automations` (v1) become library macros targeting that one account. Ids are preserved, and the semantics are mapped:
  - `connected` → `join`
  - `health` → `healthBelow` with edge detection
  - `inventory` → `inventoryChanged`

  The v1 field is **left in place, unread**, so rolling back to beta.9 still sees the user's automations. It is removed no earlier than 1.0, after one release with telemetry-free confirmation in release notes.
- **Writes.** Atomic temp-file plus rename, the same as `AccountStore`. A corrupt file is moved aside (`macros.json.corrupt-<ts>`) and never silently emptied.
- **Secrets.** Webhook URLs are stored encrypted with Electron `safeStorage` (the same approach as proxy passwords). They are redacted in logs, diagnostics and exports. Export strips them, like AFKCC's "sharing filters webhook URLs".

## 5. Triggers and actions

### Triggers

Phase 1 includes all **P1** rows.

| Trigger | Source | Semantics | Phase |
| --- | --- | --- | --- |
| manual | UI or IPC | Runs once | P1 |
| join | first `spawn` per connection | Fires once per connection | P1 |
| worldChange | `respawn` with dimension/world change | Debounced 2 s (AFKCC: rapid world changes were unpredictable) | P1 |
| timer | interval | Only while online. ±jitter. The first fire is one interval after join, not at t=0 | P1 |
| schedule | wall clock HH:MM (daily) | Only while online. A missed fire while offline is skipped, not queued | P1 |
| chat | `messagestr` | contains, or regex (length-capped, timeout-safe via a simple-pattern subset). Capture groups become variables. Own messages are ignored | P1 |
| death | `death` | | P1 |
| disconnected | `end`/`kicked` | Exposes the reason. Cannot run world actions; only `notify`, `wait` and `reconnect` | P1 |
| healthBelow / hungerBelow | telemetry | **Edge-triggered** with hysteresis: fires when crossing below X, re-arms above X+2 | P1 |
| inventoryFull | telemetry | Edge-triggered | P1 |
| windowOpen | `windowOpen` | Optional title match | P1 |
| playerAppears / playerLeaves | `playerJoined`/entity tracking | Radius, ignore own accounts, smart mode (suppress for 5 s after a teleport) | P2 |
| damaged, teleported, itemAppears, durabilityBelow, blockBreaks, sound, dayNight | various | | P2–P3 |

### Actions

Phase 1 includes all **P1** rows. `J` = Java, `B` = Bedrock.

| Action | Maps to | Edition | Phase |
| --- | --- | --- | --- |
| chat | `sendChat`, with a per-account rate limit | J, B | P1 |
| wait | timer. `ms` + `jitterMs`, or random min–max | J, B | P1 |
| notify | desktop notification, optional Discord webhook | J, B | P1 |
| move | `setControlState` for duration, or distance via `walk` | J | P1 |
| look | absolute yaw/pitch (**new** `lookAbsolute`) or relative `lookDelta`; `look-at` block/entity | J | P1 |
| sneak / jump / sprint hold · release | `setControlState`, recorded in the held-input ledger | J | P1 |
| leftClick once · hold · release | `dig-crosshair`/`attack-nearest`/`swing` · `stop-dig`. Options: blocks only / entities only | J | P1 |
| rightClick once · hold · release | `use-crosshair`/`use-held` · `stop-use` | J | P1 |
| selectHotbar / holdItem (by name) | `select-hotbar` · **new** `holdItemByName` | J | P1 |
| useInventory / useGui | `clickWindowSlot`, by slot, item name or lore (**new** `findWindowSlot`); left/right/shift click | J | P1 |
| closeGui | `closeWindow` | J | P1 |
| waitForWindow | **new**. Resolves on `windowOpen` matching the title, or times out (`giveUpAfterMs`) | J | P1 |
| drop / dropAll | `dropItems` · **new** `dropAll(filter)`. **Respects item locks** | J | P1 |
| deposit | `depositSlot` / existing auto-deposit | J | P1 |
| set / if / else / repeat (times or while condition) / stop | engine | J, B | P1 |
| runMacro | engine. Nested-run depth ≤4, cycle detection at save time | J, B | P2 |
| disconnect / reconnect | `disconnect` / `connect`. A macro-initiated disconnect suppresses auto-reconnect | J, B | P1 |
| breakBlock (at coordinates), placeBlock, attack, fish, autoEat toggle, trade, sign | various | J | P2–P3 |

**Item locks:** locked inventory slots (an existing AFK Desk feature) are never dropped, deposited, moved or clicked away by a macro, whatever the step says. This is a safety rule.

## 6. Runner semantics

- **Concurrency.** One run per account. Different accounts run independently. A trigger that fires while its account is busy is skipped and logged ("skipped: X is running"), unless `concurrency: "override"`, which aborts the current run first.
- **Errors.** With `onError: continue`, a failed step is logged with its index and reason, then the run continues. With `stop`, the run ends with `failed`.
- **Budgets instead of hard caps.** These keep idle CPU low with many accounts:
  - `repeat` without a wait yields at least one game tick (50 ms) per iteration.
  - At most 20 steps per second per account.
  - The chat budget is set per account; the default is 1 message per 1.5 s, configurable.
  - Exceeding a budget delays the step; it does not fail it.
  - There is no wall-clock runtime cap (long AFK loops are the point). A user-set optional `maxRuntime` stays available.
- **Held-input ledger.** Every hold action is recorded. On stop, failure, disable, delete, edit-while-running (AFKCC behaviour: editing stops the run), disconnect, or app quit, the ledger releases all held controls and clicks for that run.
- **Session fence.** Each run captures the session identity at start. If the account disconnects or reconnects mid-run, world actions abort instead of acting on the new session (the same pattern as fix D3).
- **Stop conditions.** `stopWhen` conditions are checked before each step and on their own trigger events. A match ends the run as `stopped` and releases held inputs.
- **Logs.** Each macro keeps a ring buffer of its last 50 runs: start, end, trigger, per-step outcome and duration. They are persisted alongside events with the existing redaction, viewable in the editor, and included in diagnostics with secrets redacted.
- **Live state.** The renderer receives `macro` events `{ macroId, runId, status, stepIndex }`, so the editor can show which step each account is on (AFKCC "account heads").

## 7. Webhooks (P1, opt-in)

- Discord webhook URL per macro (`notify` action) and per account event type (disconnect, death, kicked).
- Events within 2 s are batched into one message, like AFKCC. Payloads are rate-limited and length-capped. The webhook HTTP request goes through `net-policy` with a public-host check, and the URL is validated against `https://discord.com/api/webhooks/` and `discordapp.com`. Other hosts are allowed only through an explicit "custom webhook" opt-in.
- No screenshots in P1, because POV capture is heavy.

## 8. UI (P1)

- **Editor.** A form-based vertical step list (not a node canvas; see the deferred decision in §11). It has a trigger card at the top, insertable step cards and drag reorder.
- **Shortcuts.** Taken from AFKCC's best-received changes: ↑/↓ to move, Enter to edit, Esc to close, Space or `/` to add, Ctrl+D to duplicate, Del to delete, Ctrl+Z / Ctrl+Shift+Z for undo and redo, Ctrl+Enter to save.
- **Target picker.** All accounts, selected accounts, or tags. Tags are a lightweight addition to profiles, which also gives account groups for bulk actions.
- **Validation inline.** Imported macros with missing inputs cannot be enabled until fixed.
- **Templates.** Join → `/afk`, timer anti-AFK look-around, auto-eat when hunger is below 14, inventory full → deposit, and kick → notify plus reconnect.
- **Implementation.** Implementation follows the repository's existing renderer patterns, with `textContent` only and no `innerHTML` for user data. It goes through the ui-consistency skills (finding-patterns → planning → implementing → verifying) at build time.

## 9. Security and abuse limits

- Declarative only. No `eval`, no user JS, no shell. Regexes are restricted (length ≤200, no backreferences or nested quantifiers) to avoid ReDoS on chat.
- The chat rate limit cannot be disabled, only raised up to a ceiling, to protect accounts from spam kicks.
- Webhook secrets use `safeStorage` and are always redacted.
- IPC: new handlers register through `registerTrustedHandler`, the same as existing ones. Payloads are normalized by `model.cjs` before storage.

## 10. Testing plan

| Layer | Tests |
| --- | --- |
| model | normalize/validate fuzz (unknown types, huge arrays, deep nesting), v1 → v2 migration from real beta.9-shaped fixtures, round-trip export/import with webhook stripping |
| triggers | edge/hysteresis (health oscillating around X fires once), timer only while online, schedule skip-while-offline, world-change debounce, chat regex captures and own-message ignore |
| engine | continue vs stop on error, skip vs override concurrency, step/chat budgets with fake timers, held-input release on every exit path, session fence on reconnect, stopWhen |
| facade/actions | each P1 action against a fake bot; item-lock enforcement; Bedrock capability rejection |
| integration | the existing loopback protocol matrix extended: a `join` macro sends chat, moves, holds and releases sneak on 1.8.8, 1.12.2, 1.16.5, 1.20.4 and 1.21.11 |
| UI | contract tests plus `test/ui-smoke.py` flows (create, edit, run, stop) |
| upgrade | beta.9 `accounts.json` with automations → v2 library; rollback leaves the v1 data readable |

As everywhere else in this project, nothing here is real-server qualification. A manual real-server checklist ships with the release.

## 11. Decisions

| # | Decision | Choice | Why |
| --- | --- | --- | --- |
| 1 | Per-account vs library | **Library with targets** | One macro for many accounts. Migration is lossless and rollback-safe. |
| 2 | Editor | **Form list now, canvas later** | Much less renderer code and easier accessibility. The model is a tree, so a canvas can be added later without a migration. |
| 3 | Step failure | **Continue by default** | Matches user expectation (AFKCC change, 20 Aug 2026). |
| 4 | Runtime cap | **Rate budgets, no wall-clock cap** | AFK loops run for hours; budgets keep CPU bounded. |
| 5 | Webhooks in P1 | **Yes, Discord only, opt-in** | High value for AFK users, small surface. |
| 6 | Android | **Shared pure core, ported after desktop P1** | The embedded engine runs Node 18. The core avoids Node 20+ APIs. |

## 12. Work breakdown (P1)

Each stream owns disjoint files; streams run in parallel worktrees, as in the milestone.

| # | Stream | Files owned | Depends on | Suggested agent |
| --- | --- | --- | --- | --- |
| A | model + migration | `electron/macro/model.cjs`, `test/macro-model.test.cjs` | none | Sonnet |
| B | triggers | `electron/macro/triggers.cjs`, `test/macro-triggers.test.cjs` | A (types only) | Sonnet |
| C | engine + ledger + logs | `electron/macro/engine.cjs`, `test/macro-engine.test.cjs` | A | Opus (concurrency) |
| D | facade + actions + bot-manager helpers (`lookAbsolute`, `holdItemByName`, `findWindowSlot`, `waitForWindow`, `dropAll`) | `electron/macro/actions.cjs`, `facade.cjs`, `bot-manager.cjs` (additions only) | A | Codex, then Claude review |
| E | wiring + IPC + store + webhooks | `main.cjs`, `preload.cjs`, `store.cjs`, `beta-core.cjs` | A–D | Claude |
| F | editor UI | `src/renderer.js`, `src/index.html`, `src/styles.css` | E's IPC contract | Sonnet + ui-consistency |
| G | integration matrix + upgrade tests | `test-fixtures/*`, `test/macro-integration.test.cjs` | E | Haiku/Sonnet |

**Exit criteria for P1:**
- All P1 triggers and actions work against fakes and the loopback matrix.
- A beta.9 profile migrates and rolls back cleanly.
- The desktop suite passes; independent review findings are fixed.
- Idle CPU with 10 connected accounts and 3 timer macros each is measured and recorded before and after.
