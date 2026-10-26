# Anti-AFK and Auto-Reconnect

AFK Desk includes configurable per-account anti-AFK actions, passive environmental movement, automatic join messages, and exponential backoff reconnects.

> **Responsible use:** Always follow each server's rules. AFK Desk does not bypass captchas or anti-bot checks.

## Configuring Anti-AFK

1. Select an account and click **Edit**.
2. Enable **Enable anti-AFK**.
3. Choose one or more actions from the **Anti-AFK actions** group:
   - **Jump** (enabled by default)
   - **Look around** (enabled by default)
   - **Sneak**
   - **Swing arm**
   - **Short walk** (alternates short forward and backward movement within a bounded distance; off by default)
4. Adjust timing and motion bounds:
   - **Minimum delay (seconds)** and **Maximum delay (seconds)**: AFK Desk picks a randomized interval between these bounds before each action (default `45` seconds).
   - **Action duration (seconds)**: How long each held action lasts (default `0.25` seconds).
   - **Look angle (degrees)**: Maximum camera turn per look action (default `12` degrees).
   - **Maximum walking distance (blocks)**: Distance cap when **Short walk** is enabled (default `0.5` blocks, up to `8` blocks).
5. Click **Save account**. Changes apply immediately, including to accounts that are already online.

## Environmental movement and water currents

By default, **Allow environmental movement** is enabled on every Java profile:

- **Enabled (default)**: Native Mineflayer physics stay active so water currents (AFK pools), pistons, knockback, explosions, and nearby entities move the player naturally. The **Connection** panel reports live **Water current** status (such as `Not in water`, `Water detected, no horizontal current`, or `Flow x …, z …`).
- **Disabled (Position held)**: Pauses passive environmental physics while still allowing manual movement controls (`WASD` and `Jump` in the **Movement** panel or POV view).

## Automatic join and world-change messages

Many servers require running a command after connecting (such as `/server survival` on a proxy lobby or `/afk` after entering a world).

In the account editor under **Automatic messages**:

- **On server join**: Sent once after the initial connection spawns and the world is ready.
- **On server/world change**: Sent after a subsequent `respawn` or proxy backend transfer (such as switching servers on a Velocity network).
- **Wait after the server is ready (seconds)**: Delay before sending the message (default `6` seconds).

For manual one-click commands while online, use the **Macro pad** below the chat input (click **⋯ → Edit macros** to add buttons like `/spawn` or `/server towny`).

## Configuring Auto-Reconnect

When a connection drops or the server kicks the account, AFK Desk can automatically reconnect with exponential backoff and jitter:

1. In the account editor, enable **Auto reconnect**.
2. Configure the retry behavior:
   - **First retry (seconds)**: Initial wait before the first reconnect attempt (default `5` seconds).
   - **Maximum retries**: Total attempts before stopping (`0` keeps retrying indefinitely).
   - **Backoff multiplier**: Multiplies the wait time after each consecutive failure (default `2`).
   - **Maximum reconnect delay (seconds)**: Upper cap on the backoff delay (default `300` seconds).
   - **Rate-limit minimum (seconds)**: Minimum delay used when the server kick message indicates rate limiting or `"logging in too fast"` (default `30` seconds).
   - **Connection timeout (seconds)**: Aborts a stalled handshake that does not finish within this window (default `60` seconds) so auto-reconnect can retry.
   - **Stable connection reset (seconds)**: Resets the retry counter back to zero once the account stays online for this duration (default `60` seconds).

To cancel a pending reconnect, click **Cancel reconnect** in the top bar.

---

**Next:** [Inventory and Auto-Deposit →](inventory-and-auto-deposit.md)
