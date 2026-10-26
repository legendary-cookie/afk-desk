# Self-Hosting & Server Mode

AFK Desk includes an Electron-free headless server mode that runs on Linux servers, NAS devices, cloud VPS instances, or local Docker hosts. It provides the full desktop experience in any modern web browser, connecting directly to your Minecraft Java and Bedrock servers while running continuously in the background.

## What server mode is

In server mode, AFK Desk runs as a lightweight Node.js 22 process using `AppCore` (the shared core engine extracted from the desktop app):
- **Web UI & WebSocket bridge**: Serves the identical static frontend (`desktop/src`) and connects via `browser-bridge.js`, which transparently translates `window.afkDesk` API calls into authenticated HTTP REST endpoints (`/api/*`) and real-time WebSocket events (`/ws`).
- **Encrypted secret storage**: Protects proxy passwords, Discord/Telegram webhook URLs, and bot tokens using AES-256-GCM with a persistent 256-bit encryption key.
- **Headless Microsoft authentication**: Authenticates Microsoft accounts using the official OAuth device-code flow (`https://microsoft.com/link`), displaying the verification code directly in your browser.
- **Desktop-only feature gates**: Capabilities that require native operating system integration (native file picker dialogs, auto-launch at Windows boot, external window controls) are automatically hidden in browser mode.

## System requirements

- **Docker deployment**: Docker Engine 24+ with Docker Compose v2 (recommended).
- **Node.js deployment**: Node.js 22 (LTS) or newer on Linux, macOS, or Windows.
- **Memory & Storage**: 64 MB RAM minimum (128–256 MB recommended for multi-bot deployments), ~100 MB disk space plus `/data` volume storage.
- **Privileges**: Runs safely as an unprivileged non-root user (`UID 10001` in Docker) with a read-only root filesystem.

## Quick start with Docker

Run all commands from the `docker/` directory of the repository. AFK Desk provides three standalone Compose files; do not combine or layer them:
- `docker-compose.yml` (plain local access, described below)
- `docker-compose.tailscale.yml` (private encrypted mesh access; see [Remote Access via Tailscale](remote-access-tailscale.md))
- `docker-compose.caddy.yml` (automatic HTTPS reverse proxy; see [Reverse Proxy Setup](reverse-proxy.md))

### 1. Build and initialize

The server refuses to start until an administrator account exists. Run `init` first to create the admin password:

```sh
cd docker
docker compose build
docker compose run --rm afkdesk init
```

The `init` command prompts interactively for an administrator password (minimum 12 characters). To pass a password from a password manager or secure file via stdin:

```sh
# POSIX shell / Linux:
docker compose run --rm -T afkdesk init --password-stdin < /secure/admin-password.txt

# Windows PowerShell:
Get-Content C:\secure\admin-password.txt | docker compose run --rm -T afkdesk init --password-stdin
```

> [!TIP]
> Avoid passing passwords as literal command-line arguments to keep them out of shell history and process tables.

### 2. Start the container

Once initialized, start the service in detached mode:

```sh
docker compose up -d
docker compose ps
docker compose logs --tail 50 afkdesk
```

The plain `docker-compose.yml` variant:
- Publishes port `8787` exclusively to loopback: `127.0.0.1:8787:8787`.
- Sets `AFKDESK_BIND=0.0.0.0` inside the container network namespace.
- Allows only `localhost` and `127.0.0.1` as extra Host header values.
- Includes `--i-understand-plain-http` in the start command to acknowledge the container's internal wildcard bind. The startup and hourly security warnings in the container log are expected.
- Mounts persistent storage to the named volume `afkdesk-data` (`/data`).
- Enforces container hardening: `read_only: true`, drops all Linux capabilities (`cap_drop: [ALL]`), disables privilege escalation (`no-new-privileges:true`), and mounts a 64 MB tmpfs at `/tmp`.

> [!WARNING]
> Do not change the host port publication from `127.0.0.1:8787:8787` to `0.0.0.0:8787:8787` to expose plain HTTP to the Internet or local network. Use [Tailscale](remote-access-tailscale.md) or a [Reverse Proxy](reverse-proxy.md) for remote connections.

## Opening the UI and signing in

1. Open **http://127.0.0.1:8787** in your web browser.
2. The sign-in dialog prompts for your credentials. Enter username `admin` and the password chosen during `init`.
3. Once authenticated, the browser receives an `HttpOnly`, `SameSite=Strict` session cookie and a CSRF token.

### Microsoft device-code sign-in in the browser

To add a Minecraft account in server mode:
1. Click **+ Add account** in the sidebar.
2. Enter an account label and server address, then click **Save account**.
3. Click **Connect**. Because server mode has no local desktop window, AFK Desk generates a Microsoft OAuth device code.
4. The web UI displays a modal with the verification URL (`https://microsoft.com/link`) and your 8-character code (e.g. `ABCD-EFGH`).
5. Open `https://microsoft.com/link` in any browser, enter the code, and complete your Microsoft account login.
6. AFK Desk automatically detects successful authentication, saves the token cache in `/data/profiles/`, resolves your player IGN, UUID, and skin, and joins the server.

## Non-Docker installation

To run the headless server directly with Node.js on a host machine:

### 1. Install prerequisites and dependencies

```bash
# Ensure Node.js 22 LTS or newer is installed
node --version

# From the desktop directory, install production dependencies
cd desktop
npm ci --omit=dev
```

### 2. Initialize the admin account

```bash
node server/cli.cjs init --data ./data
```

Enter a password of at least 12 characters when prompted. You can also specify an alternate username using `--username <name>` or pipe via `--password-stdin`.

### 3. Start the server

```bash
node server/cli.cjs start --data ./data --bind 127.0.0.1 --port 8787
```

### CLI reference

Syntax:
```text
afk-desk-server init [options]
afk-desk-server start [options]
```

| Flag | Default | Description |
| --- | --- | --- |
| `--data <dir>` | `./data` (or `AFKDESK_DATA`) | Path to the persistent storage directory. |
| `--bind <ip>` | `127.0.0.1` (or `AFKDESK_BIND`) | IP address to bind. Non-loopback binds require explicit configuration. |
| `--port <port>` | `8787` (or `AFKDESK_PORT`) | HTTP listening port (1–65535). |
| `--allowed-hosts <hosts>` | `localhost,127.0.0.1` | Comma-separated list of allowed HTTP `Host` header values for DNS-rebinding protection. |
| `--trust-proxy` | `false` (or `AFKDESK_TRUST_PROXY=1`) | Trust forwarded proxy headers (`X-Forwarded-For`, `X-Forwarded-Proto`) from upstream reverse proxies. |
| `--i-understand-plain-http` | `false` | Acknowledge binding plain HTTP to a public/wildcard address without HTTPS. |
| `--password-stdin` | `false` | Read the new administrator password from stdin during `init`. |
| `--setup-token` | `false` (or `AFKDESK_SETUP_TOKEN=1`) | Generate a one-time 15-minute setup token printed to stdout on loopback when no admin user exists. |
| `--username <name>` | `admin` | Administrator username to create or update during `init`. |

## Environment variables reference

Environment variables are particularly useful in Docker and systemd deployments:

| Variable | Default | Description |
| --- | --- | --- |
| `AFKDESK_DATA` | `./data` (or `/data` in Docker) | Absolute or relative path to the persistent storage directory. |
| `AFKDESK_BIND` | `127.0.0.1` (`0.0.0.0` in Docker compose) | IP address to bind. Must be explicit if binding non-loopback. |
| `AFKDESK_PORT` | `8787` | TCP port number for HTTP and WebSocket traffic. |
| `AFKDESK_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames or domains accepted in the `Host` header. |
| `AFKDESK_SECRET_KEY` | *(empty)* | Optional base64-encoded 32-byte AES-256-GCM encryption key. If unset, `/data/secret.key` is used. |
| `AFKDESK_TRUST_PROXY` | *(empty)* | Set to `1`, `true`, or `yes` when running behind a trusted TLS reverse proxy. |
| `AFKDESK_SETUP_TOKEN` | *(empty)* | Set to `1`, `true`, or `yes` to issue a one-time loopback setup token if uninitialized. |
| `TZ` | `UTC` | Timezone for scheduled macro execution and event logs. |

## Upgrading

### Upgrading Docker deployments

1. Stop the running service:
   ```sh
   docker compose stop afkdesk
   ```
2. Create a backup of `/data` (see [Backup and restore](#backup-and-restore)).
3. Rebuild the image from updated source or pull the latest tagged release:
   ```sh
   # When building locally:
   docker compose build --pull
   docker compose up -d

   # When using published registry images:
   export AFKDESK_IMAGE='ghcr.io/legendary-cookie/afk-desk:v0.11.0'
   docker compose pull afkdesk
   docker compose up -d --no-build
   ```
4. Verify the container is healthy:
   ```sh
   docker compose ps
   docker compose logs --tail 20 afkdesk
   ```

### Rolling back

If an upgrade causes issues, revert to the previous container image and restore the matching data backup:
```sh
export AFKDESK_IMAGE='afkdesk:previous-tag'
docker compose up -d --no-build
```

## Backup and restore

The `/data` directory stores all state:
- `accounts.json`: Configured accounts, server targets, and anti-AFK settings.
- `settings.json`: UI and engine preferences.
- `auth.json`: Administrator credentials, scrypt password hashes, and active API tokens.
- `secret.key`: 32-byte AES-256-GCM encryption key (mode 0600, generated on first run).
- `profiles/`: Microsoft OAuth token caches (Prismarine Auth).
- `events/`: Bounded per-account event history (`*.jsonl`).

> [!CAUTION]
> **Secret Key Warning**: AFK Desk encrypts proxy passwords, webhook URLs, and Discord bot tokens with AES-256-GCM.
> - If `AFKDESK_SECRET_KEY` is **not set**, the key is saved to `/data/secret.key`. It is included in volume tar backups.
> - If `AFKDESK_SECRET_KEY` is **supplied via environment variable**, the key is **never written to disk**. You MUST back up that variable value separately in your password manager!
> - If the encryption key is lost or modified, all existing encrypted secrets become permanently unreadable. A volume backup without its corresponding environment key is incomplete!

### Consistent backup procedure

Always stop the service before creating an archive so files are not copied in a partial-write state:

```sh
# 1. Stop AFK Desk
docker compose stop afkdesk

# 2. Stream a tar archive from inside the container to a protected host path
docker compose run --rm -T --no-deps --entrypoint tar afkdesk -C /data -czf - . > /secure/afkdesk-data.tgz

# 3. Verify archive integrity and compute checksum
tar -tzf /secure/afkdesk-data.tgz > /dev/null
sha256sum /secure/afkdesk-data.tgz > /secure/afkdesk-data.tgz.sha256

# 4. Restart AFK Desk
docker compose start afkdesk
```

> [!NOTE]
> On Windows PowerShell 5.1, stdout redirection can corrupt binary data streams. Use WSL, Git Bash, or Linux shell environments when streaming binary archives.

### Restoring from backup

Restore into a clean, empty volume:

```sh
# 1. Stop and remove existing container
docker compose down

# 2. Extract backup into the data volume
docker compose run --rm -T --no-deps --entrypoint tar afkdesk -C /data -xzf - < /secure/afkdesk-data.tgz

# 3. Start the service
docker compose up -d
```

Verify that files inside `/data` retain ownership by UID 10001 (`chown -R 10001:10001` if mounted from a host directory).

---

**Next:** [Remote Access via Tailscale →](remote-access-tailscale.md)
