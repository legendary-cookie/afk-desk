# Changelog

For the complete desktop history from 0.1.0 onward, including source tags, installers, and comparisons, see [HISTORY.md](HISTORY.md).

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
