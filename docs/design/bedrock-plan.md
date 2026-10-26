# Bedrock Edition Capability Assessment & Implementation Plan (Track R7)

## 1. Executive Summary

AFK Desk routes Bedrock profiles (`desktop/electron/multi-edition-manager.cjs:8-37`) to `BedrockBotManager` (`desktop/electron/bedrock-bot-manager.cjs:5-211`), wrapping `bedrock-protocol@3.59.0` directly (`desktop/node_modules/bedrock-protocol/package.json:2-3`). Today Bedrock supports Xbox Live device-code login, chat/commands, reconnect, player tracking, and raw `inventory_content` counts (`bedrock-bot-manager.cjs:26-102, 151-169, 213`). Movement, anti-AFK, inventory actions, containers, forms, and world blocks are stubbed or throw (`:171-192`), and Macro Engine v2 limits Bedrock to 6 triggers (`manual`, `join`, `timer`, `schedule`, `chat`, `disconnected`) and 9 engine/lifecycle steps (`desktop/electron/macro/contract.cjs:74-114`).

**Critical source findings:**
1. **Transport & version bugs:**
   - `BedrockBotManager.connect` passes `raknetBackend: 'jsp-raknet'` (`bedrock-bot-manager.cjs:33`), but `jsp-raknet@2.2.0` hardcodes RakNet protocol `10` (`desktop/node_modules/jsp-raknet/js/Client.js:21, 98`; `Server.js:22, 115`), whereas Bedrock `>=1.19.30` requires RakNet protocol `11` (`desktop/node_modules/bedrock-protocol/src/rak.js:44, 105`). Also, `createClient.js` unconditionally loads `raknet-native` at top level and uses it for `ping()` (`src/createClient.js:2, 19, 102-104`).
   - `src/options.js:6` sets `CURRENT_VERSION = '1.26.45'`, which is missing from installed `minecraft-data@3.112.0` (`options.js:8` ends at `1.26.30` / protocol `1001`). Falling back to `CURRENT_VERSION` (`createClient.js:21`) throws `Unsupported version 1.26.45` (`options.js:41`).
2. **Protocol mismatches:**
   - `bedrock-bot-manager.cjs:80` listens to non-existent `set_hunger`; Bedrock sends health (`minecraft:health`), hunger (`minecraft:player.hunger`), and speed (`minecraft:movement`) via `update_attributes` (`desktop/node_modules/minecraft-data/minecraft-data/data/bedrock/1.26.30/protocol.json:1394, 9438`).
   - `start_game` rotation is `packet.rotation.{x,y}` (`vec2f`, `protocol.json:8242`), not `packet.yaw`/`pitch` (`bedrock-bot-manager.cjs:68-69`).
   - `sendChat` (`bedrock-bot-manager.cjs:160`) omits `category` and `has_filtered_message` from modern `packet_text` (`protocol.json:8002`).
3. **Physics & server-authoritative movement:** `prismarine-physics` only supports Java (`desktop/node_modules/prismarine-physics/index.js:11-37`, `lib/features.json:1-32`). Bedrock `1.21.90+` removed client-authoritative movement (`movement_authority` in `1.21.50/protocol.json:5972` vs removed in `1.26.30/protocol.json:8242`), requiring `player_auth_input` every 50 ms tick (`protocol.json:12951`). Stationary anti-AFK (`look`, `sneak`, `swing`, in-place `jump` arc) needs only a 20 TPS `player_auth_input` loop; `walk` requires chunk collision or flat-ground micro-steps with teleport rollback.

---

## 2. Current State & `bedrock-protocol` Capabilities

### 2.1 Current `BedrockBotManager`
- **Auth (`bedrock-bot-manager.cjs:15-102`):** Uses `createClient` with `offline: false` and `onMsaCode` (`:26-37`). `src/client/auth.js:2, 21-28, 81-125` authenticates Xbox Live via `prismarine-auth@3.1.1` (`Titles.MinecraftNintendoSwitch`, `DeviceOS: 12`) and supports `offline: true` using self-signed JWT chains (`<944`) or OIDC tokens (`>=944`, `src/handshake/login.js:10-37`).
- **51 Supported Versions (`src/options.js:4-12`):** `1.16.201` (422), `1.16.210` (428), `1.16.220` (431), `1.17.0` (440), `1.17.10` (448), `1.17.30` (465), `1.17.40` (471), `1.18.0` (475), `1.18.11` (486), `1.18.30` (503), `1.19.1` (527), `1.19.10` (534), `1.19.20` (544), `1.19.21` (545), `1.19.30` (554), `1.19.40` (557), `1.19.50` (560), `1.19.60` (567), `1.19.62` (567), `1.19.63` (568), `1.19.70` (575), `1.19.80` (582), `1.20.0` (589), `1.20.10` (594), `1.20.15` (594), `1.20.30` (618), `1.20.40` (622), `1.20.50` (630), `1.20.61` (649), `1.20.71` (662), `1.20.80` (671), `1.21.0` (685), `1.21.2` (686), `1.21.20` (712), `1.21.30` (729), `1.21.42` (748), `1.21.50` (766), `1.21.60` (776), `1.21.70` (786), `1.21.80` (800), `1.21.90` (818), `1.21.93` (819), `1.21.100` (827), `1.21.111` (844), `1.21.120` (859), `1.21.124` (860), `1.21.130` (898), `1.26.0` (924), `1.26.10` (944), `1.26.20` (975), `1.26.30` (1001).
- **Stubs (`bedrock-bot-manager.cjs:171-192`):** Movement, camera, inventory, GUI, and world methods throw (`:223`) or no-op (`:181-185`). Input-ownership methods (`claimInput`, `releaseInput`, `releaseOwner`, `facade.cjs:110-141, 308`) are unimplemented.

### 2.2 Protocol Packets (`1.26.30/protocol.json`)
- **Movement (`packet_player_auth_input` `:12951`, `packet_move_player` `:8848`):** Client sends `player_auth_input` every tick with `pitch`, `yaw`, `head_yaw`, `position` (eye = feet + 1.62), `move_vector`, `input_data` (`InputFlag` `:13221`: `ascend`, `descend`, `jump_down`, `jumping`, `start_jumping`, `sneaking`, `sneak_down`, `start_sneaking`, `stop_sneaking`, `sprinting`, `up`, `down`, `left`, `right`, `handled_teleport`, `missed_swing`, `item_interact`, `item_stack_request`, `block_action`), `tick`, and `delta`.
- **Inventory & Item Stack (`:9846, 9867, 13380, 13395, 2853`):** `inventory_content` (`:9846`) and `inventory_slot` (`:9867`) carry `ItemNew` (`stack_id.id`, `network_id`, `count`, `extra.nbt`). Item names resolve via `item_registry` (`1.21.60+`, `src/client.js:266`) / `start_game.itemstates` (`src/connection.js:82`) and `minecraft-data` (`1933` items). Mutations use `packet_item_stack_request` (`:13380`) with `ItemStackRequest` (`:2853`) actions (`take`, `place`, `swap`, `drop`, `destroy`, `consume`, `place_in_container`, `take_out_container`) targeting `StackRequestSlotInfo` (`{ slot_type: { container_id }, slot, stack_id }`, `:2836`), confirmed by `packet_item_stack_response` (`:13395`). Hotbar uses `packet_mob_equipment` (`:9464`).
- **Containers & Forms (`:9791, 9812, 11783, 11796`):** `container_open` (`:9791`) and `container_close` (`:9812`) manage chest/window sessions. Server menus frequently use JSON UI forms (`modal_form_request` `:11783`, `server_settings_response` `:11858`) answered via `modal_form_response` (`:11796`).
- **Interact, Attack, Blocks, Respawn, Transfer (`:9455, 9600, 9728, 9774, 11319`):** Entity hit/interact uses `inventory_transaction` (`item_use_on_entity`, `action_type: 'attack'|'interact'`, `:1669`) + `animate` (`swing_arm`, `:9728`). Block dig uses `player_auth_input.block_action` (`:12951, 2790`) or `player_action` (`:9600`). Respawn handshakes `respawn` (`state: 1` → client `state: 2`, `:9774`) + `player_action` (`action: 'respawn'`). Server switches use `packet_transfer` (`:11319`).
- **Geyser:** Translates Java menus into `container_open` or `modal_form_request`, emits `update_attributes`, and validates `player_auth_input` against Java movement rules (custom Geyser anti-cheat plugins unverified).

---

## 3. Capability Matrix

| Feature | Today | Feasible w/ `bedrock-protocol` | Needs New Subsystem | Not Feasible |
| --- | --- | --- | --- | --- |
| Xbox Live & offline auth, reconnect | **Yes** (`bedrock-bot-manager.cjs:26-102`) | — | — | — |
| Chat & `/` commands (`text`, `command_request`) | **Yes** (`:83-86, 151-163`; needs `text` schema fix) | — | — | — |
| Health, hunger, death & auto-respawn | Partial (`set_health` only; `set_hunger` broken `:79-80`) | **Yes** (`update_attributes`, `respawn`, `player_action`) | — | — |
| Server transfers (`transfer`) & dimensions | No | **Yes** (`transfer` `:11319`, `change_dimension`) | — | — |
| Inventory read view (names, NBT, item locks) | Partial (raw `network_id` `:87-91, 227-232`) | **Yes** (`item_registry` + `inventory_content`/`slot`) | — | — |
| Server forms (`modal_form_request`/`response`) | No | **Yes** (`protocol.json:11783-11805`) | — | — |
| Stationary anti-AFK (`look`, `sneak`, `swing`, `jump`) | No | — | **Yes** (20 TPS `player_auth_input` loop) | — |
| Walk movement (`move`, `walk` anti-AFK, fluids) | No | — | **Yes** (Bedrock AABB physics + chunk collision) | Full Java fluid parity |
| Inventory actions (`drop`, `move`, `equip`, `deposit`) | No | — | **Yes** (`ItemStackRequest` queue + `stack_id` tracker) | — |
| World blocks / POV (`level_chunk`, `subchunk`) | No (`blocks: []` `:187-190`) | — | **Yes** (`prismarine-chunk` subchunk store + `1.26` map) | — |
| Java TCP proxy pool | Blocked (`:19`) | — | — | **Not feasible** over TCP proxies |

---

## 4. Phased Implementation Plan

### Phase 1: Transport Fix, Telemetry, Respawn, Inventory View & Forms (3 days)
- **Work:**
  1. Use `raknet-native` on desktop, patch `jsp-raknet` to RakNet protocol `11` (`jsp-raknet/js/Client.js:21`, `Server.js:22`) and `createClient.js:2` to respect `raknetBackend`, and clamp fallback `CURRENT_VERSION` to `1.26.30` (`options.js:6-8`).
  2. Fix `start_game` rotation (`packet.rotation`), `text` fields (`category: 'authored'`, `has_filtered_message: false`), and parse `update_attributes` (`minecraft:health`, `minecraft:player.hunger`).
  3. Auto-respawn (`respawn` `state: 2` + `player_action` `respawn`) and emit `spawn`, `death`, `respawn`, and `serverSwitch` (on `transfer`) `BotEvent`s (`contract.cjs:36, 219-231`).
  4. Resolve item names/NBT from `item_registry`/`start_game.itemstates` + `minecraft-data`, handle `inventory_slot`, and wire `setItemLocks`.
  5. Surface `modal_form_request` and `container_open` as `window` events; support form responses and `closeWindow`.
- **Macro Unlocks:**
  - `TRIGGER_TYPES`: `death`, `healthBelow`, `hungerBelow`, `inventoryFull`, `inventoryChanged`, `windowOpen`, `worldChange` (all 13 triggers enabled for `'bedrock'`).
  - `STEP_TYPES`: `useGui` (forms), `closeGui`, `waitForWindow`.

### Phase 2: `player_auth_input` Tick Loop, Input Ownership & Anti-AFK (4 days)
- **Work:**
  1. Run a 50 ms `player_auth_input` loop (`protocol.json:12951`) tracking `tick`, `position`, `yaw`/`pitch`/`head_yaw`, `delta`, and `InputFlag`s (`:13221`), acknowledging server `move_player` teleports with `handled_teleport`.
  2. Implement `claimInput`/`releaseInput`/`releaseOwner`/`inputOwners` (`bot-manager.cjs:550-581`).
  3. Enable `look`, `lookDelta`, `lookAbsolute`, `swingArm`, `control` (`sneak`, `jump`, `sprint`), `setAntiAfk`,entity `leftClick` (`inventory_transaction` `item_use_on_entity`), and flat-ground timed `move`.
- **Macro Unlocks:**
  - `STEP_TYPES`: `look` (`absolute`/`relative`/`at` entity), `control`, `move` (duration), `leftClick` (entities/swing), `rightClick` (held item).

### Phase 3: `ItemStackRequest` Actions & Containers (4 days)
- **Work:**
  1. Track `stack_id` per `(container_id, slot)` across `inventory_content`, `inventory_slot`, and `item_stack_response` (`protocol.json:13395`).
  2. Implement serialized `ItemStackRequest` actions (`drop`, `swap`, `place`, `take`, `place_in_container`, `take_out_container`, `:2853`) and `mob_equipment` (`:9464`) with facade item-lock checks (`facade.cjs:168-211`).
- **Macro Unlocks:**
  - `STEP_TYPES`: `selectHotbar`, `holdItem`, `useInventory`, `useGui` (containers), `drop`, `dropAll`, `deposit` (open/known container).

### Phase 4: Chunk/Subchunk Decoding & POV World Actions (5 days)
- **Work:**
  1. Map `bedrock` `1.26` to `./bedrock/1.18/chunk` in `prismarine-chunk` (`desktop/node_modules/prismarine-chunk/src/index.js:18-28`).
  2. Decode `level_chunk` (`:10106`), issue `subchunk_request` (`:14199`), and apply `subchunk` (`:14169`) + `update_block` into a column cache for `worldSnapshot`, raycast block dig/use, and `findNearestChest` (`setAutoDeposit`).
- **Macro Unlocks:**
  - `STEP_TYPES`: `move` (distance), `look` (`at` block), `leftClick`/`rightClick` (blocks), automatic chest `deposit`.

---

## 5. Offline Test Strategy

- **Loopback Server:** `bedrock-protocol` exports `createServer` (`index.js:11, 21`; `src/createServer.js:3-8`; `src/server.js:9-158`) supporting `offline: true` (`src/auth/loginVerifier.js:86, 99-108`). It works as an offline loopback test server when `skipPing: true` (`src/createClient.js:16-17`) and either `raknet-native` or patched `jsp-raknet` (`useRaknetWorkers: false`, avoiding `src/rak.js:241`) is used.
- **Zero-UDP Unit Tests:** Injecting a fake `EventEmitter` client into `new BedrockBotManager({ createClient })` (`bedrock-bot-manager.cjs:6`) paired with `createSerializer`/`createDeserializer` (`src/transforms/serializer.js:60-68`) verifies packet schemas and macro triggers/steps deterministically without sockets.

---

## 6. Risks & Platform Constraints

1. **Server Anti-Cheat:** BDS (`rewind_history_size`, `protocol.json:8242`), PocketMine, and Geyser reject unsimulated `player_auth_input` deltas. Mitigation: default anti-AFK to `look`/`sneak`/`swing` and snap position + set `handled_teleport` on server `move_player`.
2. **Protocol Churn:** 51 releases since `1.16.201` (`options.js:8`) require frequent `bedrock-protocol`/`minecraft-data` updates and guards against `CURRENT_VERSION` skew (`options.js:6`).
3. **Native `raknet-native@1.2.3` vs Pure-JS `jsp-raknet@2.2.0`:**
   - **Windows/Linux Docker:** `raknet-native/prebuilds/` only ships `win32-10-x64`, `linux-5-x64`, and `darwin-21-x64`. `helpers/buildPath.js:11-14` keys on `os.release()` major (`win32-10-x64` matches Win 10/11, but Linux 6.x looks for `linux-6-x64`, and `binding.js:18` never calls `getFallbackPath()`), requiring `cmake-js` + C++ build tools (`buildChecks.js:47-55`) and matching `glibc`.
   - **Android (`nodejs-mobile-react-native@18.20.4`, `mobile/package.json:14`):** No `android-arm64` prebuild exists. Pure-JS `jsp-raknet` uses Node `dgram`/`crypto`/`events` (`jsp-raknet/js/Client.js:7-9`, Node 18 compatible) and is usable as the Android/Docker fallback once patched via `patch-package` (`mobile/nodejs-assets/nodejs-project/package.json:7, 24`) to RakNet protocol `11` and `useRaknetWorkers: false`.
