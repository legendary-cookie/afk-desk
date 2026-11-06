# AFK Desk UI redesign (desktop)

Status: approved for implementation, 2026-11-06. References: Apple, Vercel, Linear, Slack. The aim is calm, precise and dense without feeling crowded.

## What the app is for
AFK Desk is a control room for Minecraft accounts that stay online for hours. Users glance at it to see which accounts are healthy, and then act on one: chat, inventory, macros, POV. The design serves both moments:
- **At a glance:** live presence in the account rail.
- **When acting:** a quiet, roomy workspace.

## Tokens

### Colour, dark (default)
| Token | Hex | Use |
|---|---|---|
| --bg | #16171A | window background |
| --surface | #1C1E22 | panels, sidebar |
| --raised | #24272C | inputs, hovered rows, menus |
| --line | #2D3036 | hairlines and borders, 1px |
| --text | #ECEDEF | primary text |
| --muted | #8B9099 | secondary text and meta |
| --accent | #4C7DF0 | lapis: primary actions, focus ring, selected item |
| --ok | #3FB97E | online, healthy |
| --warn | #E0A53B | connecting, waiting |
| --danger | #E5534B | errors, destructive actions |

### Colour, light
| Token | Hex |
|---|---|
| --bg | #F6F7F9 |
| --surface | #FFFFFF |
| --raised | #F0F1F4 |
| --line | #E3E5EA |
| --text | #17181B |
| --muted | #6A707A |
| --accent | #3366E0 |

Status colours are the same in both themes. Accent is the only saturated colour outside status; nothing decorative uses colour.

### Type
- **UI:** `"Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, sans-serif`. Use `"Segoe UI Variable Display"` for sizes 20 and up.
- **Console and logs only:** `"Cascadia Mono", "Consolas", ui-monospace, monospace`.
- **Scale (px):** 11 (fine meta), 12 (meta), 13 (body and controls, the default), 15 (panel titles), 20 (account name), 28 (empty-state headline). Line-height 1.45 for body, 1.2 for headings.
- **Weights:** 400 for body, 500 for controls and labels, 600 for titles. Nothing heavier.
- Sentence case everywhere. No all-caps labels, no letter-spaced eyebrows. Replace "SELECTED ACCOUNT", "ACCOUNTS", "CONNECTION PROFILE" and similar with plain words, or remove them where the content already says it.
- Numbers in stats use `font-variant-numeric: tabular-nums`.

### Space, size and shape
- 4px base grid; common steps 4, 8, 12, 16, 24, 32.
- Controls are 32px tall (28px compact); rows in lists are 36px.
- Radius: 6px for controls and rows, 10px for panels and dialogs, 999px only for status pills and dots.
- Elevation: none on panels; separate them with --line and spacing. Shadows only on overlays (menus, popovers, dialogs, toasts): `0 8px 24px rgb(0 0 0 / .28)` in dark, `0 8px 24px rgb(16 24 40 / .12)` in light.
- Focus: a 2px --accent ring with a 2px offset on every interactive element, keyboard-visible.
- Motion: 120–160ms ease-out, only for state changes (open/close, select, toast). Respect prefers-reduced-motion. No entrance animations on load.

## Layout

```
+----------------+---------------------------------------------------------+
| AFK Desk    ⌘K | StarrySea  ● Online · play.veridianmc.net     [POV] [⋯] |
|----------------| Overview  Chat  Inventory  Wall  Automations  Logs      |
| ● duck_amber   |---------------------------------------------------------|
|   veridianmc   |                                                         |
| ● StarrySea  ◀ |   workspace (overview modules, chat, inventory ...)    |
|   veridianmc   |                                                         |
| ◌ legend696_zl |                                                         |
|   offline      |                                                         |
|                |                                                         |
| + Add account  |                                                         |
| ⚙ Settings     |                                                         |
+----------------+---------------------------------------------------------+
```

**Account rail** (the one bold element):
- 248px wide; collapses to a 56px icon rail with avatars and status dots, where nothing overflows.
- Each row: avatar 24px with a status dot on its corner, the name in 13/500, and the server in 12/--muted. On the right, a tiny health/food meter as two 2px bars, only when online.
- The selected row gets a --raised background and a 2px --accent bar on its left edge.
- Presence colour is the only colour in the rail. Offline accounts are dimmed to 60%.
- Groups such as linked profiles show as collapsible sections with a sentence-case heading in 12/--muted.

**Header:**
- The account name in 20/600 and a status pill: a dot plus a short word, "Online", "Connecting" or "Offline".
- The server and version in --muted.
- Actions on the right: one primary (Connect or Disconnect), the rest as icon or quiet buttons (POV, Edit, Logs, ⋯ for more). Search lives in a ⌘K command bar, not as a big button.

**Tabs:**
- Text tabs with a 2px --accent underline on the active one and no boxes. 13/500 text, --muted when inactive.

**Panels and overview modules:**
- --surface background, 1px --line border, 10px radius, no shadow.
- Panel titles in 15/600, with the action icons as quiet buttons on the right. They keep working with the auto-arrange layout system.

**Console:**
- Monospace, 12/1.5, no zebra stripes, timestamps in --muted.
- Minecraft chat colours stay, as they are content.
- The input sits at the bottom with a 32px height and Send as a quiet button. Enter sends.

**Inventory:** keep the Minecraft-style slot grid, as it is content, but place it on --surface with a hairline frame, not a light grey slab.

**Dialogs:** 10px radius, max width 640, a title in 15/600, a body in 13, and a footer with right-aligned actions. Primary actions name exactly what they do ("Save account", not "OK").

**Empty states:** a short direct sentence plus one action, such as "No accounts yet." with an "Add account" button.

**Toasts:** bottom-right, --raised, an icon and text, auto-dismissed after 4s. Errors stay until dismissed.

## Principles
1. Status is the loudest thing on screen. Everything else is quiet.
2. One accent. Colour means state or action, never decoration.
3. Hairlines and space, not boxes and shadows.
4. Sentence case, plain words, actions named by what they do.
5. Keyboard-first: ⌘K, visible focus, arrow keys in lists.

## Implementation rules
- Keep every element id, data attribute and event handler working. The redesign is CSS plus light markup changes; behaviour must be unchanged and the tests must pass.
- Express all colours as CSS custom properties. The existing colour themes map onto these tokens, and the new defaults are dark graphite and light. Keep the Display menu working.
- Keep the overview module system and auto-arrange; restyle only.
- Respect streamer mode, the interface scale setting (50–125%) and the narrow-window rules: the rail collapses below 1100px.
