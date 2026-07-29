# AFK Desk

AFK Desk is a local-first desktop client for keeping Minecraft Java accounts connected without running the full game. It is an independent open-source application built with Electron and Mineflayer.

## Features

- Multiple Microsoft-authenticated Minecraft accounts
- Automatic Minecraft version detection
- Per-account server profiles
- Server console and chat commands
- Quick movement controls
- Configurable anti-AFK movement
- Microsoft tokens cached locally by Prismarine authentication
- No subscriptions, telemetry, or account-count limits

## Run from source

Requires Node.js 18 or newer.

```powershell
npm install
npm start
```

When connecting an account for the first time, AFK Desk displays a Microsoft device code. Open the sign-in page, enter the code, and approve access. AFK Desk never requests or stores your Microsoft password.

## Build the Windows installer

```powershell
npm run test
npm run dist
```

The installer is written to `dist/`.

## Important

Use the client only with accounts and servers you are authorized to access. Server rules may prohibit AFK clients, automation, multiple accounts, or proxies. A computer, home server, or VPS must remain powered on for 24/7 connections.

AFK Desk is not affiliated with Mojang, Microsoft, Minecraft, Valoks, or AFK Console Client.
