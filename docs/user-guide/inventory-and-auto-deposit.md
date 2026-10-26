# Inventory and Auto-Deposit

The **Inventory** panel displays your account's equipped gear, 27-slot main inventory, and 9-slot hotbar with vanilla item textures, stack counts, durability bars, enchantment glint (`✦`), lore indicators (`▤`), and hover tooltips.

![Inventory panel with item tooltip and slot locks](../images/inventory-panel.png)

## Inspecting and moving items

- **Hover tooltips**: Hover or focus any occupied slot to inspect its custom name, enchantments (with level and effect summary), formatted lore lines, remaining durability, and `minecraft:` item ID.
- **Select a slot**: Click an item slot to select it for toolbar actions.
- **Move or swap stacks**: Drag an item slot onto another slot to move or swap the stack.
- **Hold in main hand**: Select an item and click **Hold** to move or select it in your active hotbar hand. On the grid, the active hotbar slot is marked with `▲`.
- **Equip armor or off-hand**: Select an item, choose **Auto gear slot** (or `Head`, `Chest`, `Legs`, `Feet`, `Off-hand`), and click **Equip**.

## Item locks (protecting gear and keys)

Locked slots are protected from accidental drops, manual deposits, and automatic chest deposits.

1. Click the inventory or hotbar slot you want to protect (such as a sword, pickaxe, or crate key).
2. Click **Lock** in the inventory toolbar.
3. A `◆` badge and gold border appear on the slot, and the **Drop**, **Drop count**, and **Deposit** buttons are disabled while that slot is selected.
4. If you move or equip a locked item to another slot inside AFK Desk, its lock automatically moves with the item to the destination slot.
5. Click **Unlock** at any time to remove protection from the selected slot.

## Dropping items

- **Drop entire stack**: Select an unlocked slot and click **Drop**.
- **Drop specific count**: Select an unlocked slot, enter a quantity (`1`–`64`) in the count box, and click **Drop count**.

## Auto-Deposit into nearby containers

AFK Desk can automatically transfer unlocked inventory items into the closest visible chest, trapped chest, or barrel.

### Setting up Auto-Deposit

1. Position your account within range and line of sight of a chest, trapped chest, or barrel.
2. Check the **Connection** panel's **Closest container** field to confirm AFK Desk sees the container and its coordinates (for example, `Barrel at 125, 64, -38 (1 blocks)`).
3. Enable **Auto-deposit** using the checkbox in the inventory toolbar (or enable **Auto-deposit inventory** in the account editor).
4. To adjust the scan distance, open the account editor (**Edit**) and set **Auto-deposit search range (blocks)** between `1` and `16` blocks (default `5` blocks).

### How Auto-Deposit behaves

- **Line-of-sight filter**: Only containers with a clear line of sight within the configured block range are targeted.
- **Respects item locks**: Locked slots (`◆`) and equipped armor/off-hand slots are never deposited.
- **Manual single-slot deposit**: To deposit a single stack without enabling continuous auto-deposit, select an unlocked slot, set the item count (`1`–`64`), and click **Deposit**.
- **Immediate cancellation**: Unchecking **Auto-deposit** immediately cancels remaining queued transfers and closes the active container window.

---

**Next:** [POV View and Server Menus →](pov-and-server-menus.md)
