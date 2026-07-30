# AFK Desk

AFK Desk is a local-first desktop client for keeping Minecraft Java accounts connected without running the full game. It is an independent open-source application built with Electron and Mineflayer.

## Features

- Multiple Microsoft-authenticated Minecraft accounts
- Automatic Minecraft version detection
- Per-account server profiles
- Server console and chat commands
- Minecraft chat colors and text formatting
- Authenticated player-head avatars using official Minecraft textures
- Automatic IGN detection from the authenticated Minecraft profile
- Persistent account ordering with drag-and-drop and keyboard-accessible controls
- Per-account SOCKS5 and HTTP CONNECT proxies with Windows-encrypted passwords
- Optional Windows sign-in startup and per-account automatic connection
- Live HP, hunger, coordinates, dimension, and inventory views
- Change-only player-state updates and reduced chunk distance for lower resource use
- Quick movement controls
- Configurable anti-AFK movement
- Configurable automatic reconnect with exponential backoff
- Separate automatic messages for initial join and later server/world changes
- Velocity proxy server-switch compatibility for modern Minecraft versions
- Fresh, isolated Microsoft sign-in window for each account
- Mobile-friendly browser dashboard
- Revocable browser links scoped to selected accounts and permissions
- Microsoft tokens cached locally by Prismarine authentication
- No subscriptions, analytics, or account-count limits

## Run from source

Requires Node.js 22 or newer.

```powershell
npm install
npm start
```

When connecting an account for the first time, AFK Desk displays a Microsoft device code. Open the sign-in page, enter the code, and approve access. AFK Desk never requests or stores your Microsoft password.

Optional proxy passwords are encrypted with Electron safe storage, backed by Windows credential protection. They are never returned to the desktop renderer or browser dashboard.

Use **Sign in with a different account** to open a fresh in-app Microsoft window with no cookies from your normal browser. This makes choosing a different Microsoft account predictable.

## Browser and shared access

Open **Browser access** in the desktop sidebar. The dashboard listens only on `127.0.0.1`, so it is not public by default.

For access from your phone or another person:

1. Install and sign in to Tailscale on the AFK Desk computer.
2. Click **Enable with Tailscale** in AFK Desk.
3. If sharing outside your tailnet, share the computer with that Tailscale user.
4. Select only the AFK Desk accounts and permissions that person needs.
5. Create and send their access link. Treat it like a password.

Each link is stored as a SHA-256 hash, uses an HTTP-only browser cookie, and can be revoked from the desktop app. Remote actions are authorized on the server for every request. AFK Desk does not expose a public internet port.

## Build the Windows installer

```powershell
npm run test
npm run dist
```

The installer is written to `dist/`.

## Important

Use the client only with accounts and servers you are authorized to access. Server rules may prohibit AFK clients, automation, multiple accounts, or proxies. A computer, home server, or VPS must remain powered on for 24/7 connections.

AFK Desk is not affiliated with Mojang, Microsoft, Minecraft, Valoks, or AFK Console Client.
