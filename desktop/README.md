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
- Optional Windows sign-in startup and per-account automatic connection with configurable staggering
- Live HP, hunger, coordinates, dimension, armor, inventory, and remaining item durability
- Minecraft-style gear, inventory, and hotbar grids with vanilla item textures, counts, durability bars, enchantment glint, and Minecraft-like hover tooltips
- Drag or move stacks between slots, select the held hotbar item, and equip armor or off-hand gear
- Select, lock/unlock, and safely drop a specific inventory stack; locked stacks are protected from drops and auto-deposit
- Optional per-account auto-deposit into the closest chest, trapped chest, or barrel, with traceable coordinates
- Interactive Minecraft-style popup for chest menus opened by server commands, using the same icons and tooltip details
- Change-only player-state updates and reduced chunk distance for lower resource use
- Quick movement controls
- Configurable anti-AFK actions, randomized timing, duration, look angle, and bounded walking distance
- Default-on environmental movement for water, knockback, explosions, and nearby entity pushing, with optional position holding
- Configurable automatic reconnect with exponential backoff, readable network errors, and stalled-session recovery
- Separate automatic messages for initial join and later server/world changes
- Velocity proxy server-switch compatibility for modern Minecraft versions
- Fresh, isolated Microsoft sign-in window for each account
- Independently resizable console, controls, and inventory panels
- Persistent interface scaling and panel layout
- Microsoft tokens cached locally by Prismarine authentication
- No subscriptions, analytics, or account-count limits

## Run from source

Requires Node.js 22 or newer.

```powershell
npm install
npm start
```

When connecting an account for the first time, AFK Desk displays a Microsoft device code. Open the sign-in page, enter the code, and approve access. AFK Desk never requests or stores your Microsoft password.

Optional proxy passwords are encrypted with Electron safe storage, backed by Windows credential protection. They are never returned to the desktop renderer.

Use **Sign in with a different account** to open a fresh in-app Microsoft window with no cookies from your normal browser. This makes choosing a different Microsoft account predictable.

## Build the Windows installer

```powershell
npm run test
npm run dist
```

The installer is written to `dist/`.

## Important

Use the client only with accounts and servers you are authorized to access. Server rules may prohibit AFK clients, automation, multiple accounts, or proxies. A computer, home server, or VPS must remain powered on for 24/7 connections.

AFK Desk is not affiliated with Mojang, Microsoft, Minecraft, Valoks, or AFK Console Client.
