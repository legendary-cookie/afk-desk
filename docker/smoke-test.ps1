param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker $($args[0]) failed (exit $LASTEXITCODE)" }
}

function Get-DockerLogs {
    # Windows PowerShell wraps native stderr in ErrorRecords even with 2>&1.
    $ErrorActionPreference = 'Continue'
    & docker logs $container 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "docker logs failed (exit $LASTEXITCODE)" }
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$image = if ($env:AFKDESK_IMAGE) { $env:AFKDESK_IMAGE } else { 'afkdesk:smoke' }
$suffix = [guid]::NewGuid().ToString('N')
$volume = "afkdesk-smoke-$suffix"
$container = "afkdesk-smoke-$suffix"
$volumeCreated = $false
$containerCreated = $false
$failed = $false
try {
    if (-not $SkipBuild) {
        Invoke-Docker build --tag $image --file (Join-Path $repoRoot 'docker/Dockerfile') $repoRoot
    }
    Invoke-Docker volume create $volume | Out-Null
    $volumeCreated = $true
    $password = "Smoke-$([guid]::NewGuid().ToString('N'))!"
    $runtime = @('--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--volume', "${volume}:/data")
    $password | & docker run --rm -i @runtime $image init --password-stdin
    if ($LASTEXITCODE -ne 0) { throw "Admin initialization failed (exit $LASTEXITCODE)" }
    # Build the argument list explicitly: passing these through a helper's
    # automatic $args lost the --publish flag on PowerShell 7 (CI saw
    # "pull access denied for 127.0.0.1").
    $runArgs = @('run', '--detach', '--name', $container) + $runtime + @(
        '--env', 'AFKDESK_BIND=0.0.0.0',
        '--env', 'AFKDESK_ALLOWED_HOSTS=localhost,127.0.0.1',
        '--publish', '127.0.0.1::8787',
        $image, 'start', '--i-understand-plain-http')
    & docker @runArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker run failed (exit $LASTEXITCODE)" }
    $containerCreated = $true
    $healthy = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $state = Invoke-Docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' $container
        if ($state -eq 'running healthy') { $healthy = $true; break }
        if ($state -ne 'running starting') { throw "Unexpected container state: $state" }
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) { throw 'Timed out waiting for healthy container' }
    $inspection = (Invoke-Docker inspect $container | ConvertFrom-Json)[0]
    $port = $inspection.NetworkSettings.Ports.'8787/tcp'[0].HostPort
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 5
    if ($health.ok -ne $true) { throw 'Published health endpoint did not return ok' }
    # Keep the same wire assertions as smoke-test.sh. Password travels on stdin,
    # never in an image layer or the docker exec command arguments.
    $probe = @'
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
});
'@
    # Windows PowerShell's legacy native argument passing can strip JS quotes.
    $encodedProbe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
    $password | & docker exec -i $container node -e "eval(Buffer.from('$encodedProbe','base64').toString())"
    if ($LASTEXITCODE -ne 0) { throw "HTTP smoke assertions failed (exit $LASTEXITCODE)" }
    Invoke-Docker stop --time 30 $container | Out-Null
    $exitCode = Invoke-Docker inspect --format '{{.State.ExitCode}}' $container
    $oomKilled = Invoke-Docker inspect --format '{{.State.OOMKilled}}' $container
    if ($exitCode -ne '0' -or $oomKilled -ne 'false') { throw "Unclean stop: exit=$exitCode OOM=$oomKilled" }
    $logs = Get-DockerLogs
    if (-not ($logs -match 'Received SIGTERM, shutting down gracefully')) { throw 'Missing SIGTERM shutdown evidence' }
    Write-Output 'Docker smoke test passed (clean SIGTERM exit)'
} catch {
    $failed = $true
    Write-Warning $_
    if ($containerCreated) { Get-DockerLogs }
} finally {
    if ($containerCreated) {
        & docker rm --force $container | Out-Null
        if ($LASTEXITCODE -ne 0) { $failed = $true }
    }
    if ($volumeCreated) {
        & docker volume rm $volume | Out-Null
        if ($LASTEXITCODE -ne 0) { $failed = $true }
    }
}
if ($failed) { exit 1 }
