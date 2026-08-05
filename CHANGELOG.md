# Changelog

For the complete desktop history from 0.1.0 onward, including source tags, installers, and comparisons, see [HISTORY.md](HISTORY.md).

## Desktop 0.6.1 — 2026-08-05

### Fixed

- Fixed account editor toggles scrolling the entire form, header, and Save button out of view.
- Fixed modern Velocity `/server` commands sending incomplete raw packets that could cause a generic internal connection error.
- Added a bounded flowing-water current fallback when the normal Mineflayer physics calculation stalls.

## Desktop 0.6.0 — 2026-08-05

### Added

- Added per-account anti-AFK action selection for jump, look, sneak, arm swing, and bounded short walking.
- Added randomized minimum/maximum delays, action duration, look angle, and walking-distance controls.
- Added an environmental-movement toggle, enabled by default, for water, knockback, explosions, and nearby entity pushing.
- Added a global, toggleable delay between startup account connections; the default is three seconds.

### Fixed

- Added friendly handling and recovery for common DNS, timeout, refused, reset, unreachable-network, and broken-pipe failures.
- Added a connection watchdog so stalled sessions can enter the existing automatic-reconnect flow.
- Fixed the account editor close and Cancel buttons and removed its competing second scrollbar.

### Changed

- Startup accounts now connect in a staggered sequence by default to reduce network and authentication spikes.
- Anti-AFK randomly performs one enabled action per cycle, avoiding conflicting action combinations.

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
