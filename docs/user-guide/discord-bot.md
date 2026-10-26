# Discord Bot Control

AFK Desk allows you to monitor and control your Minecraft accounts directly from Discord using native slash commands (`/afk`).

The bot operates over the shared, bounded command layer, ensuring that permissions, validation, and confirmation guards are enforced consistently.

---

## 1. Creating the Discord Application & Bot

### Step 1: Create an Application in the Developer Portal

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Log in with your Discord account and click **New Application** (top right).
3. Name your application (e.g. `AFK Desk`) and accept the Developer Terms.

### Step 2: Set up the Bot user

1. In the left navigation menu, click **Bot**.
2. Click **Add Bot** (if prompted) or verify the default bot user.
3. Under **Token**, click **Reset Token** (and enter your 2FA code if prompted). Copy the new **Bot Token** and store it securely.

> [!IMPORTANT]
> **Privileged Gateway Intents are NOT required.**
> In the **Privileged Gateway Intents** section, leave **Message Content Intent**, **Server Members Intent**, and **Presence Intent** **OFF**.
> AFK Desk interacts exclusively via Discord slash commands and button interactions, which only require the standard **Guilds intent** (`GatewayIntentBits.Guilds === 1`).

### Step 3: Generate an Invite Link

1. In the left menu, navigate to **OAuth2 → URL Generator**.
2. Under **Scopes**, select:
   - `applications.commands` (registers `/afk` slash commands)
   - `bot` (allows the bot to join your server)
3. Under **Bot Permissions**, select:
   - **Send Messages**
   - **Use Slash Commands**
   - **Embed Links**
4. Copy the generated URL at the bottom of the page, open it in your browser, select your Discord server, and click **Authorize**.

---

## 2. Configuring AFK Desk

In AFK Desk (desktop app or headless server UI), open **Settings** (or edit your configuration):

```json
{
  "discord": {
    "enabled": true,
    "botToken": "MTIzNDU2...",
    "guildIds": ["123456789012345678"],
    "channelIds": ["234567890123456789"],
    "users": {
      "345678901234567890": "admin",
      "456789012345678901": "control",
      "567890123456789012": "read"
    },
    "roles": {
      "678901234567890123": "read"
    },
    "notifyChannelId": "234567890123456789",
    "publicReplies": false
  }
}
```

### Configuration fields reference

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Set to `true` to start the bot. |
| `botToken` | string | Secret Discord bot token. Encrypted at rest with AES-256-GCM. |
| `guildIds` | array of strings | **Required.** List of allowed Discord Server (Guild) IDs. Direct messages (DMs) and commands from unlisted servers are rejected immediately. |
| `channelIds` | array of strings | Optional list of allowed text channel IDs. If specified, commands issued in any other channel are rejected. |
| `users` | object | Map of `discord_user_id` → scope (`"read"`, `"control"`, or `"admin"`). |
| `roles` | object | Optional map of `discord_role_id` → scope. A user's effective scope is the highest level granted between their user ID and member roles. |
| `notifyChannelId` | string \| null | Optional channel ID where outbound notification alerts should be posted. |
| `publicReplies` | boolean | Defaults to `false`. When `false`, command responses are visible only to the invoking user. |

---

## 3. Available `/afk` Slash Commands

All interactions use subcommands of `/afk`:

| Command | Required Scope | Danger Level | Description |
| --- | --- | --- | --- |
| `/afk status` | `read` | `none` | Displays a table of all configured accounts, connection state, server address, health, food, and uptime. |
| `/afk connect <account>` | `control` | `none` | Connects the specified account. The `<account>` argument provides interactive autocomplete of accounts you can access. |
| `/afk disconnect <account>` | `control` | `confirm` | Disconnects the account. Prompts with interactive Confirm / Cancel buttons. |
| `/afk reconnect <account>` | `control` | `none` | Immediately disconnects and reconnects the account. |
| `/afk chat <account> <message>` | `control` | `none` | Sends a chat message or server command (up to 256 characters) from the account. |
| `/afk recent-chat <account> [limit]` | `read` | `none` | Shows the last 1–50 lines of in-game chat for the account, with color codes stripped. |
| `/afk inventory <account>` | `read` | `none` | Displays equipped armor, off-hand item, and active inventory items. |
| `/afk macro run <account> <macro>` | `control` | `none` | Runs a named macro on the target account (supports autocomplete). |
| `/afk macro stop <account>` | `control` | `none` | Stops any macro currently running on the account. |
| `/afk antiafk <account> <enabled>` | `control` | `none` | Toggles anti-AFK actions on or off for the account. |
| `/afk connect-all` | `control` | `confirm` | Connects all configured accounts simultaneously (prompts for confirmation). |
| `/afk disconnect-all` | `control` | `confirm` | Disconnects all accounts simultaneously (prompts for confirmation). |

---

## 4. Interactive Confirmations

Commands with destructive potential (such as `/afk disconnect`, `/afk disconnect-all`, and `/afk connect-all`) are flagged with danger `confirm`:

1. When issued, the bot replies with a confirmation prompt and two interactive buttons: **Confirm** (danger red) and **Cancel** (gray).
2. **60-Second TTL**: The confirmation token expires automatically after 60 seconds if neither button is clicked.
3. **Invoker Binding**: Only the specific Discord user who typed the slash command can click Confirm or Cancel. If another server member clicks the button, Discord displays an ephemeral notice:
   `Only the user who initiated this command can confirm or cancel it.`
4. **Single-Use Nonce**: Once clicked, the nonce is consumed immediately to prevent replay attacks.

---

## 5. Ephemeral Replies & Privacy

- **Ephemeral by default**: Every slash command reply is marked `ephemeral: true`. Only you can see the response in Discord; other channel members see nothing.
- **Optional public replies**: If you set `"publicReplies": true`, successful command results (such as status tables) are posted publicly in the channel. Confirmations, errors, and unauthorized notices remain strictly ephemeral.
- **Mention neutralization**: Any in-game chat text, player name, or server message displayed in Discord has all mentions neutralized (`allowed_mentions: { parse: [] }`). A malicious player on your Minecraft server typing `@everyone` or `@here` cannot trigger Discord pings.

---

## 6. Security & Audit Notes

- **Strict guild isolation**: The bot ignores Direct Messages (DMs) and commands from any server not explicitly listed in `guildIds`.
- **User flood protection**: A rate limiter prevents command spam, allowing a maximum of 10 commands per 10-second window per user.
- **Credential redaction**: The bot token, proxy credentials, and server secrets are automatically filtered through `redactSecrets()` before any message or log is emitted.
- **Comprehensive auditing**: Every slash command invocation, button click, and unauthorized attempt is recorded in AFK Desk's local audit trail with the actor's Discord user ID, timestamp, target account, and result (`allowed`, `denied`, or `forbidden`).

---

**Next:** [Bedrock Edition →](bedrock.md)
