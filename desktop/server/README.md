# AFK Desk Server (`desktop/server`) — Developer Notes

This directory implements Track R2 of `docs/design/remote-control.md`:
1. **Headless server mode (`afk-desk-server`)**: runs `AppCore` under plain Node.js (`desktop/server/cli.cjs`) without Electron, using `createFileSecretBox` (`secret-key.bin`, `0600`) and serving the existing `desktop/src` web UI over HTTP + WebSocket.
2. **Desktop embedded "Remote access" server**: opt-in HTTP + WebSocket server hosted inside the Electron main process (`desktop/electron/main.cjs`), sharing the running `AppCore` instance and Electron `SecretBox`.

## Module Layout

| File | Responsibility |
| --- | --- |
| `auth.cjs` | `AuthManager`: `crypto.scrypt` (`N=2^15, r=8, p=1`, 32-byte salt) password & API token hashing, `crypto.timingSafeEqual` verification, 256-bit server-side sessions (12h idle / 7d absolute TTL), `X-AFK-CSRF` synchronizer tokens, one-time 15-min loopback setup tokens, login rate limiting + exponential lockout, API rate limiting (120/min), and WebSocket concurrency caps (1/session, 5/token). |
| `api-routes.cjs` | JSON API router (`/healthz`, `/api/login`, `/api/logout`, `/api/logout-all`, `/api/session`, `/api/setup`, `/api/capabilities`, `/api/tokens`, `/api/password`, `/api/commands`, `/api/commands/:name`, `/api/invoke`), per-channel scope allowlist (`CHANNEL_SPECS`), `501` handling for Electron-only channels, deep secret scrubbing (`sanitizeOutput`), and persistent audit logging via `core.eventStore`. |
| `http-server.cjs` | `createRemoteServer`: bind policy enforcement (`127.0.0.1:8787` default, Tailscale CGNAT/ULA detection, public bind refusal without `trustProxy` or `--i-understand-plain-http` + hourly warning), `Host` allowlist (`421`), `Origin` verification (`403`, zero CORS headers), CSP/nosniff/Referrer-Policy headers, 256 KB JSON-only body reader (`413`/`415`), path-traversal-hardened static file serving from `desktop/src` and `desktop/assets`, and scope-filtered `/ws` WebSocket push. |
| `browser-bridge.js` | Browser-side shim defining `window.afkDesk` with the same method names/shapes as `desktop/electron/preload.cjs` over `fetch('/api/invoke')` + `/ws`. No-ops on `window.afkDesk` when already defined (under Electron). Injects `X-AFK-CSRF`, handles `401` with a `textContent`-only `<dialog>` sign-in form, applies capability flags, and mounts the "Remote access" section in `#settings-dialog`. |
| `cli.cjs` | `afk-desk-server` CLI (`init` and `start` commands), TTY / `--password-stdin` admin initialization, Tailscale interface detection, and graceful `SIGTERM`/`SIGINT` shutdown (`remoteServer.stop()` + `core.shutdown()`). |

## Additive `AppCore` Platform Hooks

`desktop/core/app-core.cjs` exposes two optional, backwards-compatible hooks on `platform`:
- `platform.getRemoteAccess()`: when provided, `core.settings.get()` includes `remoteAccess: platform.getRemoteAccess()` in the returned settings object.
- `platform.saveRemoteAccess(remoteAccessInput)`: when provided and `input.remoteAccess` is passed to `core.settings.save(input)`, delegates remote access configuration updates after `settingsStore.save(input)` succeeds and attaches the updated `remoteAccess` status.

When `platform.getRemoteAccess` is omitted, `core.settings.get()` and `core.settings.save()` behave identically to R1.

## HTTP & WebSocket Endpoints

| Method & Path | Auth / Minimum Scope | Description |
| --- | --- | --- |
| `GET /healthz` | Unauthenticated | Returns `{ ok: true, version }` only. |
| `POST /api/setup` | Loopback + one-time setup token | Sets initial admin password when started with `--setup-token`. |
| `POST /api/login` | Unauthenticated (rate-limited) | Authenticates admin password, sets `HttpOnly; SameSite=Strict; Path=/` session cookie, returns `{ ok, csrfToken, scope, capabilities }`. |
| `POST /api/logout` | Session / Bearer + CSRF | Destroys current session (or all sessions with `{ everywhere: true }`) and closes bound WebSockets. |
| `POST /api/logout-all` | `admin` + CSRF | Destroys all active sessions ("Sign out everywhere") and closes bound WebSockets. |
| `GET /api/session` | Session / Bearer (`read`) | Returns `{ ok, authenticated, csrfToken, scope, user, capabilities }`. |
| `GET /api/capabilities` | Session / Bearer (`read`) | Returns server capability flags. |
| `POST /api/invoke` | Session / Bearer (`channel` scope) | Invokes allowlisted `preload.cjs` channel `{ channel, args }` against `AppCore`. Electron-only channels return `501`. |
| `GET /api/commands` | Session / Bearer (`read`) | Lists command contracts from `desktop/core/command-contract.cjs`. |
| `POST /api/commands/:name` | Session / Bearer (`command` scope) | Executes `core.commands.execute(name, args, { actor, confirmed })`. |
| `GET /api/tokens` | `admin` | Lists API token metadata (never returns hashes or raw secrets). |
| `POST /api/tokens` | `admin` + CSRF | Mints `afk_<id>_<secret>` token (secret returned once). |
| `DELETE /api/tokens/:id` | `admin` + CSRF | Revokes token and closes its active WebSockets. |
| `POST /api/password` | `admin` + CSRF | Changes admin password and invalidates other sessions. |
| `GET /ws` (WebSocket) | Session / Bearer (`read`) | Pushes `bot:event` and `macro-run` events filtered by actor scope (`read` never receives `login-code` or secrets). |
