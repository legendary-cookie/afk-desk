# Security model

## Trust boundaries and assets

- Microsoft authentication runs through Prismarine Auth. Passwords never enter AFK Desk; cached tokens live in the Electron user-data directory.
- The renderer is isolated from Node.js and uses a narrow preload bridge for local desktop actions.
- AFK Desk does not start a local HTTP server or expose browser/remote-control access.
- External links are restricted to HTTP and HTTPS, while Microsoft sign-in uses an isolated, HTTPS-only session.

## Known dependency advisory

As of 2026-09-28, `npm audit --omit=dev --json` reports zero production dependency advisories in this checkout. The Microsoft authentication UUID dependencies are pinned to patched 11.1.1, and both desktop and embedded Android resource-pack engines use `adm-zip` 0.6.1, which addresses GHSA-7q85-xj36-vmfc. The full desktop dependency tree still reports three high development dependency advisories; that broader toolchain review is separate from the production audit. Audit results are point-in-time and do not prove all downloaded content is safe.
