# AFK Desk

AFK Desk is a free, local-first Minecraft Java connection client for Windows, Android, and iOS source builds. It keeps multiple Microsoft-authenticated accounts connected without launching the full game and has no subscriptions, analytics, or account-count limits.

> [Download the latest Windows installer and Android APK](https://github.com/legendary-cookie/afk-desk/releases/latest) · [Browse every version and source comparison](HISTORY.md)

## Highlights

- Multiple Microsoft accounts with automatic IGN and player-head discovery
- Microsoft device-code authentication without collecting passwords
- Minecraft chat colors, commands, and a fixed scrolling console
- Configurable join and server-change messages
- Automatic reconnect with exponential backoff
- Anti-AFK and manual movement controls
- Per-account SOCKS5 and HTTP CONNECT proxies
- Per-account startup connections
- Health, hunger, coordinates, dimension, and inventory views
- Modern Velocity server-switch compatibility
- Revocable, permission-scoped browser access from the desktop client
- Android foreground service for background connections

## Projects

| Project | Stack | Current version | Notes |
| --- | --- | --- | --- |
| [`desktop/`](desktop/) | Electron + Mineflayer | 0.4.1 | Windows installer and local browser dashboard |
| [`mobile/`](mobile/) | React Native + embedded Node.js | 0.1.0 | Standalone Android app and iOS Xcode source |

## Development

### Desktop

```powershell
cd desktop
npm ci
npm test
npm start
```

Build the Windows installer with `npm run dist`.

### Mobile

```powershell
cd mobile
npm ci
cd nodejs-assets/nodejs-project
npm ci --omit=dev
cd ../..
npm test -- --runInBand
npx tsc --noEmit
```

See [`mobile/BUILDING.md`](mobile/BUILDING.md) for Android and iOS build requirements.

## Responsible use

Use AFK Desk only with accounts and servers you are authorized to access. A server may prohibit AFK clients, automation, multiple accounts, or proxies. This project does not bypass Microsoft authentication, server permissions, bans, or paid third-party services.

AFK Desk is not affiliated with Mojang, Microsoft, Minecraft, Valoks, or AFK Console Client.

## License

[MIT](LICENSE)
