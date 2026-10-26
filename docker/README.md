# AFK Desk in Docker

Requires Docker Engine/Desktop with Linux containers and Docker Compose v2.
Run these commands from the repository's `docker` directory. Use one Compose
file at a time; the variants are standalone, not overlays. All use project name
`afkdesk` and share its `afkdesk-data` volume. Run only one variant at a time.

## Quick start and first admin

```sh
docker compose build
docker compose run --rm afkdesk init
docker compose up -d
docker compose ps
docker compose logs --tail 50 afkdesk
```

`init` prompts for a password (minimum 12 characters). Open
<http://127.0.0.1:8787> and sign in as `admin`. The server refuses to start until
an admin exists. To provide a password from a password manager or protected
file via stdin, use:

```sh
docker compose run --rm -T afkdesk init --password-stdin < /secure/admin-password.txt
```

PowerShell (a one-line password file): `Get-Content C:\secure\admin-password.txt | docker compose run --rm -T afkdesk init --password-stdin`.
Avoid literal passwords in commands/shell history. Running `init` again resets
the admin password; stop the running server first. Do not use `--setup-token`
for container onboarding: it is loopback-only and unsuitable through Docker's
published port or a proxy. There is no entrypoint wrapper; `init`, `start`, and
CLI flags pass directly to `node server/cli.cjs`.

## Access variants

**Plain/local:** `docker-compose.yml` publishes only `127.0.0.1:8787:8787`.
It explicitly sets `AFKDESK_BIND=0.0.0.0` inside the container and allows only
`localhost,127.0.0.1` as extra Host names. The CLI treats wildcard binds as public,
so the command includes the design's `--i-understand-plain-http` flag. The
startup/hourly warning is expected. Do not change the published address to
`0.0.0.0` for Internet access.

**Tailscale:** set environment variables (or a protected, untracked `docker/.env`):

```sh
export TS_AUTHKEY='your-scoped-auth-key'
export AFKDESK_TAILNET_HOST='afkdesk.your-tailnet.ts.net'
docker compose -f docker-compose.tailscale.yml build
docker compose -f docker-compose.tailscale.yml run --rm afkdesk init
docker compose -f docker-compose.tailscale.yml up -d
```

Open `http://afkdesk.your-tailnet.ts.net:8787` from an allowed tailnet device.
Use the actual machine name from Tailscale, including any collision suffix;
set `TS_HOSTNAME` if desired. The sidecar retains identity in `tailscale-state`.
AFK Desk shares its network namespace with `network_mode: service:tailscale`.
Kernel networking (`TS_USERSPACE=false`) gives that namespace a tailnet
interface; the sidecar alone gets `/dev/net/tun` and `NET_ADMIN`, without
privileged mode. The Docker host must provide the TUN device. There is no host
port, Serve, or Funnel. AFK Desk listens explicitly on `0.0.0.0` and acknowledges HTTP;
traffic over the tailnet is WireGuard-encrypted. Trust proxy stays off. Restrict
tailnet ACLs/grants to intended users and port 8787. If recreating the sidecar,
recreate AFK Desk too so it joins the new namespace.

**Caddy/HTTPS:** point a domain's DNS at this machine; allow inbound TCP 80/443
for Caddy's automatic certificates. Set `AFKDESK_DOMAIN=afk.example.com`:

```sh
docker compose -f docker-compose.caddy.yml build
docker compose -f docker-compose.caddy.yml run --rm afkdesk init
docker compose -f docker-compose.caddy.yml up -d
```

Open `https://afk.example.com`. `Caddyfile.example` proxies to `afkdesk:8787`,
preserving Host and WebSockets; Caddy supplies forwarded HTTPS information.
`AFKDESK_TRUST_PROXY=1` satisfies the wildcard bind policy and enables Secure
cookies behind Caddy. AFK Desk has no published host port. Its allowed Host is
the configured domain. Keep the Docker network private: trusted proxy mode
trusts forwarded headers from any peer that can reach the backend.

All variants' backend sockets are also reachable by the Docker host and peers
deliberately attached to their bridge network. No host publication in the
Tailscale/Caddy variants means no normal LAN/Internet listener on port 8787;
Docker host/network access remains an administrative trust boundary.

## Configuration and storage

The image defaults to the CLI's loopback bind; each Compose file explicitly
opts into `0.0.0.0`. For manual `docker run`, set the bind and allowed hosts and
pass the HTTP acknowledgement, or configure a trusted HTTPS proxy. The image
uses UID/GID `10001:10001`, `/app`, data at `/data`, and port 8787. Root filesystem
is read-only compatible with a writable `/data` volume and `/tmp` tmpfs. Fresh
named volumes inherit `/data` ownership. Existing/bind-mounted data must already
be writable by UID 10001; the container never starts as root to repair it.

`AFKDESK_DATA`, `AFKDESK_BIND`, `AFKDESK_PORT`, `AFKDESK_ALLOWED_HOSTS` (comma-separated),
`AFKDESK_SECRET_KEY`, and `AFKDESK_TRUST_PROXY` are read by the current CLI.
If changing the internal port, change the Compose publication/proxy too; the
image healthcheck follows `AFKDESK_PORT`. `TZ` defaults to UTC. The design names
`AFKDESK_LOG_LEVEL`, but this R2 CLI does not consume it; logs go to stdout/stderr.
Never bake passwords, account data, auth keys, or encryption keys into an image.

Without `AFKDESK_SECRET_KEY`, first initialization creates `/data/secret.key`
(32 bytes, mode 0600). If using the environment instead, set the same
base64-encoded 32-byte key for **both init and start**, and keep a separate secure
backup: it is not written to the volume. Losing/changing the key makes encrypted
secrets unreadable. A volume backup without its environment-supplied key is
incomplete. The volume also contains sensitive account/Microsoft token caches.

## Upgrade, backup, restore, rollback

Stop AFK Desk before making a consistent backup. These POSIX-shell examples use
the plain variant; add the same `-f` option to every command for another variant.

```sh
docker compose stop afkdesk
```

To back up, stream the archive to a protected directory on the host (do not
place it in this repository). This uses the image's tar and existing data mount:

```sh
docker compose run --rm -T --no-deps --entrypoint tar afkdesk -C /data -czf - . > /secure/afkdesk-data.tgz
tar -tzf /secure/afkdesk-data.tgz
sha256sum /secure/afkdesk-data.tgz > /secure/afkdesk-data.tgz.sha256
docker compose start afkdesk
```

Use a POSIX shell for binary archive redirection (Windows PowerShell 5.1 can
corrupt binary streams). Verify the archive and restore to a disposable volume
before relying on it. Check for `secret.key` if using a file key; securely back
up the environment key otherwise. Protect the archive like a password vault.

Restore into an **empty** data volume with AFK Desk stopped:

```sh
docker compose run --rm -T --no-deps --entrypoint tar afkdesk -C /data -xzf - < /secure/afkdesk-data.tgz
docker compose up -d
```

Use the original key and image version. Keep UID 10001 ownership. Do not extract
over a live or nonempty volume. Never use `docker compose down -v` on data you
intend to keep. Back up Tailscale state and Caddy volumes separately if retaining
their node identity/certificate state matters.

For local upgrades: back up, record the previous image ID/tag, then
`docker compose build --pull` and `docker compose up -d`. For an owner-published
release, set `AFKDESK_IMAGE=ghcr.io/legendary-cookie/afk-desk:vX.Y.Z`, then
`docker compose pull afkdesk` and `docker compose up -d --no-build`. Publication
is not assumed to exist yet. For rollback, set `AFKDESK_IMAGE` to the saved image
tag and run `docker compose up -d --no-build`; restore the matching data backup
into a separate empty volume if the newer version changed the data format.

## Build decisions and verification

Build from the **repository root**: `docker build -f docker/Dockerfile -t afkdesk:local .`.
The root `.dockerignore` allowlists only the needed desktop source paths;
mobile, Git history, local dependencies, runtime data, and environment files are
excluded. Both stages use `node:22-bookworm-slim`. Compilers, Python, CMake, Git,
and build-only patch-package stay in the build stage. A public Forge Git
dependency is locked to an SSH URL; build-stage Git
rewrites GitHub SSH URLs to HTTPS so the build needs no SSH keys/client.
Production dependencies are installed with `npm ci --omit=dev --ignore-scripts`, then patch-package
8.0.1 applies **all four patches** explicitly with `--error-on-fail`. Its isolated
tool install pins the tool version but resolves its own transitive dependencies
at build time. Installed native/lifecycle dependencies are explicitly rebuilt;
errors other than native RakNet are fatal. Electron is omitted and binary
download is disabled throughout. Runtime contains only the production tree,
package.json, core, server, src, assets, and electron source modules. Core
requires shared modules under `electron/`; `main.cjs`/`preload.cjs` are never
loaded by the server. A build-time CLI import checks that dependency boundary.

**Bedrock requirement gap in this base:** `bedrock-protocol` lists raknet-native
as a required dependency, so a normal lifecycle install can fail the whole image.
The separate rebuild catches only RakNet failure and removes that module. The
patched `bedrock-protocol/src/createClient.js` no longer loads native RakNet at
module import; `bedrock-bot-manager.cjs` catches a missing native module and
selects `jsp-raknet`. Thus this base preserves Bedrock via its JS fallback;
it does **not** disable Bedrock or report native unavailability in capabilities.
That literal design requirement needs a core/Bedrock-owner change outside R5's
new-file ownership. No Docker-only capability claim is fabricated here.

From the repository root:

```sh
bash docker/smoke-test.sh
# Exercise the native-unavailable path deliberately:
docker build -f docker/Dockerfile --build-arg AFKDESK_SKIP_RAKNET_NATIVE=1 -t afkdesk:smoke .
bash docker/smoke-test.sh --skip-build
```

PowerShell: `./docker/smoke-test.ps1` (or `-SkipBuild`). Both scripts use a unique
temporary volume, initialize via stdin, start with a read-only rootfs and dropped
capabilities, wait for Docker healthy, check the published health endpoint,
assert health JSON, unauthenticated invoke 401, login 200 and a valid session,
then require SIGTERM handling and exit 0. They remove only their own resources
and fail nonzero on errors. Bash additionally requires curl.

CI builds linux/amd64 and linux/arm64 using Buildx/QEMU on PRs and main pushes;
amd64 runs both smoke scripts plus the forced fallback build/smoke. Only an
owner-approved `v*` tag enables the GHCR publication job, after build checks,
with `packages: write` limited to that job. Protect tag creation accordingly.
Actions are pinned to full release commit SHAs. No image has been built in the
R5 sandbox: the lead must verify both architectures, native build/fallback,
volume ownership, read-only operation, both smoke scripts, real Tailscale
connectivity/ACL isolation, and Caddy certificate issuance/forwarded cookies.

## Troubleshooting

- Restart loop / no admin: stop the service, run `init`, then start it again.
- Permission denied under `/data`: check the volume/bind mount's UID 10001
  ownership on the host; do not run the app as root.
- HTTP 421: set the exact browser hostname in `AFKDESK_ALLOWED_HOSTS`; avoid
  wildcards. HTTP 403 on script POSTs: send an allowed `Origin`, plus the
  session CSRF header for authenticated mutations.
- Wildcard bind refusal: use the supplied variant command, or a trusted HTTPS
  proxy. The image alone does not silently bypass the CLI policy.
- Unhealthy: inspect `docker compose logs afkdesk` and
  `docker inspect --format '{{json .State.Health}}' <container>`; check port,
  admin initialization, key and volume permissions.
- Tailscale unreachable: check `docker compose -f docker-compose.tailscale.yml logs tailscale`,
  the auth key, actual MagicDNS name and tailnet ACLs. No host port is expected.
- Caddy certificate failure: check DNS, inbound ports 80/443, and Caddy logs.
- Native RakNet warning: Java startup remains available; this base uses JS
  RakNet for Bedrock. Smoke tests do not prove Minecraft server compatibility.

References: [Tailscale container parameters](https://tailscale.com/docs/features/containers/docker/docker-params),
[Tailscale sidecar example](https://tailscale.com/docs/features/containers/docker/how-to/connect-docker-container),
[npm rebuild](https://docs.npmjs.com/cli/commands/npm-rebuild/),
and [the project design](../docs/design/remote-control.md).
