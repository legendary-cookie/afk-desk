# Contributing

Bug reports and focused pull requests are welcome.

1. Do not include Microsoft tokens, account profiles, proxy credentials, signing keys, or server secrets.
2. Keep desktop and mobile behavior aligned when changing shared connection logic.
3. Add or update regression tests for fixes.
4. Run the relevant test commands documented in the root README before opening a pull request.

Please describe the affected Minecraft version, proxy software, and exact disconnect message when reporting connection problems.

## Milestone publishing

After a coherent, tested milestone, commit its source and regression tests, push the working branch to GitHub, and open or update a pull request against `main`. Record the checks that actually ran and any remaining limitations in the pull request. Keep account data, local backups, built installers, and signing material out of commits. A source milestone does not by itself publish a signed release or replace an installed app.
