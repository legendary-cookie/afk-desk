# Security model

## Trust boundaries and assets

- Microsoft authentication runs through Prismarine Auth. Passwords never enter AFK Desk; cached tokens live in the Electron user-data directory.
- Remote HTTP requests are untrusted. Minecraft account visibility and actions are authorized server-side for every request.
- Browser access links are bearer credentials. Anyone holding a link receives only its configured accounts and permissions until the link is revoked.

## Remote access controls

- The HTTP server binds only to `127.0.0.1`.
- Remote transport is intended to use Tailscale Serve over private HTTPS.
- Access tokens contain 256 bits of randomness and are stored only as SHA-256 hashes.
- Tokens are exchanged for `HttpOnly`, `SameSite=Strict` cookies and removed from the browser URL by redirect.
- Every protected action checks both account scope and action permission.
- Request bodies are capped at 8 KiB and inputs are allowlisted and length-limited.
- Requests are rate-limited per network address and access grant.
- CSP, frame denial, MIME sniffing prevention, referrer restrictions, and browser permission restrictions are set on all responses.
- Shared access can be revoked immediately from the desktop app.

## Known dependency advisory

As of 2026-07-29, `npm audit --omit=dev` reports moderate `uuid` advisories through Mineflayer's Microsoft authentication dependency chain. npm offers only a forced downgrade to an obsolete, incompatible Mineflayer release. This is tracked pending an upstream compatible dependency update; no forced downgrade is applied.
