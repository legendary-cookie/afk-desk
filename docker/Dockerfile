# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
    && git config --global --add url."https://github.com/".insteadOf git@github.com:
COPY desktop/package.json desktop/package-lock.json ./
COPY desktop/patches ./patches
# postinstall is patch-package, but that tool is a devDependency. Install it
# separately so Electron and the rest of the desktop devDependencies never enter
# the application tree. No lifecycle scripts run until patches have been applied.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm install --prefix /patch-tool --no-save --package-lock=false \
       --ignore-scripts --no-audit --no-fund patch-package@8.0.1 \
    && node /patch-tool/node_modules/patch-package/index.js --error-on-fail
ARG AFKDESK_SKIP_RAKNET_NATIVE=0
RUN <<'BUILD_NATIVE'
node <<'NODE'
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const lock = require('./package-lock.json');
const rebuilt = new Set();
// Rebuild installed dependencies, never the root postinstall (its tool lives
// outside /app). Fail on other native/module errors; only RakNet may degrade.
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || !fs.existsSync(`${location}/package.json`)) continue;
  if (!entry.hasInstallScript && !fs.existsSync(`${location}/binding.gyp`)) continue;
  const { name } = require(`${process.cwd()}/${location}/package.json`);
  if (name === 'raknet-native' || rebuilt.has(name)) continue;
  rebuilt.add(name);
  const result = spawnSync('npm', ['rebuild', name, '--foreground-scripts'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const native = process.env.AFKDESK_SKIP_RAKNET_NATIVE !== '1' &&
  spawnSync('npm', ['rebuild', 'raknet-native', '--foreground-scripts'], { stdio: 'inherit' }).status === 0;
let usable = native;
if (usable) {
  try { require('raknet-native'); } catch (error) { console.warn(error.message); usable = false; }
}
if (!usable) {
  console.warn('Native RakNet unavailable; using the existing patched jsp-raknet fallback.');
  fs.rmSync('node_modules/raknet-native', { recursive: true, force: true });
}
if (fs.existsSync('node_modules/electron')) throw new Error('Electron must not be installed');
NODE
BUILD_NATIVE
COPY desktop/core ./core
COPY desktop/electron ./electron
COPY desktop/server ./server
COPY desktop/src ./src
COPY desktop/assets ./assets
# Catch missing server-mode modules (including accidental Electron imports)
# during each architecture's build, even when native RakNet is unavailable.
RUN node -e "require('./server/cli.cjs')"

FROM node:22-bookworm-slim AS runtime
ARG VERSION=development
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="AFK Desk Server" \
      org.opencontainers.image.description="Headless AFK Desk server" \
      org.opencontainers.image.source="https://github.com/legendary-cookie/afk-desk" \
      org.opencontainers.image.url="https://github.com/legendary-cookie/afk-desk" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.created=$CREATED
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 afkdesk \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /data afkdesk \
    && mkdir /data && chown 10001:10001 /data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/core ./core
COPY --from=build /app/electron ./electron
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/assets ./assets
ENV NODE_ENV=production ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    AFKDESK_DATA=/data AFKDESK_PORT=8787 HOME=/data TZ=UTC
# Binding stays opt-in. Compose explicitly supplies AFKDESK_BIND and the
# plain-HTTP acknowledgement where there is no HTTPS reverse proxy.
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.AFKDESK_PORT||8787)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "server/cli.cjs"]
CMD ["start"]
