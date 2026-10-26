# Remote access, self-hosting and chat-bot control: design

Status: **approved scope from owner; lead design, 2026-10-27** · Branch base `feature/macro-engine`

## 1. Goals

Four new ways to reach AFK Desk:

1. **Headless server mode**: run AFK Desk without Electron on a server, NAS or VPS.
2. **Docker image**: ships the headless server for self-hosters and cloud users.
3. **Remote access from the desktop app**: an opt-in local web server, reachable over Tailscale or another private network, that serves the same UI in a browser.
4. **Discord bot control**: slash commands that act on your accounts. The command layer is shared, so a Telegram bot can reuse it later.

Plus full documentation and tutorials for each.

**Out of scope:**
- **Mobile.** The Android app gets no server; the owner confirmed it is not needed.
- **Public cloud hosting run by us.**
- **Anonymous or unauthenticated access in any mode.**
- **Anything that bypasses server rules or anti-bot checks.**

## 2. Threat model, in short

The thing being protected is control of Minecraft accounts and their Microsoft token caches. Possible attackers:

- someone else on the LAN or tailnet
- a malicious web page in the user's own browser (CSRF, DNS rebinding against the local server)
- a Discord user in the same server or channel as the bot
- a leaked API token
- server-controlled chat text trying to inject commands

Every remote entry point must therefore be:

- authenticated
- authorized per scope
- rate-limited
- audited
- **off by default**

## 3. Architecture

```
desktop/core/            (new, Electron-free; Node 22)
  app-core.cjs           AppCore: stores, BotManager/Bedrock, macro engine, notifier, events
  secrets.cjs            SecretBox interface: Electron safeStorage (desktop) | AES-256-GCM keyfile (server)
  commands.cjs           shared command layer (§6): the ONLY way remote surfaces act
desktop/server/          (new)
  http-server.cjs        node:http + WebSocket (ws dependency, already transitive? else add 'ws')
  auth.cjs               users, password hashing (crypto.scrypt), sessions, API tokens, CSRF, rate limit
  browser-bridge.js      window.afkDesk shim over fetch/WS, so desktop/src runs unchanged in a browser
  cli.cjs                `afk-desk-server` entry: config, first-run admin setup, graceful shutdown
desktop/control/discord/ (new) Discord bot over the command layer
desktop/electron/main.cjs  becomes thin: AppCore + Electron windows + optional embedded HTTP server
docker/                  Dockerfile, compose examples (plain, Tailscale sidecar, Caddy reverse proxy)
```

- **AppCore is extracted from `main.cjs`.** The behaviour is unchanged and existing tests must still pass. Electron-only concerns stay in `main.cjs`: windows, tray, the Electron auto-launch API, Electron Notification, and the safeStorage adapter.
- **One UI codebase.** `desktop/src` is served to browsers. The renderer only knows `window.afkDesk` (from preload). The browser bridge implements the same API over HTTP and WebSocket. Features that are impossible in a browser are hidden through a `capabilities` call; examples are the native file dialogs and auto-launch.
- **Microsoft sign-in in headless mode** uses the device-code flow, which already exists. The code is shown in the web UI.

## 4. Server security (normative)

1. **Off by default.**
   - Desktop: Settings → Remote access → Enable. This requires creating an admin password first.
   - Server mode: refuses to start until an admin user exists. Created by `afk-desk-server init`, or by a one-time setup token printed to stdout that is valid for 15 minutes and works on loopback only.
2. **Bind address.**
   - Default `127.0.0.1`.
   - Non-loopback binds need an explicit config value. The UI lists detected interfaces, highlights the Tailscale `100.x` / `fd7a:115c:a1e0::/48` address, and warns before `0.0.0.0`.
3. **Host header allowlist** (DNS-rebinding defence). Requests are accepted only if `Host` is one of:
   - the bind IP
   - `localhost`
   - names the user configured, such as a MagicDNS name or a reverse-proxy domain

   Anything else gets 421.
4. **Origin checks.** State-changing HTTP requests and WebSocket upgrades must carry an `Origin` matching an allowed host. There are no CORS headers, ever.
5. **Passwords.**
   - Hashing: `crypto.scrypt` (N = 2^15, r = 8, p = 1, 32-byte salt) with constant-time compare.
   - Minimum length 12. Rejected against a small bundled list of common passwords.
6. **Sessions.**
   - Random 256-bit ids, stored server-side.
   - Cookie: `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` when served over HTTPS or behind a trusted proxy flagged as HTTPS.
   - Idle timeout 12 h, absolute timeout 7 days. "Sign out everywhere" is available.
7. **CSRF.** A per-session synchronizer token in a header on every non-GET request. Combined with SameSite=Strict and the Origin check.
8. **API tokens** for scripts and Home Assistant.
   - Format: `afk_<id>_<secret>`. Only the scrypt hash is stored, and the token is shown once.
   - Scopes: `read`, `control`, `admin`. Optional expiry; revocable.
9. **Rate limits.**
   - Login: 5 per minute per IP and per username, with exponential lockout. Every failure is audited.
   - API: 120 requests per minute per session or token.
   - WebSocket: 1 connection per session, 5 per token.
10. **TLS.**
    - The server speaks plain HTTP and is meant to run behind Tailscale (WireGuard-encrypted) or a TLS reverse proxy (Caddy and nginx examples are provided).
    - If it binds to a non-private, non-tailnet address without a `trustProxy` HTTPS setup, it refuses to start unless `--i-understand-plain-http` is passed, and logs a loud warning every hour.
11. **Headers.**
    - `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: no-referrer`
    - The existing renderer CSP stays compatible.
12. **Secrets.** Server mode stores secrets (proxy passwords, webhook URLs, bot tokens) encrypted with AES-256-GCM.
    - The key comes from `AFKDESK_SECRET_KEY` (base64, 32 bytes) or `<data>/secret.key`, created with mode 0600.
    - Docker docs tell users to back up that key with the volume.
    - The API never returns secrets; they show as `hasSecret` plus the last 4 characters.
13. **Audit log.** Every remote action records actor (user, token or Discord id), scope, command, target account, result and IP. It is written to the persistent event store with the existing redaction, and is viewable by admins.
14. **Payloads.** JSON only, max 256 KB, schema-validated by the command layer. Static files are served from an allowlisted directory with no directory listing.

## 5. Docker

- **Image.** Multi-stage `node:22-bookworm-slim`.
  - Build-stage compilers are included for `raknet-native` (Bedrock). If it fails to build, the image runs with Bedrock disabled and reports that through capabilities.
  - Runs as non-root uid 10001. Read-only root filesystem compatible: `/data` is the only writable volume, plus a tmpfs `/tmp`.
- **Interface.**
  - Env: `AFKDESK_BIND`, `AFKDESK_PORT` (default 8787), `AFKDESK_ALLOWED_HOSTS`, `AFKDESK_SECRET_KEY`, `AFKDESK_TRUST_PROXY`, `AFKDESK_LOG_LEVEL`, `TZ`.
  - `HEALTHCHECK` hits `/healthz`, which is unauthenticated and returns only `{ok, version}`.
  - Handles SIGTERM gracefully (disconnect bots, flush stores and notifier).
- **Examples.**
  - `docker-compose.yml`, plain, bound to `127.0.0.1:8787`.
  - `docker-compose.tailscale.yml`, a Tailscale sidecar using `network_mode: service:tailscale`, so the UI is reachable only on the tailnet.
  - `docker-compose.caddy.yml`, with Caddy auto-HTTPS for users with a domain.
- **CI.** A workflow builds the image on PRs (amd64 and arm64) and runs the container smoke test: start the server, call `/healthz`, check that login is required. **Publishing to GHCR needs owner approval.** The workflow job exists but is gated to tags.

## 6. Command layer (shared by HTTP API, Discord, and later Telegram)

The contract is `desktop/core/command-contract.cjs`. Each command declares:

- **name**
- **scope:** `read`, `control` or `admin`
- **args schema:** validated, bounded, primitives only
- **danger:** `none` or `confirm`. `confirm` means chat bots require a button confirmation.
- **rate:** a per-actor limit

Commands:

| Command | Scope | Danger | Notes |
| --- | --- | --- | --- |
| `status` (all accounts) | read | none | name, server, state, health/food, uptime |
| `account.info` | read | none | |
| `account.connect` / `account.disconnect` | control | none / confirm | |
| `account.reconnect` | control | none | |
| `chat.send` | control | none | rate ≤ the account chat budget; text ≤ 256 characters |
| `chat.recent` | read | none | last N lines, formatting stripped |
| `inventory.view` | read | none | |
| `inventory.drop` | control | confirm | item locks always apply |
| `macro.list` / `macro.run` / `macro.stop` | read / control / control | none | |
| `antiAfk.set` | control | none | |
| `connectAll` / `disconnectAll` | control | confirm | |
| `notify.test` | admin | none | |
| `audit.recent` | admin | none | |

No command can:

- read or export credentials, tokens or secrets
- add or remove accounts
- change remote-access or bot settings

Those are local-UI only, or HTTP API with an `admin` session cookie (never a chat bot).

## 7. Discord bot control

- **Setup.** Opt-in, configured in the local UI. The bot token is stored as a secret.
  - The user creates an application in the Discord Developer Portal; the docs walk through it.
  - Gateway intents: **Guilds only**. Slash commands and button interactions do not need message-content intent.
  - Library: `discord.js` v14, a new dependency. It loads only when the bot is enabled.
- **Authorization.** The user configures:
  - allowed guild id(s)
  - optional allowed channel id(s)
  - a map of **Discord user ids → scope**, for example `{ "1234…": "control" }`

  Everyone else gets an ephemeral "not authorized" reply, and the attempt is audited. Role-based mapping is an optional addition: role id → scope.
- **Commands.**
  - `/afk status`
  - `/afk connect <account>`
  - `/afk disconnect <account>`
  - `/afk chat <account> <message>`
  - `/afk macro run <account> <macro>`
  - `/afk macro stop <account>`
  - `/afk inventory <account>`
  - `/afk recent-chat <account>`

  Account and macro arguments use autocomplete limited to what the actor may see. Replies are **ephemeral** by default; there is an optional public status channel.
- **Confirmations.** Commands marked `confirm` show Confirm/Cancel buttons valid for 60 s, only for the invoking user.
- **Notifications.** The same bot can post notifications to a configured channel, as an alternative to webhooks.
- **Safety.**
  - Server chat text shown in Discord is escaped, with markdown and mentions neutralized (`allowed_mentions: { parse: [] }`).
  - Command input is passed only through the command layer's validators.
  - Bot token redaction reuses `notify.redactSecrets`.
- **Runs in** desktop (Electron main) and server mode. Not on mobile.
- **Telegram control** (later, same command layer): inline-keyboard confirmations, chat id plus user id allowlist.

## 8. Bedrock (separate track)

An assessment comes first (Antigravity, read-only): what `bedrock-protocol` and the current `bedrock-bot-manager.cjs` support for movement, inventory, containers, chat and physics, and what server-authoritative movement on Bedrock means for anti-AFK.

The output is a capability plan with phases, estimated effort and risks. Implementation starts after the plan is reviewed. Macro and facade edition gates (`STEP_TYPES.editions`) widen as capabilities land.

## 9. Work breakdown

| # | Work | Owner | Depends on |
| --- | --- | --- | --- |
| R0 | This design + `core/command-contract.cjs` | Claude | — |
| R1 | Extract AppCore and SecretBox from `main.cjs` (no behaviour change) | Codex | Stage 2 merged |
| R2 | HTTP/WS server, auth, browser bridge, CLI, desktop "Remote access" settings | Codex | R1 |
| R3 | Discord bot over the command layer (built against a fake core first) | Antigravity | R0 |
| R4 | Command layer implementation `core/commands.cjs` | Codex | R0, R1 |
| R5 | Docker image, compose examples, CI build + smoke test | Antigravity | R2 |
| R6 | Docs: self-hosting, Docker, Tailscale, reverse proxy, Discord bot setup, security model, API reference | Antigravity | R2–R5 |
| R7 | Bedrock capability assessment and plan | Antigravity | — |
| R8 | Independent security review of R2–R5 | Codex (read-only) plus Claude | R2–R5 |

Exit criteria:

- Auth and CSRF/Host/Origin tests pass.
- The container smoke test passes.
- A Discord bot run against a fake gateway passes authorization tests.
- No regression in the desktop suite.
- Security review findings fixed.
