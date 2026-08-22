# Changelog

For the complete desktop history from 0.1.0 onward, including source tags, installers, and comparisons, see [HISTORY.md](HISTORY.md).

## Desktop 0.8.2 — 2026-08-22

### Added

- A per-account auto-deposit search-range editor from 1 to 16 blocks, defaulting to 5.
- Line-of-sight filtering so auto-deposit only targets visible chests, trapped chests, and barrels.

### Fixed

- Turning auto-deposit off now cancels remaining queued stacks and closes its active container immediately.

## Desktop 0.8.1 — 2026-08-15

### Added

- Server resource-pack downloading, SHA-1 validation, local caching, and bounded parsing for custom server menus.
- Resource-pack item-model icons and bitmap-font container backgrounds with transparent clickable slots and Minecraft-style tooltips.

### Fixed

- Correctly handles packs whose ZIP directory reports corrupt multi-gigabyte expanded sizes without trusting those values or removing decompression limits.
- Upgraded the ZIP parser to the release that fixes its crafted-archive memory-allocation advisory.
- Crops transparent bitmap padding and aligns six-row container hitboxes with the visible 2× Minecraft GUI artwork.
- Prevents Mineflayer resource-pack rejection from writing an invalid second protocol response.
- Clearing an explicit Minecraft version now clears its stale remembered version before Auto detection or same-server stable fallback.

## Desktop 0.8.0 — 2026-08-15

### Added

- Minecraft-style gear, inventory, hotbar, and interactive server-menu grids with vanilla item icons, stack counts, durability bars, enchantment glint, and detailed hover tooltips.
- Inventory controls for moving stacks, selecting the held hotbar slot, equipping armor and off-hand gear, and locking items against dropping or automatic deposit.
- Automatic deposit support for nearby chests, trapped chests, and barrels while preserving locked items.
- Item lore and enchantment details in both account inventory and server-menu tooltips.
- Collapsible dashboard sections, overall page scrolling, persistent panel sizing, numeric display scaling, and a popup macro editor.

### Changed

- Simplified the dashboard by consolidating display, console, macro, and movement actions into compact menus and collapsed sections.
- Prioritized usable chat space and made panel contents adapt more reliably to compact and minimized window layouts.

### Fixed

- Resolved modern numeric enchantment IDs through the connected server registry so enchantment names and levels match the actual item data.
- Preserved non-level-one enchantment values instead of flattening every tooltip entry to level I.
- Kept item tooltips above popup menus and kept compact dashboard panels resizable.

## Desktop 0.7.0 — 2026-08-09

### Added

- Independent persistent drag handles for resizing the console/control columns and inventory height, with keyboard controls and double-click reset.
- A new AFK Desk application icon plus installed-version labels in the sidebar and Settings.

### Changed

- Removed the local browser dashboard, shared-access grants, Tailscale integration, and remote HTTP server while that workflow is being reconsidered.

### Fixed

- Made connection details, movement buttons, and the inventory toolbar reflow and compact as their panels are resized, while preserving a usable inventory content area.
- Prevented an auto-detected proxy lobby protocol from being remembered until the account remains stable for one minute.
- Auto-version accounts can reuse a proven explicit or stable version from another account on the same server, preventing repeated selection of a lobby-only protocol when the destination backend uses a different compatible protocol.

## Desktop 0.6.0 — 2026-08-07

### Added

- Customizable per-account anti-AFK actions for jumping, looking, sneaking, arm swinging, and bounded short walking, with randomized delays, action duration, look angle, and walking distance.
- A default-on environmental-movement toggle for water, knockback, explosions, players, and mobs, plus live water-current diagnostics in the desktop and browser dashboards.
- Configurable staggered startup logins to reduce simultaneous network and authentication load.
- Chat history with Up/Down recall and an optional, fully editable macro pad for messages and commands.
- Interface scaling and held mouse/keyboard movement controls, including WASD and Space.

### Fixed

- Improved recovery and readable reporting for DNS, timeout, refused, reset, unreachable-network, broken-pipe, and stalled-connection failures.
- Fixed modern Velocity server switching so automatic `/server` commands wait for the destination world, send complete protocol state, and do not repeat after the resulting respawn.
- Fixed the account editor's blank state, Close/Cancel controls, invalid default duration, double scrollbar, and viewport overflow.
- Fixed held movement and jump controls so button and keyboard input remain active until released.
- Reworked environmental water movement to use corrected native Mineflayer physics across supported 1.21 versions, including deep/head-level currents, block-state water levels, wall signs, diagonal corners, collision precision, and passive flow without synthetic walking or unwanted hops.
- Fixed the dashboard layout so chat, inventory, controls, dialogs, and settings remain bounded to the window and scroll only where needed.

## Desktop 0.5.0 — 2026-07-30

- Added selection and explicit dropping of individual inventory stacks.
- Added optional per-account auto-deposit into the closest chest within five blocks; it is off by default.
- Added nearby chest coordinates to the desktop and browser player-state views.
- Changed the default automatic-message delay for new accounts to five seconds.

## Desktop 0.4.1 / Mobile 0.1.0 — 2026-07-30

### Desktop

- Added Microsoft multi-account authentication with automatic IGN and skins.
- Added automatic reconnect, join messages, and server-change messages.
- Added modern Velocity server switching, chat formatting, and movement controls.
- Added proxies, startup connections, inventory, coordinates, health, and hunger.
- Added scoped browser access and fixed the console to scroll without expanding the page.
- Fixed graceful Electron shutdown and upgraded the packaged Electron runtime.

### Mobile

- Added the first standalone Android build with an embedded Mineflayer engine.
- Added the shared React Native iOS/Xcode project.
- Added an Android foreground service for background connections.
- Added account management, chat, automation, proxies, movement, and telemetry.
