# Frequently Asked Questions (FAQ)

## Does AFK Desk see or store my Microsoft password?

No. AFK Desk uses Microsoft's official OAuth device-code flow via Prismarine Auth. You enter a one-time code on `https://microsoft.com/link` in your browser or an isolated Microsoft sign-in window. Only the resulting authentication tokens are cached locally in your application user-data directory.

## Does AFK Desk send telemetry, analytics, or account data to any external server?

No. AFK Desk is local-first with zero telemetry, analytics, or subscription checks. It connects only to Microsoft's authentication endpoints, `textures.minecraft.net` (for player-head avatars), the Minecraft servers and proxies you configure, and (if you opt in when 0.11 ships) your own Discord webhook or Telegram bot.

## Will AFK Desk bypass server captchas or anti-bot plugins?

No. AFK Desk does **not** bypass captchas, anti-bot verification, server bans, or authentication checks. You must follow each server's rules regarding AFK clients, automation, multiple accounts, and proxies.

## How many accounts can I run at the same time?

AFK Desk imposes no artificial limit on the number of accounts or profiles. Because it does not run the full Minecraft rendering engine or Java Virtual Machine, each connected account uses only a fraction of the RAM and CPU of a full game client. When connecting many accounts at startup, keep **Stagger startup account logins** enabled in **Settings**.

## Which Minecraft versions and editions are supported?

- **Java Edition**: 28 complete bot versions from **1.8.8 through 1.21.11** on both Windows and Android (`1.8.8`, `1.9.4`, `1.10.2`, `1.11.2`, `1.12.2`, `1.13.2`, `1.14.4`, `1.15.2`, `1.16.5`, `1.17.1`, `1.18.2`, `1.19`, `1.19.2`, `1.19.3`, `1.19.4`, `1.20`, `1.20.1`, `1.20.2`, `1.20.4`, `1.20.6`, `1.21.1`, `1.21.3`, `1.21.4`, `1.21.5`, `1.21.6`, `1.21.8`, `1.21.9`, `1.21.11`).
- **Bedrock Edition (experimental on Windows beta)**: Supports Microsoft authentication, connecting, chat, commands, auto-reconnect, and basic health/hunger/position telemetry. Movement, inventory transactions, POV block rendering, and TCP proxies are not enabled for Bedrock.

## Can I join modded servers (Forge, Fabric, NeoForge, Paper, Velocity)?

- **Plugin & proxy servers (Paper, Spigot, Purpur, BungeeCord, Velocity)**: Fully supported using the standard Java protocol, including modern 1.20.2+ configuration-phase server transfers.
- **Mod loaders (Fabric, Quilt, Forge, legacy NeoForge)**: AFK Desk can send configured client brands, optional plugin channel registrations, and legacy Forge FML1/FML2/FML3 handshakes for servers that allow lightweight protocol clients. However, AFK Desk does not execute Java client mods, synchronize custom block/entity registries, or implement NeoForge 1.20.4+ configuration-phase mod negotiation. See [Lightweight Client Compatibility](../COMPATIBILITY.md).

## Does the POV view slow down my computer while AFK?

No. World snapshots and voxel rendering are computed **only while the Bot POV dialog is open**. When the POV dialog is closed, zero rendering work runs in the background. While open, grid view caps frame rate to save CPU, and you can adjust refresh interval, render radius (`2`–`12` blocks), and maximum live feeds in **Settings**.

## Can I use the Android app without a PC?

Yes. The Android APK embeds its own Node.js and Mineflayer engine on the device and uses an Android foreground service to stay connected in the background without a computer. See the [Android App guide](android.md).

## Where are my settings, accounts, and logs stored on Windows?

All local data is stored in your Electron user-data folder (`%APPDATA%\afk-desk`):

- `accounts.json` — Account and server profiles (proxy passwords are encrypted via Windows Data Protection API).
- `settings.json` — Application preferences, layout sizes, and chat macro pad buttons.
- `profiles/` — Local Prismarine Auth Microsoft token caches per identity.
- `events/` — Bounded per-profile event history (`*.jsonl`, up to 8 MB per profile, with secrets redacted).
- `resource-packs/` — Validated, cached server resource packs for custom menu rendering.

---

**Next:** [Back to User Guide Overview →](index.md)
