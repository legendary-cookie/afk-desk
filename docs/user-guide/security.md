# Security Model for Remote Features

AFK Desk connects to Minecraft servers and manages Microsoft account authentication tokens. Because compromised remote access could allow an unauthorized party to disconnect bots, send unauthorized chat, or tamper with settings, all remote features are engineered around strict security boundaries and a defensive threat model.

---

## Core Security Principles

Every remote surface (web UI, REST API, WebSockets, Discord bot) enforces seven fundamental requirements:

1. **Off by default**: No remote port is opened and no bot listens until you explicitly configure and enable it.
2. **Authenticated**: Anonymous or unauthenticated access is impossible across all remote endpoints.
3. **Authorized per scope**: Remote actors are strictly constrained to `read`, `control`, or `admin` scopes.
4. **Rate-limited**: Brute-force guessing, credential stuffing, and request flooding are stopped by exponential lockouts and sliding-window limiters.
5. **DNS-rebinding & CSRF proof**: Strict Host and Origin verification blocks browser-based attack vectors.
6. **Encrypted at rest and in transit**: Secrets are encrypted with AES-256-GCM or Windows DPAPI, and traffic is routed over WireGuard (Tailscale) or HTTPS.
7. **Audited**: All administrative and operational commands are logged to a tamper-resistant local event store.

---

## Remote Security Architecture

```
┌────────────────────────────────────────────────────────┐
│ Remote Client (Browser, API script, Discord)           │
└───────────────────────────┬────────────────────────────┘
                            │
               [ Host & Origin Checks ]  ──► 421 / 403 on mismatch
                            │
               [ Rate & Lockout Checks ] ──► 429 on limit
                            │
               [ Authentication ]
               ├─ Session Cookie (scrypt + CSRF)
               ├─ Bearer Token   (scrypt hash)
               └─ Discord Actor  (Guild + User ID map)
                            │
               [ Scope Authorization ]
               ├─ read
               ├─ control
               └─ admin
                            │
               [ Shared Command Contract ]
               ├─ Bounds & schema validation
               ├─ Dangerous action confirmation
               └─ Secret output redaction
                            │
                            ▼
                     [ AppCore Engine ]
```

---

## 1. Authentication & Passwords

### Passwords and Hashing
- **Scrypt derivation**: Administrator passwords are hashed with `crypto.scrypt` using industry-standard parameters:
  - $N = 32768$ ($2^{15}$), $r = 8$, $p = 1$, memory cap $64\text{ MB}$.
  - Unique 32-byte cryptographically random salt per user.
- **Timing-safe comparison**: Password and token verification uses `crypto.timingSafeEqual` to eliminate timing side-channel attacks.
- **Password rules**: Minimum 12 characters; checked against a bundled blocklist of common compromised passwords and rejected if insufficiently complex.
- **Hash starvation defence**: Dedicated concurrency slots (2 for login hashing, 2 for bearer verification) prevent authentication queues from exhausting server CPU threads.

### Sessions
- **Session IDs**: Cryptographically random 256-bit identifiers stored server-side in memory.
- **Cookie flags**: Cookies are set with `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` whenever HTTPS or `trustProxy` is active.
- **Timeouts**: Idle timeout of 12 hours and an absolute hard timeout of 7 days.
- **Revocation**: Logging out revokes the session immediately. Administrators can trigger "Sign out everywhere" (`POST /api/logout-all`) to invalidate all active sessions instantly.

### API Tokens
- Bearer tokens follow the format `afk_<id>_<secret>`.
- Plaintext secrets are **never stored on disk**; only the scrypt hash is retained in `auth.json`.
- Tokens can be expired automatically or revoked on demand. Revoking a token terminates any associated active WebSocket connections immediately.

---

## 2. CSRF, Origin, and Host Rebinding Defences

### Host Header Allowlist (DNS Rebinding Defence)
Malicious websites can attempt DNS rebinding to trick your browser into sending requests to a local service (`127.0.0.1:8787`).
- AFK Desk inspects the `Host` header on **every HTTP request and WebSocket handshake**.
- Requests are rejected with `HTTP 421 Misdirected Request` unless the `Host` header exactly matches:
  - The bind IP address
  - `localhost` / `127.0.0.1` / `::1`
  - Explicitly configured hostnames in `AFKDESK_ALLOWED_HOSTS` (such as your MagicDNS name or reverse proxy domain).

### Origin Header Enforcement
- All state-changing requests (`POST`, `PUT`, `DELETE`, `PATCH`) and WebSocket upgrade handshakes require an `Origin` header matching an allowed host.
- Requests with missing or untrusted origins receive `HTTP 403 Forbidden`.
- **Zero CORS headers**: AFK Desk never sends `Access-Control-Allow-Origin: *` or permits cross-origin API invocation.

### CSRF Synchronizer Token
- Every browser session receives a random 256-bit synchronizer token (`csrfToken`).
- Non-GET requests authenticated by session cookie must include this token in the `X-AFK-CSRF` header.
- WebSocket handshakes require CSRF verification via `Sec-WebSocket-Protocol: afk-csrf.<token>` or query parameter.

---

## 3. Rate Limits & Lockout Protection

AFK Desk implements multi-tiered rate limiting:

| Target | Threshold | Enforcement |
| --- | --- | --- |
| **Login attempts** | 5 failures / minute per (IP, username) | Exponential lockout from 1 minute up to 1 hour. Global username attempt delay up to 30s. Loopback (`127.0.0.1`, `::1`) and recently authenticated IPs are exempt from lockout DoS. |
| **API calls** | 120 requests / minute per session or token | Returns `HTTP 429 Too Many Requests` with a `Retry-After` header. |
| **WebSockets** | 1 connection / session, 5 / token | Rejects excess sockets. Sockets exceeding 10 messages per 10s are terminated with code `1008`. |
| **Discord commands** | 10 commands / 10s per user | Returns an ephemeral flood warning. |
| **Payload size** | Max 256 KB JSON body | Rejects larger bodies with `HTTP 413 Payload Too Large`. |

---

## 4. Encryption of Secrets at Rest

- **Desktop app**: Proxy passwords, webhook URLs, and bot tokens are encrypted using Electron `safeStorage`, backed by the Windows Data Protection API (DPAPI).
- **Server mode**: Secrets are encrypted using **AES-256-GCM** with authenticated associated data.
  - The encryption key is loaded from `AFKDESK_SECRET_KEY` (base64 32 bytes) or `/data/secret.key` (mode 0600).
  - The API **never returns plaintext secrets**. Output values are masked (e.g. `hasSecret: true`, `secretHint: "••••1234"`).

---

## 5. Audit Logging

Every remote action is recorded in the persistent event store:
- **Logged information**: Timestamp (`at`), actor identity (`session`, `token`, or `discord` ID), permission scope, command executed, target account, source IP address, and result (`allowed`, `denied`, `forbidden`, `rate_limited`).
- **Secret redaction**: All audit text is sanitized through `redactSecrets()` and `redactAuditText()` before being written to disk.
- **Admin restricted**: The audit trail (`audit.recent` and `logs:list` with `audit`) is accessible only to users with the `admin` scope.

---

## 6. What is NEVER Exposed Remotely

To guarantee that a compromised remote token or chat bot cannot gain full host control, the following capabilities are permanently restricted:

1. **Microsoft Account Credentials & OAuth Tokens**:
   - Microsoft passwords never enter AFK Desk.
   - Cached OAuth access and refresh tokens in `profiles/` are inaccessible via API or chat commands; they cannot be downloaded or exported.
2. **Remote Access & Admin Configuration**:
   - Bind addresses, listening ports, allowed hosts, and proxy trust settings **cannot be modified remotely**. They are strictly local/desktop settings.
   - Changing the administrator password requires an interactive admin session with current password verification.
3. **Desktop Operating System Controls**:
   - Native file dialogs, system external URL launching, auto-launch at Windows boot, and native window minimizing/closing are completely disabled in browser mode.
4. **Anti-Bot & Server Rule Bypasses**:
   - Remote interfaces communicate only through the shared command contract schema. No remote interface can run arbitrary code, shell commands, or bypass server rules.

---

**Next:** [Troubleshooting →](troubleshooting.md)
