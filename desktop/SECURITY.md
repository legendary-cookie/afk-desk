# Security model

## Trust boundaries and assets

- Microsoft authentication runs through Prismarine Auth. Passwords never enter AFK Desk; cached tokens live in the Electron user-data directory.
- The renderer is isolated from Node.js and uses a narrow preload bridge for local desktop actions.
- AFK Desk does not start a local HTTP server or expose browser/remote-control access.
- External links are restricted to HTTP and HTTPS, while Microsoft sign-in uses an isolated, HTTPS-only session.

## Known dependency advisory

As of 2026-07-29, `npm audit --omit=dev` reports moderate `uuid` advisories through Mineflayer's Microsoft authentication dependency chain. npm offers only a forced downgrade to an obsolete, incompatible Mineflayer release. This is tracked pending an upstream compatible dependency update; no forced downgrade is applied.
