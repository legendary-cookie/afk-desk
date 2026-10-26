#!/usr/bin/env bash
set -euo pipefail

# Requires Bash, Docker, and curl. Run from any directory; removes only resources
# created by this invocation. --skip-build tests an already loaded image in CI.
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
image="${AFKDESK_IMAGE:-afkdesk:smoke}"
if [[ $# -gt 1 || ($# -eq 1 && $1 != --skip-build) ]]; then
  echo "Usage: $0 [--skip-build] (AFKDESK_IMAGE selects the image)" >&2
  exit 2
fi
if [[ ${1:-} != --skip-build ]]; then
  docker build --tag "$image" --file "$root/docker/Dockerfile" "$root"
fi
suffix="$(date +%s)-$$-$RANDOM"
volume="afkdesk-smoke-$suffix"
container="afkdesk-smoke-$suffix"
volume_created=0
container_created=0
cleanup() {
  status=$?
  trap - EXIT
  if [[ $container_created == 1 ]]; then
    if [[ $status != 0 ]]; then docker logs "$container" >&2 || true; fi
    docker rm --force "$container" >/dev/null || status=1
  fi
  if [[ $volume_created == 1 ]]; then docker volume rm "$volume" >/dev/null || status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker volume create "$volume" >/dev/null
volume_created=1
password="Smoke-$(date +%s)-$RANDOM-$RANDOM!"
runtime=(--read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777
  --cap-drop ALL --security-opt no-new-privileges:true --volume "$volume:/data")
printf '%s\n' "$password" | docker run --rm -i "${runtime[@]}" "$image" init --password-stdin
docker run --detach --name "$container" "${runtime[@]}" \
  --env AFKDESK_BIND=0.0.0.0 --env AFKDESK_ALLOWED_HOSTS=localhost,127.0.0.1 \
  --publish 127.0.0.1::8787 "$image" start --i-understand-plain-http >/dev/null
container_created=1
healthy=0
for ((attempt = 0; attempt < 90; attempt++)); do
  state="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container")"
  case "$state" in
    'running healthy') healthy=1; break ;;
    'running starting') sleep 2 ;;
    *) echo "Unexpected container state: $state" >&2; exit 1 ;;
  esac
done
[[ $healthy == 1 ]] || { echo 'Timed out waiting for healthy container' >&2; exit 1; }
port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8787/tcp") 0).HostPort}}' "$container")"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port/healthz"
printf '%s\n' "$password" | docker exec -i "$container" node -e '
const assert = require("node:assert/strict");
let password = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => password += chunk);
process.stdin.on("end", async () => {
  const base = "http://127.0.0.1:8787";
  const request = (route, options = {}) => fetch(base + route, {
    ...options, signal: AbortSignal.timeout(5000)
  });
  try {
    const health = await request("/healthz");
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.deepEqual(Object.keys(body).sort(), ["ok", "version"]);
    const headers = { Origin: base, "Content-Type": "application/json" };
    const denied = await request("/api/invoke", {
      method: "POST", headers, body: JSON.stringify({ channel: "app:version", args: [] })
    });
    assert.equal(denied.status, 401);
    const login = await request("/api/login", {
      method: "POST", headers,
      body: JSON.stringify({ username: "admin", password: password.trim() })
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.equal(session.ok, true);
    assert.ok(session.csrfToken);
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie && cookie.includes("HttpOnly"));
    const authenticated = await request("/api/session", { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(authenticated.status, 200);
    console.log("Health, unauthenticated 401, login 200, and session checks passed");
  } catch (error) { console.error(error); process.exitCode = 1; }
});'
docker stop --time 30 "$container" >/dev/null
[[ $(docker inspect --format '{{.State.ExitCode}}' "$container") == 0 ]]
[[ $(docker inspect --format '{{.State.OOMKilled}}' "$container") == false ]]
docker logs "$container" 2>&1 | grep -F 'Received SIGTERM, shutting down gracefully' >/dev/null
echo 'Docker smoke test passed (clean SIGTERM exit)'
