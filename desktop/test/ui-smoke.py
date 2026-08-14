from pathlib import Path
from tempfile import gettempdir
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
URL = (ROOT / "src" / "index.html").as_uri()
STUB = r"""
window.__sent = [];
window.__controls = [];
window.__windowClicks = [];
window.__inventoryMoves = [];
window.__equips = [];
window.__scale = 100;
window.__settings = { startWithWindows: false, staggerStartupConnections: true, startupConnectionDelay: 3, uiScale: 100, sidePanelWidth: 300, inventoryHeight: 220, macros: [{ label: 'Town', message: '/server towny' }] };
window.afkDesk = {
  listAccounts: async () => [{ id: 'one', label: 'TestPlayer', username: 'test@example.com', host: 'play.example.com', port: 25565, antiAfk: true, environmentalMovement: true }],
  getSettings: async () => ({ ...window.__settings }),
  getAppVersion: async () => '0.7.0-test',
  saveSettings: async (input) => (window.__settings = { ...window.__settings, ...input }),
  setUiScale: (value) => { window.__scale = value; },
  onBotEvent: (callback) => { window.__botEvent = callback; setTimeout(() => callback({ type: 'status', id: 'one', payload: { status: 'online', detail: 'Ready', at: Date.now() } }), 0); return () => {}; },
  sendChat: async (_id, message) => { window.__sent.push(message); },
  reorderAccounts: async () => [], control: async () => {}, setControlState: async (_id, control, active) => { window.__controls.push([control, active]); }, look: async () => {},
  connect: async () => {}, disconnect: async () => {}, dropStack: async () => {}, setItemLock: async (_id, slot, locked) => ({ lockedInventorySlots: locked ? [slot] : [] }), setAutoDeposit: async () => {},
  moveInventorySlot: async (_id, sourceSlot, destinationSlot) => { window.__inventoryMoves.push([sourceSlot, destinationSlot]); return { account: {}, sourceSlot, targetSlot: destinationSlot }; },
  equipInventoryItem: async (_id, slot, destination) => { window.__equips.push([slot, destination]); return { account: {}, sourceSlot: slot, targetSlot: slot, destination: destination === 'auto' ? 'head' : destination }; },
  clickWindowSlot: async (_id, slot) => { window.__windowClicks.push(slot); }, closeServerWindow: async () => { window.__botEvent({ type: 'window', id: 'one', payload: { open: false } }); },
  saveAccount: async (value) => value, deleteAccount: async () => {},
  openExternal: async () => {}, openIsolatedLogin: async () => {}
};
"""


def run() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1366, "height": 768})
        page.add_init_script(STUB)
        page.goto(URL, wait_until="domcontentloaded")
        page.locator("#dashboard:not([hidden])").wait_for()
        page.locator("body").click(position={"x": 500, "y": 100})
        page.keyboard.down("w")
        page.keyboard.up("w")
        jump = page.locator('[data-control="jump"]')
        jump.hover()
        page.mouse.down()
        page.mouse.up()
        assert page.evaluate("window.__controls") == [["forward", True], ["forward", False], ["jump", True], ["jump", False]]
        page.locator("#chat-message").fill("hello history")
        page.locator("#chat-message").press("Enter")
        page.locator("#chat-message").press("ArrowUp")
        assert page.locator("#chat-message").input_value() == "hello history"
        page.get_by_role("button", name="Town").click()
        assert page.evaluate("window.__sent") == ["hello history", "/server towny"]
        page.locator("#manage-macros").click()
        page.locator("#add-macro").click()
        rows = page.locator(".macro-row")
        rows.nth(1).locator(".macro-label-input").fill("Home")
        rows.nth(1).locator(".macro-message-input").fill("/home")
        page.locator("#save-macros").click()
        page.get_by_role("button", name="Home").wait_for()
        page.locator("#open-settings").click()
        page.locator("#ui-scale").fill("90")
        assert page.evaluate("window.__scale") == 90
        page.locator("#close-settings").click()
        assert page.evaluate("window.__scale") == 100
        handle = page.locator("#column-resizer")
        box = handle.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] - 50, box["y"])
        page.mouse.up()
        assert page.evaluate("window.__settings.sidePanelWidth > 300")
        handle = page.locator("#inventory-resizer")
        box = handle.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"], box["y"] - 30)
        page.mouse.up()
        assert page.evaluate("window.__settings.inventoryHeight > 220")
        assert page.locator("#app-version").inner_text() == "v0.7.0-test"
        column = page.locator("#column-resizer").bounding_box()
        page.mouse.move(column["x"] + column["width"] / 2, column["y"] + column["height"] / 2)
        page.mouse.down()
        page.mouse.move(column["x"] + 400, column["y"])
        page.mouse.up()
        assert page.evaluate("getComputedStyle(document.querySelector('.details-list')).gridTemplateColumns.split(' ').length <= 2")
        assert page.evaluate("getComputedStyle(document.querySelector('.movement-actions')).gridTemplateColumns.split(' ').length <= 2")
        inventory = page.locator("#inventory-resizer").bounding_box()
        page.mouse.move(inventory["x"] + inventory["width"] / 2, inventory["y"] + inventory["height"] / 2)
        page.mouse.down()
        page.mouse.move(inventory["x"], inventory["y"] + 500)
        page.mouse.up()
        inventory_fit = page.evaluate("({ panel: document.querySelector('.inventory-panel').offsetHeight, header: document.querySelector('.inventory-header').scrollHeight, setting: window.__settings.inventoryHeight })")
        assert inventory_fit["panel"] >= 150, inventory_fit
        assert inventory_fit["header"] <= 72, inventory_fit
        assert page.locator(".console-panel").bounding_box()["height"] >= 260
        normal_chat_height = page.locator(".console-panel").bounding_box()["height"]
        page.locator("#focus-chat").click()
        assert page.locator(".inventory-panel").bounding_box()["height"] <= 60
        assert page.locator(".console-panel").bounding_box()["height"] > normal_chat_height
        page.locator("#focus-chat").click()
        assert page.evaluate("document.body.scrollHeight <= innerHeight")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert page.locator("#macro-pad").is_visible()
        page.evaluate("window.__botEvent({ type: 'telemetry', id: 'one', payload: { health: 20, food: 20, selectedHotbarSlot: 0, position: {x: 1, y: 64, z: 2}, dimension: 'overworld', nearestChest: { type: 'barrel', x: 2, y: 64, z: 2, distance: 1 }, inventory: [{ slot: 5, slotType: 'helmet', name: 'diamond_helmet', displayName: 'Diamond Helmet', count: 1, durability: { remaining: 350, maximum: 363, percent: 96 } }, { slot: 36, slotType: 'inventory', name: 'diamond_sword', displayName: 'Diamond Sword', customName: 'Town Blade', lore: ['Bound to town', 'Soulbound'], loreSegments: [[{text: 'Bound ', color: '#ffaa00'}, {text: 'to town', color: '#ffaa00'}], [{text: 'Soulbound', color: '#aa00aa'}]], enchants: [{name: 'sharpness', level: 5}], count: 1, durability: { remaining: 1500, maximum: 1561, percent: 96 } }] } })")
        helmet = page.locator('.minecraft-slot[aria-label^="Diamond Helmet"]')
        helmet.hover()
        assert "Durability: 350 / 363" in page.locator("#item-tooltip").inner_text()
        assert "minecraft:diamond_helmet" in page.locator("#item-tooltip").inner_text()
        assert "minecraft-items.png" in helmet.locator(".minecraft-item-icon").evaluate("element => getComputedStyle(element).backgroundImage")
        sword = page.locator('.minecraft-slot[aria-label^="Town Blade"]')
        assert sword.locator(".minecraft-enchanted").count() == 1
        assert sword.locator(".minecraft-lore").count() == 1
        sword.hover()
        tooltip = page.locator("#item-tooltip").inner_text()
        assert "Sharpness V" in tooltip and "Bound to town" in tooltip, tooltip
        assert "Increases melee damage by 3" in tooltip and "Level 5 of 5" in tooltip, tooltip
        assert "LORE" in tooltip and "Soulbound" in tooltip, tooltip
        assert page.locator("#item-tooltip .lore span").first.evaluate("element => getComputedStyle(element).color") == "rgb(255, 170, 0)"
        sword.click()
        page.locator("#hold-selected").click()
        assert page.evaluate("window.__equips") == [[36, "hand"]]
        page.locator("#move-selected").click()
        page.locator('.minecraft-slot[data-slot="37"]').click()
        assert page.evaluate("window.__inventoryMoves") == [[36, 37]]
        sword.click()
        page.locator("#lock-selected").click()
        assert "locked" in sword.get_attribute("class")
        assert page.locator("#drop-selected").is_disabled()
        page.evaluate("window.__botEvent({ type: 'window', id: 'one', payload: { open: true, title: 'Town Menu', size: 9, slots: [{ slot: 0, name: 'emerald', displayName: 'Join Town', count: 1 }] } })")
        page.locator("#server-window-dialog").wait_for(state="visible")
        menu_item = page.get_by_role("button", name="Join Town")
        menu_item.hover()
        assert page.evaluate("document.querySelector('#item-tooltip').parentElement.id") == "server-window-dialog"
        assert page.locator("#item-tooltip").is_visible()
        menu_item.click()
        assert page.evaluate("window.__windowClicks") == [0]
        page.locator("#close-server-window").click()
        page.locator("#server-window-dialog").wait_for(state="hidden")
        desktop = str(Path(gettempdir()) / "afkdesk-ui-desktop.png")
        page.screenshot(path=desktop)

        compact = browser.new_page(viewport={"width": 860, "height": 600})
        compact.add_init_script(STUB)
        compact.goto(URL, wait_until="domcontentloaded")
        compact.locator("#dashboard:not([hidden])").wait_for()
        assert compact.locator("#inventory-resizer").is_visible()
        before_height = compact.locator(".inventory-panel").bounding_box()["height"]
        compact_handle = compact.locator("#inventory-resizer").bounding_box()
        compact.mouse.move(compact_handle["x"] + compact_handle["width"] / 2, compact_handle["y"] + compact_handle["height"] / 2)
        compact.mouse.down()
        compact.mouse.move(compact_handle["x"], compact_handle["y"] + 70)
        compact.mouse.up()
        after_height = compact.locator(".inventory-panel").bounding_box()["height"]
        assert after_height < before_height, (before_height, after_height)
        assert compact.locator(".console-panel").bounding_box()["height"] >= 120
        assert compact.evaluate("document.body.scrollHeight <= innerHeight")
        compact_path = str(Path(gettempdir()) / "afkdesk-ui-compact.png")
        compact.screenshot(path=compact_path)

        narrow = browser.new_page(viewport={"width": 700, "height": 800})
        narrow.add_init_script(STUB)
        narrow.goto(URL, wait_until="domcontentloaded")
        narrow.locator("#dashboard:not([hidden])").wait_for()
        assert narrow.evaluate("document.documentElement.scrollWidth <= innerWidth")
        narrow_path = str(Path(gettempdir()) / "afkdesk-ui-narrow.png")
        narrow.screenshot(path=narrow_path, full_page=True)
        browser.close()
        print(desktop)
        print(compact_path)
        print(narrow_path)


if __name__ == "__main__":
    run()
