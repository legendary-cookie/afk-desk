# Lightweight POV Release Implementation Plan

**Goal:** Deliver and install a familiar lightweight Minecraft POV and controls, preserving AFK Desk's existing features and user data.

**Architecture:** Keep the protocol engine and canvas renderer; no Minecraft JVM or full game. Extract the rendering hot path into a bounded reusable module, add original lightweight surface textures and shape-aware rendering, and keep unsupported mechanics explicit. Independent backend compatibility and input contracts are verified before packaging.

**Tech Stack:** Existing Electron, Canvas2D, Mineflayer, Node test runner and browser smoke tests.

**Spec:** User's 2026-09-06 clarification: lightweight game-like approximation, not exact parity, improve compatibility/cleanup/optimization, install locally.

## Global Constraints

- Preserve installed data, original app archive, and existing functionality.
- Do not run a real Minecraft client or silently execute mod JARs.
- Use bounded geometry/render caches and suspend unnecessary background work.
- Do not claim universal mod support from loader names or handshake spoofing.
- Install only after local tests and isolated packaged startup; retain rollback.

## Tasks

- [x] Rendering: extract `desktop/assets/pov-renderer.js`; consume snapshot blocks/position/yaw/pitch; produce reusable pixel frame with distinct original block surface patterns, side/top differences, fog and non-full shapes. Cache block index/frame buffers. Add deterministic renderer tests and browser visual fixture.
- [x] Backend/controls: extend `worldSnapshot` with shape/held-slot information; add validated crosshair dig/use/place and hotbar selection to `worldAction`; wire mouse/buttons/keys without stealing input from forms. Regression-test range, invalid selection, stale controls and cleanup.
- [x] Compatibility: test existing Fabric/Quilt/NeoForge/Forge profiles; correct supported adapter behavior and label capabilities accurately rather than claiming arbitrary payload emulation. Preserve explicit selections. Add adapter tests.
- [x] Verification: run desktop unit/integration matrices, mobile regressions affected by shared contracts, browser smoke with nonempty world fixtures; inspect screenshot and record limitations.
- [x] Release: set beta.8 version; install Electron/build runtime if absent, package Windows app, smoke test with isolated user-data directory, back up installed files/data without printing secrets, install and verify version/startup. Abort replacement if backup/build fails.

## Execution record

Start: clean recovery/installed-beta-7 at 466f0ee. User explicitly authorized implementation and installation; no additional design approval requested. Current workspace is isolated from installed application files. Root owns packaging/integration; independent agents own renderer, engine and compatibility modules without overlapping edits.

Completion: lightweight renderer, controls, bounded compatibility corrections and beta.8 installation delivered. Desktop suite 222/222; final Edge smoke, syntax/diff checks, NSIS build, packaged and installed isolated startup all exit 0. Installed archive matches build; all 103 saved-data files unchanged, including 8 accounts. Source was frozen before the final rebuild after discovering a concurrent-edit ASAR corruption in the initial build. Full evidence and remaining compatibility/runtime boundaries are recorded in workspace outputs/BETA8-RELEASE-REPORT.md. Task checkboxes above describe the intended scope; compatibility is bounded and no universal mod support or real-server acceptance is claimed.
