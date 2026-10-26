# POV View and Server Menus

AFK Desk includes an on-demand **Bot POV** dashboard for visual inspection and world interaction, plus interactive popups for custom server chest menus.

## Using the Bot POV dashboard

Click **POV** in the top bar (or select the **POV** workspace tab) to open the loaded-world dashboard. POV rendering runs only while the dialog is open, keeping background CPU and memory usage low during normal AFK sessions.

![Bot POV dashboard in focused perspective view](../images/pov-view.png)

### Grid view vs. focused view

- **Multi-bot grid**: Shows live feeds for your online accounts (up to `9` feeds by default, configurable from `1` to `12` in **Settings**). Grid view caps rendering at a lightweight frame rate to protect CPU.
- **Focused view**: Click **↗** on a bot card (or click directly on a perspective canvas) to expand that bot to a single feed at `30 FPS` or `60 FPS`. Click **← All bots** or **↙** to return to the grid.
- **View modes**: Switch **View** between **Perspective** (3D textured voxel view with sky, blocks, entities, crosshair, and HUD) and **Map** (top-down 2D slice showing nearby solid blocks, water, players, mobs, and facing direction).
- **Pause**: Click **Pause** to freeze polling and rendering without closing the dialog.

### Direct keyboard and mouse controls

When a perspective feed is clicked and focused:

- **Move**: `W`, `A`, `S`, `D`
- **Jump / Sneak / Sprint**: `Space` / `Shift` / `Ctrl`
- **Look around**: Move the mouse while pointer lock is active
- **Dig / Attack**: Hold or click **Left mouse**
- **Use / Place**: Hold or click **Right mouse**
- **Select hotbar slot**: Press `1`–`9` or scroll the mouse wheel
- **Open inventory**: Press `E` to close POV and jump to the inventory panel
- **Release mouse**: Press `Esc`

### Coordinate world actions

At the bottom of the POV dialog, you can target specific coordinates (`X`, `Y`, `Z`, and **Radius**) — or click a tile in **Map** view to fill in its coordinates — and run:

- **Look**: Rotates the bot to face `(X, Y, Z)`.
- **Walk**: Walks toward `(X, Y, Z)`.
- **Use block**: Activates/right-clicks the block at `(X, Y, Z)`.
- **Dig**: Breaks the block at `(X, Y, Z)`.
- **Attack nearest**: Attacks the nearest entity in range.
- **Use held**: Uses the item currently held in the main hand.

> **Scope note:** POV uses lightweight built-in voxel rendering of loaded chunks around the bot. It is designed for orientation, AFK spot checks, and basic interactions — not full Minecraft shader/modpack rendering.

## Server menus and resource-pack artwork

When a server command (such as `/menu`, `/warp`, or `/shop`) opens a chest GUI window, AFK Desk automatically displays the **Server menu** dialog:

- **Click to interact**: Click any slot in the popup grid to send a left-click for that slot to the server.
- **Hover tooltips**: Hover over menu items to read custom names, enchantments, and server lore instructions.
- **Custom resource-pack artwork**: When a server sends a resource pack, AFK Desk validates its SHA-1, caches it locally, and renders custom item-model icons and bitmap-font GUI container backgrounds directly in the menu popup.
- **Proxy privacy guard**: If your account connects through a proxy, AFK Desk skips downloading the server resource pack by default so a direct HTTP fetch cannot reveal your real IP address. It still sends an `accepted` packet to the server so you are not kicked, and the menu remains usable with standard item icons. See [Troubleshooting](troubleshooting.md#resource-packs-skipped-behind-a-proxy) for details.

---

**Next:** [Android App →](android.md)
