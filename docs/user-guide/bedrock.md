# Bedrock Edition Support

AFK Desk includes native support for **Minecraft: Bedrock Edition** alongside Minecraft Java Edition. Bedrock accounts connect directly via the Bedrock network protocol (`bedrock-protocol` and RakNet) without requiring external translation proxies or bridging software.

---

## Current Status: Phases 1 & 2 Complete

Bedrock protocol and engine capabilities differ substantially from Java Edition. Java connections use Mineflayer with client-side physics simulation, whereas modern Bedrock (`1.21.90+` / `1.26.x`) enforces server-authoritative movement requiring continuous `player_auth_input` tick packets.

Below is a clear summary of what works today and what remains in development.

---

## What Works on Bedrock Now

### 1. Sign-In and Authentication
- **Xbox Live Device-Code Sign-In**: Authenticate official Bedrock accounts using Microsoft's standard device-code flow (`https://microsoft.com/link`). Token caches are stored locally in your profiles directory.
- **Offline / Custom Authentication**: Supports connecting to self-hosted Bedrock servers (`offline: true` or custom BDS setups).
- **Supported Versions**: Supports 51 Bedrock protocol releases from `1.16.201` (protocol 422) through modern `1.26.30` (protocol 1001).

### 2. Chat and Commands
- **Send & Receive Chat**: Full color-formatted console for incoming server messages (`packet_text`).
- **Slash Commands**: Send server commands (`/warp`, `/spawn`, `/msg`) using Bedrock `command_request` and authored text payloads.
- **Automatic Messages**: Configurable join messages and proxy transfer messages.

### 3. Telemetry, Health & Auto-Respawn
- **Health and Hunger Tracking**: Accurately parses Bedrock `update_attributes` packets (`minecraft:health`, `minecraft:player.hunger`, and movement speed).
- **Death Detection**: Catches player death events.
- **Auto-Respawn**: Automatically completes the Bedrock `respawn` (state 2) and `player_action` handshake to respawn your player instantly.
- **Auto-Reconnect**: Exponential backoff reconnects after kicks, timeouts, or server restarts.

### 4. Inventory Read View
- **Item Resolution**: Translates Bedrock network item IDs and NBT data into standard item names and descriptions via `item_registry` and `minecraft-data`.
- **Slot Display**: Displays equipped armor, off-hand items, main inventory slots, and hotbar in the visual inventory grid.
- **Item Locks**: Protects designated slots with item locks (`setItemLock`) to prevent accidental actions.

### 5. Server Forms (JSON UI)
- **Modal & Custom Forms**: Full client support for Bedrock server forms (`modal_form_request` and `server_settings_response`).
- **Interactive UI**: Pop-up dialogs let you view and answer server menus, select buttons, toggle switches, and submit inputs back to the server (`modal_form_response`).

### 6. Stationary Anti-AFK
Bedrock runs a 20 TPS (50 ms) continuous `player_auth_input` tick loop that maintains input ownership and satisfies server activity checks:
- **Look Around**: Randomized smooth yaw and pitch camera rotations (`look`, `lookDelta`, `lookAbsolute`).
- **Sneaking**: Randomized crouch/sneak hold and release (`InputFlag.sneaking`).
- **Jumping**: In-place vertical jump actions (`InputFlag.jumping`).
- **Arm Swing**: Arm animation swings (`animate` / `missed_swing`).
- **Teleport Handling**: Acknowledges server position updates (`handled_teleport`) so the server does not flag desyncs.

---

## What Does NOT Work Yet (In Development)

The following capabilities are currently unavailable for Bedrock Edition accounts:

### 1. Walking / Bounded Walk Anti-AFK
- **Status**: ❌ *Unsupported / Disabled for Bedrock*
- **Why**: Bedrock uses server-authoritative movement. Walking requires calculating Bedrock AABB block and entity bounding box collisions. Simulating horizontal motion without local chunk collision causes position drift, rubberbanding, or anti-cheat kicks.
- **Anti-AFK impact**: For Bedrock profiles, the **Short walk** anti-AFK option is automatically disabled. Use stationary actions (**Look around**, **Jump**, **Sneak**, and **Swing arm**), which keep your account online reliably. Full walking is planned for Phase 4.

### 2. Inventory Mutations & Chest Auto-Deposit
- **Status**: ❌ *Unsupported for Bedrock*
- **Why**: Mutating items on Bedrock requires building a serialized `ItemStackRequest` queue with bidirectional `stack_id` transaction tracking (`protocol.json:13380`).
- **Impact**: Dropping items (`inventory.drop`), dragging items between inventory slots, equipping armor from storage, and auto-depositing items into chests are not yet supported on Bedrock. These will land in Phase 3.

### 3. Bot POV View & 3D Chunk Rendering
- **Status**: ❌ *Unsupported for Bedrock*
- **Why**: The lightweight 3D/map POV dashboard requires decoding Bedrock `level_chunk` and `subchunk` packets into block coordinate palettes.
- **Impact**: The **Bot POV** button is disabled for Bedrock accounts. Chunk decoding and world raycasting are scheduled for Phase 4.

### 4. SOCKS5 & HTTP Proxies
- **Status**: ❌ *Unsupported for Bedrock*
- **Why**: Bedrock Edition uses UDP-based **RakNet** transport. Standard Java Edition proxy tools (such as SOCKS5 or HTTP CONNECT proxies) only tunnel TCP traffic and cannot route Bedrock UDP packets.
- **Impact**: Bedrock connections must connect directly to the server host and port.

---

## Macro Engine Compatibility

In AFK Desk 0.11, Bedrock profiles can utilize Macro Engine v2 with edition-aware safety gates:

- **Supported triggers**: All 13 triggers work on Bedrock (`manual`, `join`, `worldChange`, `timer`, `schedule`, `chat`, `death`, `disconnected`, `healthBelow`, `hungerBelow`, `inventoryFull`, `inventoryChanged`, `windowOpen`).
- **Supported steps**: `wait`, `chat`, `notify`, `set`, `if`, `repeat`, `stop`, `look`, `control` (`sneak`, `jump`, `sprint`), `leftClick` (swing arm), `useGui` (server forms), `closeGui`, `waitForWindow`, `disconnect`, `reconnect`.
- **Gated steps**: Steps that attempt physical walking (`move`), slot moving (`useInventory`), item dropping (`drop`, `dropAll`), or container depositing (`deposit`) are skipped with a clear log warning when executed on a Bedrock account.

---

**Next:** [Security Model →](security.md)
