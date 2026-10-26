# Troubleshooting

This page covers common connection, version, authentication, proxy, and local storage issues in AFK Desk.

## Connection failures and network errors

- **`ENOTFOUND` / DNS lookup failed**: Check the **Server address** and **Port** in **Edit account**. If the server uses an SRV record on a custom domain and automatic resolution fails, enter the underlying hostname and port directly.
- **`ECONNREFUSED` / `ETIMEDOUT` / `ECONNRESET`**:
  - Verify the server is online and reachable from your network.
  - If **Use a proxy for this account** is enabled, confirm the proxy type (`SOCKS5` vs. `HTTP CONNECT`), host, port, username, and password are valid.
  - Increase **Connection timeout (seconds)** (up to `300` seconds) if connecting through a slow proxy or heavily loaded lobby.
- **`Logging in too fast` or rate-limit kicks**:
  - In **Edit account**, increase **Rate-limit minimum (seconds)** (default `30` seconds).
  - If connecting many accounts at launch, open **Settings**, enable **Stagger startup account logins**, and increase **Delay between accounts (seconds)**.

## Version mismatch or proxy server-switch kicks

- **Lobby hides the backend version**: Some BungeeCord or Velocity networks advertise a broad range of versions on the status ping (such as `1.8.x–1.21.x`), while the destination sub-server requires a specific version (such as `1.20.4`). Open **Edit account** and set **Minecraft version** explicitly to the backend server's version instead of **Automatic**.
- **Unsupported version error**: AFK Desk supports 28 complete Java Edition bot versions from `1.8.8` through `1.21.11`. Protocol-only `1.7` is not supported because Mineflayer rejects it before login.
- **Kicked when switching servers (`/server`) on 1.20.2+**: Ensure you are running AFK Desk **0.9.1 or newer** (`0.9.2` stable or `0.10.0-beta.9`), which automatically pauses movement, tick, chat, and inventory packets while the connection is in the modern `configuration` state during a proxy transfer.
- **Modded server rejections**: Vanilla-compatible plugin servers (Paper, Spigot, Purpur, Velocity) work out of the box. If a server requires client-side Fabric/Forge mods that execute custom code or modern NeoForge `1.20.4+` configuration payloads, see [Lightweight Client Compatibility](../COMPATIBILITY.md) for what protocol handshakes are supported.

## Microsoft sign-in issues

- **Signing in with the wrong Microsoft account**: Your default web browser may auto-sign in with an already logged-in Microsoft account. When the **Microsoft sign-in** dialog appears in AFK Desk, click **Sign in with a different account** instead of **Use my default browser**. This opens an isolated in-app HTTPS window with no shared browser cookies.
- **Device code expired**: Close the sign-in dialog, click **Disconnect** (if still connecting), and click **Connect** again to request a fresh code.
- **Proxy password cannot be decrypted**: If Windows user credentials change or `accounts.json` is moved to a different Windows machine, Electron `safeStorage` cannot decrypt the old proxy password. Open **Edit account**, enter the proxy password again (or check **Clear the previously saved proxy password**), and click **Save account**.

## Resource packs skipped behind a proxy

When an account connects through a SOCKS5 or HTTP proxy and the server offers a custom resource pack, the console logs:

> `Server resource pack not downloaded: this account uses a proxy and the download would bypass it. The pack was accepted so the server will not kick; custom menu art is off.`

**Why this happens:**
- Resource-pack HTTP downloads cannot be routed through the game's SOCKS5/HTTP proxy. Downloading the pack directly would expose your real IP address to the server's resource-pack host.
- To protect your IP privacy while preventing the server from kicking your account for declining a required pack, AFK Desk sends an `accepted` response to the server without downloading the ZIP file.
- Standard gameplay, chat, and clicking slots in server menus continue to work normally; only custom resource-pack icons and bitmap backgrounds in popup menus are omitted.

Similarly, if a server offers a resource pack hosted on a private or loopback IP address (`127.0.0.1`, `10.x.x.x`, `192.168.x.x`), AFK Desk blocks the download by default and still accepts the pack packet so the account stays online.

## Storage warnings

AFK Desk protects your local data files (`accounts.json`, `settings.json`, and `events/*.jsonl`) from corruption:

- **`Event history could not be saved (ENOSPC / EACCES)` toast**: Persistent event logs (`events/<profileId>.jsonl`, bounded to 8 MB per profile) could not be written to disk. Live chat, telemetry, and bot connections continue running normally in memory. Check free disk space on your system drive and verify that your Windows user account has write permission to `%APPDATA%\afk-desk` (or the app's user-data folder).
- **`AFK Desk storage needs attention` / `Cannot safely read accounts.json`**: If `accounts.json` or `settings.json` was manually edited and contains invalid JSON, AFK Desk refuses to overwrite it with an empty file so your existing profile data is never lost. Close AFK Desk, repair the JSON syntax (or restore a backup of `accounts.json`), and restart the app.

---

**Next:** [FAQ →](faq.md)
