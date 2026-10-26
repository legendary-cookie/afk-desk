# Remote Access via Tailscale

Tailscale creates a secure, private WireGuard mesh network (a *tailnet*) between your computers, servers, and mobile devices. Using Tailscale is the recommended way to access AFK Desk remotely without exposing open ports to the public Internet.

## Why Tailscale is recommended over port-forwarding

Traditional remote access often relies on opening router ports (port forwarding) and pointing dynamic DNS to your home network. This creates substantial security risks:
- **No public exposure**: Tailscale requires zero open inbound ports on your firewall or router. Your AFK Desk port (8787) is completely invisible to public Internet port scanners.
- **End-to-end WireGuard encryption**: All communication between your client device and AFK Desk is encrypted with WireGuard at the network level. Even though AFK Desk communicates via plain HTTP inside the tailnet, the traffic across the network is fully encrypted.
- **Cryptographic identity & ACLs**: Access requires an authenticated device on your Tailscale account. You can use Tailscale Access Control Lists (ACLs) to restrict access to specific users or devices.
- **Convenient MagicDNS**: Every machine on your tailnet gets an automatic hostname (e.g. `afkdesk.your-tailnet.ts.net`), eliminating dynamic IP hassles.

---

## Option 1: Enabling remote access in the Desktop app

If you run the AFK Desk desktop app on your primary PC and want to check your bots from your phone or laptop while away from home:

### 1. Set up Tailscale on your host

Ensure Tailscale is installed and running on the PC hosting AFK Desk. Note your PC's Tailscale IPv4 address (in the `100.64.0.0/10` range, such as `100.85.120.45`).

### 2. Configure Remote access in Settings

1. Open AFK Desk and click the gear icon (**Settings**) in the top toolbar (or press `Ctrl+,`).
2. Scroll to the **Remote access** section. Remote access is **disabled by default**.
3. Click **Enable remote access**.
4. Set an **Administrator password** (minimum 12 characters). This password protects the web interface.
5. In **Bind address**, the desktop app automatically enumerates detected network adapters:
   - `Loopback` (`127.0.0.1` / `::1`)
   - `Private LAN` (`192.168.x.x`, `10.x.x.x`)
   - `Public`
   - `Tailscale` (`100.x.x.x` IPv4 or `fd7a:115c:a1e0::/48` IPv6)
6. Select your **Tailscale address** (`100.x.x.x`).
7. In **Allowed hosts**, add your machine's Tailscale MagicDNS name (e.g. `my-pc.your-tailnet.ts.net`) so browser requests are accepted.
8. Save settings. AFK Desk starts the embedded HTTP and WebSocket server.

> [!NOTE]
> In browser mode, the Remote Access settings section displays:
> `Remote access settings can only be configured in the desktop app.`
> This prevents remote sessions from accidentally disabling their own access or re-binding the local interface.

### 3. Connect from another Tailscale device

On any other device connected to your tailnet (such as your phone or laptop), open your web browser and navigate to:

```text
http://100.x.x.x:8787
# or
http://my-pc.your-tailnet.ts.net:8787
```

Sign in with username `admin` and your administrator password.

---

## Option 2: Docker with Tailscale sidecar

For headless servers, NAS units, or VPS instances, AFK Desk provides a dedicated Compose configuration: `docker/docker-compose.tailscale.yml`.

In this architecture:
- A `tailscale/tailscale:stable` sidecar container connects to your tailnet using a reusable, scoped auth key.
- AFK Desk attaches directly to Tailscale's network namespace (`network_mode: service:tailscale`).
- **No host ports are published.** The port `8787` listener exists only inside the Tailscale container network namespace.

```
┌────────────────────────────────────────────────────────────┐
│ Docker Host                                                │
│                                                            │
│   ┌────────────────────┐      ┌─────────────────────────┐  │
│   │ tailscale sidecar  │◄─────┤ afkdesk container       │  │
│   │ (WireGuard tun)    │      │ network_mode:           │  │
│   │ /dev/net/tun       │      │   service:tailscale     │  │
│   └─────────▲──────────┘      │ port 8787 (internal)    │  │
│             │                 └─────────────────────────┘  │
└─────────────┼──────────────────────────────────────────────┘
              │ WireGuard Encrypted Tailnet
              ▼
   Your Phone / Laptop Browser
   http://afkdesk.your-tailnet.ts.net:8787
```

### 1. Generate a Tailscale auth key

1. Go to the [Tailscale Admin Console](https://login.tailscale.com/admin/settings/keys).
2. Click **Generate auth key**.
3. Recommended settings:
   - **Reusable**: Optional (convenient if recreating containers).
   - **Ephemeral**: Off (so node identity is retained).
   - **Tags**: Apply a tag such as `tag:server` if you use ACL tags.

### 2. Configure environment variables

Set your credentials in your shell or in a secure `.env` file in the `docker/` directory:

```sh
# Scoped auth key from Tailscale Admin Console
export TS_AUTHKEY='tskey-auth-kXXXXX-XXXXXXXXXXXXXXXX'

# Your desired MagicDNS hostname on the tailnet (e.g. afkdesk.your-tailnet.ts.net)
export AFKDESK_TAILNET_HOST='afkdesk.your-tailnet.ts.net'

# Optional: Machine hostname for Tailscale (defaults to 'afkdesk')
export TS_HOSTNAME='afkdesk'
```

### 3. Inspect the compose configuration

Here is `docker/docker-compose.tailscale.yml`:

```yaml
name: afkdesk
services:
  tailscale:
    image: tailscale/tailscale:stable
    hostname: afkdesk
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY:?Set a scoped Tailscale auth key}
      TS_HOSTNAME: ${TS_HOSTNAME:-afkdesk}
      TS_STATE_DIR: /var/lib/tailscale
      TS_AUTH_ONCE: "true"
      TS_USERSPACE: "false"
    devices:
      - /dev/net/tun:/dev/net/tun
    volumes:
      - tailscale-state:/var/lib/tailscale
    restart: unless-stopped
    cap_drop: [ALL]
    cap_add: [NET_ADMIN]
    security_opt: [no-new-privileges:true]
  afkdesk:
    image: ${AFKDESK_IMAGE:-afkdesk:local}
    build:
      context: ..
      dockerfile: docker/Dockerfile
    network_mode: service:tailscale
    depends_on: [tailscale]
    command: ["start", "--i-understand-plain-http"]
    environment:
      AFKDESK_BIND: 0.0.0.0
      AFKDESK_PORT: "8787"
      AFKDESK_ALLOWED_HOSTS: ${AFKDESK_TAILNET_HOST:?Set machine.tailnet.ts.net}
      AFKDESK_SECRET_KEY: ${AFKDESK_SECRET_KEY:-}
      TZ: ${TZ:-UTC}
    volumes:
      - afkdesk-data:/data
    restart: unless-stopped
    stop_grace_period: 30s
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
volumes:
  afkdesk-data:
  tailscale-state:
```

Key security aspects:
- `TS_USERSPACE=false` enables Linux kernel WireGuard routing via `/dev/net/tun`.
- The `tailscale` container drops all capabilities except `NET_ADMIN`. It does not require full Docker privileged mode.
- The `tailscale-state` volume stores Tailscale machine keys so your device IP and identity persist across container restarts.
- AFK Desk listens explicitly on `0.0.0.0` within the shared network namespace. Because traffic is encapsulated in WireGuard, `--i-understand-plain-http` is passed. Trust proxy remains disabled.

### 4. Build, initialize, and start

```sh
cd docker

# Build container images
docker compose -f docker-compose.tailscale.yml build

# Initialize administrator password
docker compose -f docker-compose.tailscale.yml run --rm afkdesk init

# Start both containers in the background
docker compose -f docker-compose.tailscale.yml up -d
```

### 5. Accessing the web interface

Once the sidecar logs show that Tailscale is connected:
1. Verify the device appears in your [Tailscale Machines list](https://login.tailscale.com/admin/machines).
2. From any device on your tailnet, open:
   ```text
   http://afkdesk.your-tailnet.ts.net:8787
   ```
3. Sign in as `admin`.

## Troubleshooting Tailscale connections

- **HTTP 421 Misdirected Request**:
  - The `Host:` header sent by your browser must match an entry in `AFKDESK_ALLOWED_HOSTS`.
  - Ensure `AFKDESK_TAILNET_HOST` is set to the exact MagicDNS name without protocol or port (e.g. `afkdesk.your-tailnet.ts.net`).
  - If Tailscale appends a collision number (e.g. `afkdesk-1`), update `AFKDESK_TAILNET_HOST` to match the assigned name.
- **Container unhealthy or connection refused**:
  - Check sidecar logs: `docker compose -f docker-compose.tailscale.yml logs tailscale`.
  - Ensure `/dev/net/tun` exists on the Linux host (`ls -l /dev/net/tun`).
  - If recreating the Tailscale container, always recreate the AFK Desk container as well so it attaches to the fresh network namespace (`docker compose -f docker-compose.tailscale.yml up -d --force-recreate`).

---

**Next:** [Reverse Proxy Setup →](reverse-proxy.md)
