# Macros (available in 0.11 (pre-release))

> **Status: available in 0.11 (pre-release).**
> Windows `0.10.0-beta.9` includes an early per-account **Automations (beta)** dialog for basic workflows. The declarative **Macro Engine v2** described on this page is currently in development on the `feature/macro-engine` branch (see [`docs/design/macro-engine.md`](../design/macro-engine.md)) and is not yet in a published release.

![Current Automations beta dialog in 0.10.0-beta.9](../images/automation-dialog.png)

## Overview of Macro Engine v2

Macro Engine v2 upgrades AFK Desk's beta automations into a shared **macro library** where each workflow connects a **trigger** to an ordered list of **steps**, with optional conditions, loops, and stop rules:

- **One library, flexible targets**: Instead of copying the same workflow across 20 profiles, each macro can target **All accounts**, **Selected accounts**, or account **Tags**. Existing v1 per-account automations from `0.10.0-beta.9` migrate automatically on upgrade.
- **Declarative and local**: Macros use safe, built-in actions — never arbitrary JavaScript `eval` or shell commands — and respect per-account rate budgets (up to 20 steps/sec and configurable chat rate limits) so accounts are not kicked for spam.
- **Respects item locks**: Drop, deposit, equip, and GUI click steps strictly enforce your [item locks](inventory-and-auto-deposit.md#item-locks-protecting-gear-and-keys); a macro can never drop or move a locked slot.
- **Input ownership**: Held movement or click steps track their own claims and release them cleanly if a macro is stopped, edited, or interrupted by a disconnect.

## Triggers and Actions (Phase 1 Design)

### Triggers (`WHEN`)

| Trigger | When it fires |
| --- | --- |
| `manual` | Clicked manually in the UI |
| `join` | First spawn of a new server connection (including after auto-reconnect) |
| `worldChange` | Dimension change or proxy backend transfer (debounced 2s) |
| `timer` | Fixed interval (with optional random jitter) while the account is online |
| `schedule` | Daily wall-clock time (`HH:MM`) in your computer's local time zone while online |
| `chat` | Incoming message matches a `contains` or `*` glob pattern (with `{name}` variable captures) |
| `death` | Account dies |
| `disconnected` | Account loses connection or is kicked (can run `notify`, `wait`, and `reconnect`) |
| `healthBelow` / `hungerBelow` | Edge-triggered when health or hunger crosses below a threshold |
| `inventoryFull` | Edge-triggered when all inventory slots become occupied |
| `windowOpen` | Server opens a chest/GUI menu (with optional title match) |

### Actions (`STEPS`)

- **Communication & Alerts**: `chat` (rate-limited message/command with `{variable}` substitution), `notify` (desktop notification or outbound alert).
- **Timing & Flow**: `wait` (fixed duration + random jitter, or min–max range), `set` variable, `if` / `else` condition, `repeat` (count or `while` condition), `stop`.
- **Movement & Camera (Java)**: `move` (by duration or block distance), `look` (yaw/pitch, relative delta, or look at block/entity), `sneak` / `jump` / `sprint` (hold or release), `leftClick` / `rightClick` (once, hold, or release).
- **Inventory & Menus (Java)**: `selectHotbar`, `holdItem` (by item name), `useInventory` / `useGui` (click slot by index, item name, or lore), `waitForWindow`, `closeGui`, `drop` / `dropAll` (respecting item locks), `deposit`.
- **Session**: `disconnect`, `reconnect`.

## Example macros

The macro library includes 10 built-in starter templates covering common automated workflows. Each template can be inserted directly from the **Templates…** picker in a disabled state so you can review and configure targets before enabling.

### 1. Join → `/afk`

Automatically enters AFK mode after connecting to a server, with a slight randomized delay so it looks natural.

- **Trigger**: `join` (cooldown `0ms`)
- **Steps**:
  1. `wait` — `1500 ms` with `500 ms` jitter
  2. `chat` — `/afk`

```json
{
  "name": "Join → /afk",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "join", "cooldownMs": 0 },
  "steps": [
    { "type": "wait", "ms": 1500, "jitterMs": 500 },
    { "type": "chat", "message": "/afk" }
  ]
}
```

### 2. Anti-AFK look-around every 60 s

Periodically turns the player view slightly every 60 seconds to avoid idle disconnects.

- **Trigger**: `timer` every `60s` (`±5s` jitter, runs only while online)
- **Steps**:
  1. `look` — relative yaw `+0.35` radians, pitch `0`
  2. `wait` — `400 ms`
  3. `look` — relative yaw `-0.35` radians, pitch `0`

```json
{
  "name": "Anti-AFK look-around every 60 s",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "timer", "intervalMs": 60000, "jitterMs": 5000 },
  "steps": [
    { "type": "look", "mode": "relative", "yaw": 0.35, "pitch": 0 },
    { "type": "wait", "ms": 400 },
    { "type": "look", "mode": "relative", "yaw": -0.35, "pitch": 0 }
  ]
}
```

### 3. Auto-eat when hunger < 14

Selects food by name, holds right-click to eat when hunger drops below 14, then releases.

- **Trigger**: `hungerBelow` (threshold `14`)
- **Steps**:
  1. `holdItem` — name `cooked_beef`
  2. `rightClick` — action `hold`
  3. `wait` — `1800 ms` (safe eating duration)
  4. `rightClick` — action `release`

```json
{
  "name": "Auto-eat when hunger < 14",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "hungerBelow", "below": 14 },
  "steps": [
    { "type": "holdItem", "name": "cooked_beef" },
    { "type": "rightClick", "action": "hold" },
    { "type": "wait", "ms": 1800 },
    { "type": "rightClick", "action": "release" }
  ]
}
```

### 4. Inventory full → deposit to chest

When all inventory slots fill up, deposits items into the open chest container and sends a notification.

- **Trigger**: `inventoryFull`
- **Steps**:
  1. `deposit` — slot `9`, count `64`
  2. `notify` — desktop alert `"Inventory full: deposited items to chest."`

```json
{
  "name": "Inventory full → deposit to chest",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "inventoryFull" },
  "steps": [
    { "type": "deposit", "select": { "slot": 9 }, "count": 64 },
    { "type": "notify", "message": "Inventory full: deposited items to chest.", "desktop": true, "webhook": false }
  ]
}
```

### 5. Kick/disconnect → notify

Sends a desktop notification alert whenever the account is disconnected or kicked.

- **Trigger**: `disconnected`
- **Steps**:
  1. `notify` — desktop alert `"Account was disconnected or kicked from the server."`

```json
{
  "name": "Kick/disconnect → notify",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "disconnected" },
  "steps": [
    { "type": "notify", "message": "Account was disconnected or kicked from the server.", "desktop": true, "webhook": false }
  ]
}
```

### 6. Death → wait then /home

On respawn after death, waits 2 seconds and runs `/home` to return to base.

- **Trigger**: `death`
- **Steps**:
  1. `wait` — `2000 ms`
  2. `chat` — `/home`

```json
{
  "name": "Death → wait then /home",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "death" },
  "steps": [
    { "type": "wait", "ms": 2000 },
    { "type": "chat", "message": "/home" }
  ]
}
```

### 7. Chat trigger "{player} has invited you" → /tpaccept

Detects an incoming teleport invite in chat and automatically responds with `/tpaccept`.

- **Trigger**: `chat` (glob pattern `*{player} has invited you*`)
- **Steps**:
  1. `wait` — `1000 ms`
  2. `chat` — `/tpaccept`

```json
{
  "name": "Chat trigger \"{player} has invited you\" → /tpaccept",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "chat", "match": "glob", "pattern": "*{player} has invited you*" },
  "steps": [
    { "type": "wait", "ms": 1000 },
    { "type": "chat", "message": "/tpaccept" }
  ]
}
```

### 8. Scheduled daily message

Sends a scheduled message or command every day at a specific wall-clock time (12:00).

- **Trigger**: `schedule` (time `12:00` in local timezone)
- **Steps**:
  1. `chat` — `"Daily check-in from AFK Desk"`

```json
{
  "name": "Scheduled daily message",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "schedule", "at": "12:00" },
  "steps": [
    { "type": "chat", "message": "Daily check-in from AFK Desk" }
  ]
}
```

### 9. Window opens "Shop" → click item by name then close

When a server menu titled "Shop" opens, clicks the item named "diamond" and closes the menu.

- **Trigger**: `windowOpen` (title `"Shop"`)
- **Steps**:
  1. `useGui` — item name `"diamond"`, left click
  2. `wait` — `500 ms`
  3. `closeGui`

```json
{
  "name": "Window opens \"Shop\" → click item by name then close",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "windowOpen", "title": "Shop" },
  "steps": [
    { "type": "useGui", "select": { "name": "diamond" }, "click": "left" },
    { "type": "wait", "ms": 500 },
    { "type": "closeGui" }
  ]
}
```

### 10. Repeat sell loop with /sell all every 5 min

Sends the `/sell all` command every 5 minutes (300 seconds) on a timer loop.

- **Trigger**: `timer` every `300s` (`±5s` jitter)
- **Steps**:
  1. `chat` — `/sell all`

```json
{
  "name": "Repeat sell loop with /sell all every 5 min",
  "enabled": false,
  "targets": { "mode": "all" },
  "trigger": { "type": "timer", "intervalMs": 300000, "jitterMs": 5000 },
  "steps": [
    { "type": "chat", "message": "/sell all" }
  ]
}
```

---

**Next:** [Notifications (available in 0.11 (pre-release)) →](notifications.md)
