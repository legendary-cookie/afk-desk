# Reverse Proxy Setup (HTTPS)

When exposing AFK Desk over a custom domain, you should run it behind a TLS reverse proxy such as **Caddy** or **Nginx**. A reverse proxy terminates TLS/HTTPS, issues automatic SSL certificates, and forwards encrypted web and WebSocket traffic to AFK Desk's internal listener.

---

## Security Warnings

> [!CAUTION]
> **Never expose plain HTTP to the Internet.**
> - Passwords, session cookies, and API tokens transmitted over unencrypted HTTP can be intercepted or stolen by anyone on the network path.
> - **Server safety enforcement**: If AFK Desk binds to a public or wildcard address (`0.0.0.0` or `::`) without `AFKDESK_TRUST_PROXY=1` flagged as HTTPS, the server **refuses to start** unless the `--i-understand-plain-http` flag is passed.
> - If `--i-understand-plain-http` is passed on a public/wildcard bind, the server logs a loud warning at startup and repeats it every hour:
>   `[SECURITY WARNING] AFK Desk server is bound to "0.0.0.0" over plain HTTP without a trusted HTTPS proxy!`

> [!IMPORTANT]
> **Keep backend sockets private.**
> When `AFKDESK_TRUST_PROXY=1` is enabled, AFK Desk trusts forwarded headers (`X-Forwarded-For` and `X-Forwarded-Proto`) sent by the proxy. The backend port (`8787`) must **never be published directly to the public Internet** or accessible to untrusted network peers. Keep it restricted to loopback (`127.0.0.1`) or an isolated internal Docker bridge network.

---

## Option 1: Caddy with Docker Compose (Recommended)

Caddy automatically obtains and renews free TLS certificates from Let's Encrypt or ZeroSSL with zero manual certificate configuration.

The repository includes a production-ready standalone compose setup in `docker/docker-compose.caddy.yml` and `docker/Caddyfile.example`.

### Architecture

```
Internet (HTTPS :443)
       │
       ▼
┌────────────────────────────────────────────────────────┐
│ Docker Host                                            │
│                                                        │
│  ┌──────────────────┐                                  │
│  │ caddy container  │ ports: 80:80, 443:443            │
│  │ (Auto HTTPS)     │                                  │
│  └────────▲─────────┘                                  │
│           │ internal Docker bridge                     │
│           ▼ (reverse_proxy afkdesk:8787)               │
│  ┌──────────────────┐                                  │
│  │ afkdesk          │ no host ports published          │
│  │ container        │ AFKDESK_TRUST_PROXY=1            │
│  └──────────────────┘                                  │
└────────────────────────────────────────────────────────┘
```

### 1. Prerequisites

- A registered domain name (e.g. `afk.example.com`).
- DNS `A` or `AAAA` records pointing your domain to your server's public IP address.
- Inbound TCP ports `80` and `443` allowed through your firewall or cloud security group.

### 2. Configure environment

From the `docker/` directory, set your domain name:

```sh
export AFKDESK_DOMAIN='afk.example.com'
```

### 3. Review the compose configuration

Here is `docker/docker-compose.caddy.yml`:

```yaml
name: afkdesk
services:
  afkdesk:
    image: ${AFKDESK_IMAGE:-afkdesk:local}
    build:
      context: ..
      dockerfile: docker/Dockerfile
    environment:
      AFKDESK_BIND: 0.0.0.0
      AFKDESK_PORT: "8787"
      AFKDESK_ALLOWED_HOSTS: ${AFKDESK_DOMAIN:?Set your HTTPS domain}
      AFKDESK_TRUST_PROXY: "1"
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
  caddy:
    image: caddy:2
    depends_on:
      afkdesk:
        condition: service_healthy
    environment:
      AFKDESK_DOMAIN: ${AFKDESK_DOMAIN:?Set your HTTPS domain}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile.example:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
volumes:
  afkdesk-data:
  caddy-data:
  caddy-config:
```

And `docker/Caddyfile.example`:

```caddy
{$AFKDESK_DOMAIN} {
    reverse_proxy afkdesk:8787
}
```

Key features:
- **No published backend port**: The `afkdesk` service has no `ports:` mapping; only Caddy exposes ports `80` and `443`.
- **`AFKDESK_TRUST_PROXY=1`**: Informs AFK Desk that incoming connections behind Caddy are secure HTTPS, enabling `Secure` flags on session cookies (`SameSite=Strict; HttpOnly; Secure`) and parsing proxy-appended `X-Forwarded-For` IPs.
- **`AFKDESK_ALLOWED_HOSTS`**: Sets your domain as an allowed Host header to prevent DNS-rebinding attacks.
- **WebSocket support**: Caddy's `reverse_proxy` directive transparently supports WebSocket upgrading (`/ws`).

### 4. Build, initialize, and start

```sh
cd docker

# Build the container image
docker compose -f docker-compose.caddy.yml build

# Initialize the admin account
docker compose -f docker-compose.caddy.yml run --rm afkdesk init

# Launch Caddy and AFK Desk
docker compose -f docker-compose.caddy.yml up -d
```

Open `https://afk.example.com` in your web browser. Caddy issues the SSL certificate and forwards to the AFK Desk web UI.

---

## Option 2: Nginx Configuration

If you already use an existing Nginx server on your host machine or reverse proxy cluster, use this complete server block configuration.

### Nginx server block (`/etc/nginx/sites-available/afkdesk.conf`)

```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name afk.example.com;

    return 301 https://$host$request_uri;
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name afk.example.com;

    # SSL certificates (e.g. from certbot)
    ssl_certificate /etc/letsencrypt/live/afk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/afk.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Limit payload size to match AFK Desk's 256 KB JSON body limit
    client_max_body_size 256k;

    location / {
        proxy_pass http://127.0.0.1:8787;

        # WebSocket support (required for /ws real-time telemetry)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Forwarded identity & security headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for persistent WebSocket connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Starting AFK Desk behind Nginx

When running AFK Desk on the host with Nginx, start the server bound to `127.0.0.1` with `--trust-proxy` and `--allowed-hosts`:

```bash
node desktop/server/cli.cjs start \
  --data ./data \
  --bind 127.0.0.1 \
  --port 8787 \
  --trust-proxy \
  --allowed-hosts afk.example.com
```

Or set the corresponding environment variables:
```bash
export AFKDESK_BIND='127.0.0.1'
export AFKDESK_PORT='8787'
export AFKDESK_TRUST_PROXY='1'
export AFKDESK_ALLOWED_HOSTS='afk.example.com'
```

---

## Verifying your reverse proxy setup

1. **Verify HTTPS and cookie security**:
   - In your browser's Developer Tools (F12) → **Application** → **Cookies**, verify that the `afk_session` cookie has both `HttpOnly` and `Secure` attributes set.
2. **Verify WebSocket connection**:
   - In Developer Tools → **Network** → filter by **WS**, verify that `/ws` shows status `101 Switching Protocols`.
3. **Verify Host header enforcement**:
   - Calling the server with an unlisted Host header should return `HTTP 421 Misdirected Request`:
     ```sh
     curl -k -H "Host: malicious.com" https://afk.example.com/healthz
     # Returns: {"ok":false,"error":{"code":"INVALID_HOST","message":"Host header is not allowlisted."}}
     ```
4. **Verify IP rate-limiting**:
   - AFK Desk correctly uses the proxy-appended `X-Forwarded-For` IP address, preventing spoofed headers from bypassing rate limits.

---

**Next:** [API Tokens →](api-tokens.md)
