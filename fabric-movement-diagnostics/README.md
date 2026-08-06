# AFK Desk Movement Diagnostics

This client-only Fabric mod records Minecraft Java Edition's real vanilla movement state once per client tick. It exists to compare water movement against AFK Desk's lightweight physics implementation.

The log is written to `logs/afkdesk-vanilla-movement.jsonl` inside the active Minecraft game directory. It contains coordinates, velocity, water/collision flags, fluid height, tick timing, and nearby block/fluid states. It does not record Microsoft credentials, access tokens, chat, or inventory.

## Test procedure

1. Launch Minecraft 1.21.1 with Fabric Loader and Fabric API.
2. Put the diagnostic jar whose filename matches the Minecraft version in the profile's `mods` folder.
3. Join the same server and stand in the same water loop for 60 seconds.
4. Exit Minecraft so the final buffered samples are flushed.
5. Compare the generated JSONL log with AFK Desk's movement diagnostic log.

Do not run the same Minecraft account in AFK Desk and the vanilla client simultaneously.
