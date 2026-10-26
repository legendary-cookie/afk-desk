# Notifications (available in 0.11 (pre-release))

> **Status: available in 0.11 (pre-release).**
> Windows `0.10.0-beta.9` supports local desktop notifications (in **Settings → Desktop notifications** and per-account **Alerts**). Outbound **Discord webhook** and **Telegram bot** channels are currently in development for `0.11` (see [`desktop/electron/notify/contract.cjs`](../../desktop/electron/notify/contract.cjs)) and are not yet in a published release.

## How outbound notifications work

The notification service sends **outbound-only** alerts from your machine to your Discord server or Telegram chat when key account events happen.

- **Outbound only**: AFK Desk never accepts remote commands from Discord or Telegram and never opens an inbound port.
- **Smart batching & rate limits**: Events occurring within a `2-second` window are grouped into a single message (up to 10 events per batch, with a minimum 1-second interval per channel) to avoid rate limits.
- **Fault tolerance**: Sending is fire-and-forget and never blocks gameplay or macros. If a channel fails 3 times in a row, AFK Desk pauses that channel for 5 minutes and logs a single warning.
- **Up to 10 channels**: Each channel can subscribe to a custom subset of events and apply either to all accounts or to selected accounts.

## Supported alert events

Each Discord or Telegram channel can subscribe to any combination of these event kinds:

| Event kind | When it fires |
| --- | --- |
| `connected` | Account finishes joining a server |
| `disconnected` | Connection is lost (includes disconnect reason) |
| `kicked` | Server kicks the account (includes kick reason) |
| `banned` | Kick reason matches a ban message |
| `reconnecting` | Auto-reconnect is scheduled (includes retry delay in seconds) |
| `death` | Account dies in-game |
| `lowHealth` | Health crosses below the configured threshold |
| `inventoryFull` | All inventory slots become occupied |
| `macro` | A macro runs a `notify` step or a macro run fails |
| `test` | Triggered immediately when you click **Send test message** |

## Setting up a Discord Webhook

1. In Discord, open the server and text channel where you want to receive AFK Desk alerts.
2. Click the gear icon (**Edit Channel**) next to the channel name → **Integrations** → **Webhooks**.
3. Click **New Webhook**, give it a name (such as `AFK Desk Alerts`), and click **Copy Webhook URL**.
   - The URL will look like `https://discord.com/api/webhooks/<id>/<token>` (or `discordapp.com`, `canary.discord.com`, `ptb.discord.com`).
4. In AFK Desk (once 0.11 is released), add a **Discord** notification channel, paste the webhook URL, choose which events and accounts to monitor, and click **Test**.

## Setting up a Telegram Bot and Chat ID

1. Open Telegram and start a chat with the official **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts to choose a display name and a username ending in `bot`.
3. Copy the **HTTP API token** that `@BotFather` gives you (formatted like `123456789:AAH...`).
4. **Get your Chat ID**:
   - **For a direct message**: Open a chat with your new bot and send it a message (such as `hello`). Then open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in your browser and look for `"chat":{"id":123456789}` in the JSON response.
   - **For a group or channel**: Add your bot to the group or channel, post a message, and check `getUpdates` for the negative numeric chat ID (such as `-1001234567890`), or use a public `@channelusername`.
5. In AFK Desk (once 0.11 is released), add a **Telegram** notification channel, enter your **Bot Token** and **Chat ID**, select your events, and click **Test**.

## Privacy and security notes

- **Encrypted at rest**: Webhook URLs and Telegram bot tokens are encrypted locally using Electron `safeStorage` (Windows credential protection) and are only decrypted in memory when sending.
- **Redacted everywhere**: Every log line, error message, diagnostic report, and profile export passes through `redactSecrets()`, replacing any webhook URL or bot token with `[redacted]`.
- **No emails transmitted**: Outbound alert payloads include only your profile/Minecraft display name, server hostname, event kind, and plain-text summary — never your Microsoft account email address, tokens, or proxy credentials.
- **Strict host allowlist**: Outbound requests are restricted to HTTPS on `discord.com` (`discordapp.com`, `canary.discord.com`, `ptb.discord.com`) and `api.telegram.org` with redirects disabled.

---

**Next:** [Self-Hosting & Server Mode →](self-hosting.md)
