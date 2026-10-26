# API Tokens & Automation

AFK Desk provides a REST API and real-time WebSocket interface for integrating with external automations, scripts, Home Assistant, and monitoring dashboards.

Access is authenticated using bearer **API tokens**, which operate under strict cryptographic boundaries and fine-grained permission scopes.

---

## Token scopes

Every API token is granted one of three hierarchical permission scopes:

```text
admin ⊃ control ⊃ read
```

| Scope | What it can do | Common use cases |
| --- | --- | --- |
| **`read`** | • Query account status and health (`status`, `account.info`)<br>• View recent chat lines (`chat.recent`)<br>• Inspect inventory contents and locked slots (`inventory.view`)<br>• List macros and macro execution history (`macro.list`, `macros:runs`)<br>• View proxy health metrics (`proxy:health`)<br>• Subscribe to read-only WebSocket events (`/ws`) | Home Assistant sensor dashboards, Prometheus/Grafana exporters, read-only uptime monitors. |
| **`control`** | • Everything permitted by `read`<br>• Connect, disconnect, and reconnect accounts (`account.connect`, `account.disconnect`, `account.reconnect`)<br>• Send in-game chat messages and commands (`chat.send`)<br>• Run and stop macros (`macro.run`, `macro.stop`)<br>• Toggle anti-AFK state (`antiAfk.set`)<br>• Drop inventory items (`inventory.drop`)<br>• Connect or disconnect all accounts simultaneously (`connectAll`, `disconnectAll`) | Cron jobs, external alert scripts, webhook triggers, game chat bridges. |
| **`admin`** | • Everything permitted by `control`<br>• List, create, and revoke API tokens (`/api/tokens`)<br>• Send test notifications (`notify.test`)<br>• Inspect audit logs (`audit.recent`)<br>• Manage accounts and macro definitions (`accounts:save`, `macros:save`) | Administrative automation scripts, CI/CD provisioning pipelines. |

---

## Creating and revoking API tokens

### Token format and storage security

- **Token string format**: `afk_<id>_<secret>` (for example, `afk_a1b2c3d4e5f60718_9f8e7d6c5b4a3...`).
- **Scrypt hashing**: The plaintext secret is **never stored on disk**. AFK Desk derives an `scrypt` hash (N = 32768, r = 8, p = 1, 32-byte salt) and saves only the salt and hash in `auth.json`.
- **Shown once**: The full token is displayed only once when created. If lost, you must revoke it and generate a new one.
- **Capacity**: AFK Desk supports up to 100 active tokens concurrently.

### Creating a token in the UI

1. Open AFK Desk (or the web UI), open **Settings**, and locate **API tokens**.
2. Click **Create token**.
3. Choose a descriptive **Name** (e.g. `Home Assistant Sensor`), select the **Scope** (`read`, `control`, or `admin`), and set an optional expiration period (e.g. 30, 90, or 365 days).
4. Copy the generated `afk_...` token and store it securely in your secret manager.

### Creating a token via API

Administrators can create tokens programmatically by calling `POST /api/tokens`:

```sh
curl -X POST https://afk.example.com/api/tokens \
  -H "Authorization: Bearer afk_<admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Nightly Backup Script",
    "scope": "control",
    "expiresInDays": 90
  }'
```

### Revoking a token

To revoke a token immediately:
- In the UI, click **Revoke** next to the token name.
- Via API, send a DELETE request:
  ```sh
  curl -X DELETE https://afk.example.com/api/tokens/<token-id> \
    -H "Authorization: Bearer afk_<admin-token>"
  ```

Revocation takes effect immediately. Any open WebSocket connections authenticated with that token are forcibly terminated with close code `4401`.

---

## Example API calls

Authenticate requests by passing the token in the `Authorization` header:
```text
Authorization: Bearer afk_<id>_<secret>
```

### 1. Query status of all accounts (`status`)

Retrieves live connection status, player health, food level, and session uptime:

```sh
curl -X POST https://afk.example.com/api/commands/status \
  -H "Authorization: Bearer afk_0123456789abcdef_fedcba9876543210..." \
  -H "Content-Type: application/json" \
  -d '{}'
```

Example response:
```json
{
  "ok": true,
  "result": [
    {
      "id": "acc_emerald_miner",
      "name": "EmeraldMiner",
      "server": "mc.example.com",
      "state": "online",
      "status": "online",
      "health": 20,
      "food": 18,
      "uptimeSec": 14250
    }
  ]
}
```

### 2. Send in-game chat or command (`chat.send`)

Sends a chat message or server command on behalf of a specific account:

```sh
curl -X POST https://afk.example.com/api/commands/chat.send \
  -H "Authorization: Bearer afk_0123456789abcdef_fedcba9876543210..." \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "acc_emerald_miner",
    "message": "/warp farm"
  }'
```

Example response:
```json
{
  "ok": true,
  "result": {
    "status": "sent"
  }
}
```

### 3. Inspect account inventory (`inventory.view`)

Inspects the 45 slots of a bot's inventory (armor, off-hand, main storage, hotbar):

```sh
curl -X POST https://afk.example.com/api/commands/inventory.view \
  -H "Authorization: Bearer afk_0123456789abcdef_fedcba9876543210..." \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "acc_emerald_miner"
  }'
```

### 4. Handling actions requiring confirmation

Commands that can interrupt connections or discard items carry a danger level of `confirm`:
- `account.disconnect`
- `inventory.drop`
- `connectAll`
- `disconnectAll`

If invoked without explicit confirmation, the API returns `HTTP 409 Conflict` with error code `CONFIRM_REQUIRED`:

```sh
# Attempting to disconnect without confirmed: true
curl -X POST https://afk.example.com/api/commands/account.disconnect \
  -H "Authorization: Bearer afk_..." \
  -H "Content-Type: application/json" \
  -d '{"accountId": "acc_emerald_miner"}'

# Returns HTTP 409:
# {"ok":false,"error":{"code":"CONFIRM_REQUIRED","message":"Action requires confirmation."}}
```

To execute a confirmed action, pass `"confirmed": true` in the request body:

```sh
curl -X POST https://afk.example.com/api/commands/account.disconnect \
  -H "Authorization: Bearer afk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "acc_emerald_miner",
    "confirmed": true
  }'
```

---

## Rate limits & connection boundaries

- **HTTP API requests**: 120 requests per minute per token or session. Exceeding this limit returns `HTTP 429 Too Many Requests` with a `Retry-After` header indicating seconds to wait.
- **WebSocket connections**: Up to 5 concurrent WebSocket connections per API token (and 1 connection per browser session).
- **WebSocket message rate**: Clients sending more than 10 messages per 10-second window over a WebSocket are disconnected with code `1008 Policy Violation`.
- **Payload size limit**: JSON request bodies cannot exceed 256 KB. Payloads exceeding this limit return `HTTP 413 Payload Too Large`.

---

## What API tokens can NEVER do

To maintain the security perimeter of your server and accounts, certain actions are **strictly prohibited** via API tokens, even tokens with the `admin` scope:

1. **Change Remote Access settings**:
   - Bind addresses, listening ports, allowed host headers, and trusted proxy settings can **never** be modified remotely. They are desktop-only settings.
2. **Reset the administrator password**:
   - `POST /api/password` requires an active interactive **admin cookie session** created via the login dialog, and requires entering the current password.
3. **Exfiltrate account credentials or Microsoft OAuth tokens**:
   - The command layer never returns Microsoft passwords, OAuth refresh tokens, or raw authentication secrets. All API responses are sanitized; secrets appear only as `hasPassword: true` or `hasSecret: true` with masked hints (`••••1234`).
4. **Bypass anti-bot systems or server rules**:
   - The API layer interacts strictly through the bounded command contract. Out-of-bounds arguments or malformed JSON are rejected before touching the bot engine.

---

**Next:** [Discord Bot Control →](discord-bot.md)
