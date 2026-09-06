# UUID security override - 2026-09-06

The desktop and embedded mobile engine pin the `uuid` dependency of
`@azure/msal-node` and `yggdrasil` to `11.1.1` using scoped npm overrides.
This addresses [GHSA-w5hq-g745-h8pq / CVE-2026-41907](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq).
The [official 11.1.1 changelog](https://raw.githubusercontent.com/uuidjs/uuid/v11.1.1/CHANGELOG.md)
identifies the backported security fix.

## Compatibility and scope

- Before the override, MSAL resolved UUID 8.3.2 and Yggdrasil resolved 10.0.0.
- Both installed consumers import `uuid` through CommonJS and call `uuid.v4()`.
  No affected `v3`/`v5` buffer call was found in those consumer call sites.
- UUID 11 retains the named CommonJS `v4` export. Reviewed breaking changes
  concern older Node/browser support, package exports, and v1/v7 state handling;
  these callers do not rely on those behaviors.
- Each lockfile changes only the UUID package entry and removes the superseded
  nested Yggdrasil UUID copy. Registry remains `registry.npmjs.org`; there are
  no new dependencies or install scripts.
- Existing Mineflayer and prismarine-physics compatibility patches were reapplied
  successfully after both installs.

Remove each override when that consumer's upstream dependency range resolves to
a patched UUID version by itself, after rerunning the dependency regression and
engine tests. Do not remove a pin merely because npm's current audit is clear.

## Observed verification

On Windows with Node 26.8.1, the new desktop
`test/dependency-security.test.cjs` exercises dependency resolution in both engines.
Before upgrading, four buffer-bounds regressions failed and the two consumer
construction tests passed. After upgrading, all six pass (exit 0):

- v3/v5 reject undersized buffers and negative offsets through each consumer's
  resolved UUID package; v4 still returns valid UUIDs.
- MSAL PublicClientApplication constructs, its CryptoProvider generates a GUID,
  and the Yggdrasil client constructs, without an authentication network request.

`npm audit --omit=dev --json` reports zero vulnerabilities in both desktop and
embedded mobile engine production trees on this date (exit 0 for both).
This is a registry advisory snapshot, not evidence that all application behavior
is secure. Live Microsoft login, Minecraft servers, Android's embedded Node
runtime and packaged native modules were not exercised by this dependency test.

Installation used `npm install --ignore-scripts --no-audit --no-fund` followed by
the existing local `patch-package` runner in each engine. No force resolution or
broad dependency update was used. Roll back this dependency batch's manifest,
lockfile, test and report together, then install the restored lockfile and reapply
the existing patches; doing so also restores the known vulnerable UUID versions.
