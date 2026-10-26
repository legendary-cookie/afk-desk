# Android App

AFK Desk Mobile (`mobile/`) is a standalone Android client built with React Native and an embedded Node.js + Mineflayer runtime. It runs entirely on your phone or tablet and does **not** require a Windows PC to stay powered on.

## 1. Install the Android APK

1. On your Android device (Android 7.0 or newer, ARM64 or 32-bit ARM), download `AFK-Desk-Android-0.9.2.apk` from the [v0.9.2 release](https://github.com/legendary-cookie/afk-desk/releases/tag/v0.9.2).
2. Open the downloaded `.apk` file. If prompted by Android, allow installation from your browser or file manager.
3. When upgrading from an earlier release, install the new APK directly over the existing app (in-place update) so your saved accounts, Microsoft token cache, and proxy credentials are preserved.

## 2. Keeping connections alive in the background

AFK Desk Mobile runs an **Android foreground service** while any account is connected or reconnecting. To prevent aggressive OEM battery savers from suspending your session when the screen is off:

1. **Allow the foreground notification**: Android requires a persistent status notification for foreground services. Keep notifications enabled for AFK Desk so you can see connection state and keep the service active.
2. **Disable battery optimization for AFK Desk**:
   - Open your device's **Settings → Apps → AFK Desk → Battery**.
   - Select **Unrestricted** (or **Don't optimize**).
3. **Allow background data**: Under **Settings → Apps → AFK Desk → Mobile data & Wi-Fi**, ensure **Background data** is enabled if you use mobile data or switch networks.

## 3. Supported features on Android 0.9.2

The Android 0.9.2 release shares the same 28 Java Edition protocol versions (`1.8.8` through `1.21.11`) as the Windows client and supports:

- Multiple ordered Microsoft accounts with browser-based device-code sign-in
- Automatic or explicit Minecraft version selection (`1.8.8`–`1.21.11`)
- Scrolling chat with Minecraft color formatting, `Follow latest` pause/resume when scrolling up, command/player-name completion, and tappable chat click actions
- Configurable initial-join and server-change messages
- Per-account auto-reconnect with exponential backoff and anti-AFK actions
- Manual movement and look controls, plus directional water-current physics
- Per-account SOCKS5 and HTTP proxies
- Live health, hunger, coordinates, dimension, and inventory inspection
- Confirmed per-stack item dropping
- Cancellable per-account auto-deposit into visible chests and barrels (`1`–`16` block range)
- Interactive server chest menus with bounded resource-pack bitmap and custom item-model rendering

## 4. Mobile limitations and differences from Windows

- **Desktop-only beta features**: The 3D/map **Bot POV** dashboard, visual **Automations** dialog, and **Bedrock Edition (experimental)** mode introduced in Windows `0.10.0-beta.9` are currently desktop-only.
- **iOS status**: The repository includes the shared React Native iOS/Xcode source (`mobile/ios`), which requires macOS, Xcode, and personal code signing to build (see [`mobile/BUILDING.md`](../../mobile/BUILDING.md)). Because iOS suspends background TCP sockets shortly after an app leaves the foreground, continuous background AFK operation is supported on Android only.
- **Building from source**: See [`mobile/BUILDING.md`](../../mobile/BUILDING.md) for JDK 17, Android SDK/NDK, and signing configuration details.

---

**Next:** [Macros (Coming in 0.11 / In Development) →](macros.md)
