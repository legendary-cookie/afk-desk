# Phase 2 protocol evidence and qualification

Paths below are relative to `desktop/`. Inspected against the installed
`bedrock-protocol@3.59.0` and `minecraft-data@3.112.0` on 2026-10-27.

## Verified wire facts

- `node_modules/minecraft-data/minecraft-data/data/bedrock/1.26.30/protocol.json:12951`
  defines `player_auth_input`: float pitch/yaw/head yaw, position, movement vector,
  input flags, input/play/interaction modes, interaction rotation, varint64 tick,
  delta, analogue/raw movement vectors, and camera orientation. Optional transaction
  payloads are gated by input flags; this stationary implementation leaves them off.
- The same file at `:13221` defines the named `InputFlag` bitflags, including
  `jump_down`, `jumping`, `start_jumping`, sneaking/sprinting and their start/stop
  edges, and `handled_teleport`. False flags serialize as unset bits.
- The same file at `:825` defines **vec2f as `{ x, z }`**, including rotations.
  The plan's `{ x, y }` description does not match the installed serializer.
  Incoming rotation accepts `z` first, retaining `y` compatibility with Phase 1
  callers/fixtures. Outgoing interaction rotation uses `{ x: pitch, z: yaw }`.
- The same file at `:8848` defines `move_player`, with numeric `varint`
  `runtime_id`/`ridden_runtime_id`, reset/teleport modes, and varint64 tick.
  At `:13694`, `correct_player_move_prediction` includes player/vehicle type,
  position and rotation. Only player corrections affect this session.
- The same file at `:9728` defines `animate`/`swing_arm`, including the modern
  `data` and `has_swing_source` fields. At `:9600`, `player_action` defines the
  legacy jump/sneak/sprint action path. Packet round-trips cover the older action
  schemas as well as the modern animation schema.
- `node_modules/minecraft-data/minecraft-data/data/bedrock/1.21.50/protocol.json:5972`
  has `start_game.movement_authority` (`client`, `server`, `server_with_rewind`).
  `1.26.30/protocol.json:8242` has no such field. Authority selection inspects the
  negotiated schema and, where present, the server's advertised value.
- `node_modules/minecraft-data/minecraft-data/data/bedrock/latest/proto.yml:3084`
  documents one `player_auth_input` per tick for server authority instead of
  `move_player`. At `:4354`, it documents the removal of authority switching in
  protocol 818 / 1.21.90. Modern sessions ignore that deprecated packet.
- `latest/proto.yml:629` and `:632` explicitly document pitch and yaw in
  **degrees**. `protocol.json` represents these as `lf32`;
  `node_modules/bedrock-protocol/src/transforms/serializer.js:32` compiles that
  schema, and `src/connection.js:101` serializes queue arguments directly. There
  is no radians conversion in the library. The manager's public look APIs accept
  radians, matching Java, and convert to wire degrees.

The installed schemas do not document the eye offset. Primary server source
confirms it: [PocketMine's input handler](https://apidoc.pmmp.io/db/dc4/_in_game_packet_handler_8php_source.html)
subtracts 1.62 from auth input position at source line 202;
[its spawn handler](https://apidoc.pmmp.io/dd/dbe/_pre_spawn_packet_handler_8php_source.html)
sends `getOffsetPosition` in `start_game` at source line 97, and
[NetworkSession](https://apidoc.pmmp.io/dd/dbe/_network_session_8php_source.html)
uses the same offset for `move_player` at source line 1068. Session/telemetry
positions are now exact feet coordinates; outbound position is feet + 1.62.
Display rounding must never feed back into movement packets.

## Observed offline behavior

`test/bedrock-phase2.test.cjs` uses an emitter and a deterministic injected clock,
without sockets, real timers, workers, or MockTimers. It verifies 20 TPS after
spawn, monotonic ticks, one outstanding movement timer, close/disconnect cleanup,
stale-callback fencing, owners' union and scoped release, macro priority, randomized
anti-AFK settings, jump flags and an internal vertical arc, swing-only clicks,
look conversion, exact correction adoption and one-shot teleport acknowledgements,
legacy 250 ms change-only movement, authority switching, send failure cleanup, and
capabilities. Its serializer/parser check covers all 51 installed supported versions,
including client authority where that schema permits it.

The Phase 1 suite's `test/bedrock-phase1.test.cjs:138` still asserts
`movement === false`. The lead must update that unowned assertion to
`'stationary'` when integrating Phase 2. Contract editions are intentionally left
for the lead, as requested.

## Limits

No BDS, PocketMine, Geyser, or anti-cheat qualification was performed for this
movement implementation. The loop sends stationary position and zero delta;
the jump arc is bookkeeping and is never added to wire position. Servers that
expect collision-aware client prediction may correct or reject that input. Legacy
jump sends the action but does not simulate displacement. Walking, entity attack,
block interaction, and physics/collision remain outside Phase 2's assigned scope.
