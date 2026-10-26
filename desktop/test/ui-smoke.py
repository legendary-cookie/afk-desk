from pathlib import Path
from tempfile import gettempdir
import base64
import os
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
URL = (ROOT / "src" / "index.html").as_uri()
STUB = r"""
window.__sent = [];
window.__controls = [];
window.__windowClicks = [];
window.__inventoryMoves = [];
window.__equips = [];
window.__worldActions = [];
window.__lookDeltas = [];
window.__world = { position: { x: .5, y: 64, z: 2.5 }, yaw: 0, pitch: -.16, radius: 9, blockRevision: 1, blocks: [], entities: [], health: 20, food: 18, quickBarSlot: 0, heldItem: { name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 } };
for (let x = -8; x <= 8; x++) for (let z = -9; z <= 4; z++) window.__world.blocks.push({ x, y: 63, z, name: x > 4 ? 'water' : 'grass_block', solid: x <= 4, water: x > 4 });
for (let y = 64; y < 68; y++) window.__world.blocks.push({ x: -3, y, z: -3, name: 'oak_log', solid: true });
for (let x = -4; x <= -2; x++) for (let z = -4; z <= -2; z++) window.__world.blocks.push({ x, y: 68, z, name: 'oak_leaves', solid: true });
for (let x = 1; x <= 4; x++) for (let y = 64; y <= 66; y++) window.__world.blocks.push({ x, y, z: -5, name: x === 2 && y === 65 ? 'glass' : y === 64 ? 'stone' : 'oak_planks', solid: true });
window.__world.blocks.push({ x: 0, y: 64, z: -2, name: 'stone_slab', solid: true, shapes: [[0, 0, 0, 1, .5, 1]] }, { x: -1, y: 64, z: -5, name: 'diamond_ore', solid: true });
window.__savedAccount = null;
window.__scale = 100;
window.__settings = { startWithWindows: false, staggerStartupConnections: true, startupConnectionDelay: 3, uiScale: 100, sidePanelWidth: 300, inventoryHeight: 220, macros: [{ label: 'Town', message: '/server towny' }] };
window.__macroRunListeners = [];
window.__macros = [
  {
    id: 'macro-seed-1',
    name: 'Auto-eat when hunger < 14',
    enabled: true,
    targets: { mode: 'all' },
    trigger: { type: 'hungerBelow', below: 14, cooldownMs: 5000 },
    stopWhen: [{ type: 'online' }],
    concurrency: 'skip',
    onError: 'continue',
    defaultDelayMs: 250,
    maxRuntimeMs: 60000,
    steps: [
      { type: 'holdItem', name: 'cooked_beef' },
      { type: 'repeat', count: 2, steps: [{ type: 'wait', ms: 900 }] }
    ]
  },
  {
    id: 'macro-seed-invalid',
    name: 'Broken regex chat trigger',
    enabled: false,
    targets: { mode: 'accounts', accountIds: ['one'] },
    trigger: { type: 'chat', match: 'regex', pattern: '[unclosed', sources: ['player'] },
    stopWhen: [],
    concurrency: 'skip',
    onError: 'stop',
    defaultDelayMs: 0,
    maxRuntimeMs: null,
    steps: [{ type: 'chat', message: '/ping' }]
  }
];
window.__macroValidation = {
  'macro-seed-invalid': [{ path: 'trigger.pattern', message: 'Invalid regular expression in chat trigger.' }]
};
window.__macroRuns = [
  {
    runId: 'run-101',
    macroId: 'macro-seed-1',
    accountId: 'one',
    status: 'completed',
    trigger: 'hungerBelow',
    startedAt: Date.now() - 42000,
    endedAt: Date.now() - 40150,
    steps: [{ path: [0], type: 'holdItem', ok: true }]
  },
  {
    runId: 'run-102',
    macroId: 'macro-seed-1',
    accountId: 'one',
    status: 'failed',
    reason: 'Step error',
    trigger: 'manual',
    startedAt: Date.now() - 15000,
    endedAt: Date.now() - 14580,
    steps: [{ path: [0], type: 'holdItem', ok: false, error: 'Item cooked_beef not found in inventory' }]
  }
];
window.__notifyChannels = [];
window.__notifyTests = [];
window.afkDesk = {
  listAccounts: async () => [{ id: 'one', label: 'TestPlayer', username: 'test@example.com', host: 'play.example.com', port: 25565, edition: 'java', tags: ['lobby', 'farm'], antiAfk: true, environmentalMovement: true }],
  getSettings: async () => ({ ...window.__settings }),
  getAppVersion: async () => '0.10.0-beta.7-test',
  getSupportedVersions: async () => ['1.8.8', '1.21.11'],
  getWorldSnapshot: async () => window.__world,
  worldAction: async (id, action, target) => { window.__worldActions.push({ id, action, target }); if (action === 'select-hotbar') window.__world.quickBarSlot = target.slot; },
  lookDelta: async (id, yaw, pitch) => { window.__lookDeltas.push({ id, yaw, pitch }); },
  listLogs: async () => [], clearLogs: async () => {}, getProxyHealth: async () => [],
  runAutomation: async () => {}, stopAutomation: async () => {},
  completeChat: async () => [], duplicateProfile: async () => ({}),
  dropItems: async () => {}, depositSlot: async () => {},
  saveSettings: async (input) => (window.__settings = { ...window.__settings, ...input }),
  setUiScale: (value) => { window.__scale = value; },
  onBotEvent: (callback) => { window.__botEvent = callback; setTimeout(() => { callback({ type: 'status', id: 'one', payload: { status: 'online', detail: 'Ready', at: Date.now() } }); callback({ type: 'telemetry', id: 'one', payload: { health: 20, food: 18, selectedHotbarSlot: 0, inventory: [{ slot: 36, name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 }, { slot: 37, name: 'oak_planks', displayName: 'Oak Planks', count: 32 }] } }); }, 0); return () => {}; },
  sendChat: async (_id, message) => { window.__sent.push(message); },
  reorderAccounts: async () => [], control: async () => {}, setControlState: async (_id, control, active) => { window.__controls.push([control, active]); }, look: async () => {},
  connect: async () => {}, disconnect: async () => {}, dropStack: async () => {}, setItemLock: async (_id, slot, locked) => ({ lockedInventorySlots: locked ? [slot] : [] }), setAutoDeposit: async () => {},
  moveInventorySlot: async (_id, sourceSlot, destinationSlot) => { window.__inventoryMoves.push([sourceSlot, destinationSlot]); return { account: {}, sourceSlot, targetSlot: destinationSlot }; },
  equipInventoryItem: async (_id, slot, destination) => { window.__equips.push([slot, destination]); return { account: {}, sourceSlot: slot, targetSlot: slot, destination: destination === 'auto' ? 'head' : destination }; },
  clickWindowSlot: async (_id, slot) => { window.__windowClicks.push(slot); }, closeServerWindow: async () => { window.__botEvent({ type: 'window', id: 'one', payload: { open: false } }); },
  saveAccount: async (value) => (window.__savedAccount = value), deleteAccount: async () => {},
  openExternal: async () => {}, openIsolatedLogin: async () => {},
  macros: {
    list: async () => ({ macros: structuredClone(window.__macros), validation: structuredClone(window.__macroValidation) }),
    save: async (macro) => {
      if (!macro || !macro.name || !macro.name.trim()) {
        const err = new Error('/name: Macro name is required.');
        err.validation = [{ path: '/name', message: 'Macro name is required.' }];
        throw err;
      }
      if (!Array.isArray(macro.steps) || macro.steps.length === 0) {
        const err = new Error('/steps: Add at least one step.');
        err.validation = [{ path: '/steps', message: 'Add at least one step.' }];
        throw err;
      }
      const saved = structuredClone({ ...macro, id: macro.id || ('macro-' + (window.__macros.length + 1)) });
      const idx = window.__macros.findIndex((m) => m.id === saved.id);
      if (idx === -1) window.__macros.push(saved);
      else window.__macros[idx] = saved;
      delete window.__macroValidation[saved.id];
      return saved;
    },
    remove: async (macroId) => {
      window.__macros = window.__macros.filter((m) => m.id !== macroId);
      delete window.__macroValidation[macroId];
      return true;
    },
    setEnabled: async (macroId, enabled) => {
      if (window.__macroValidation[macroId]?.length && enabled) {
        throw new Error('Cannot enable macro with validation errors.');
      }
      const item = window.__macros.find((m) => m.id === macroId);
      if (item) item.enabled = Boolean(enabled);
      return structuredClone(item);
    },
    run: async (accountId, macroId) => {
      const runId = 'run-live-' + Date.now();
      const evtStep = { status: 'step', runId, macroId, accountId, stepPath: [0], stepType: 'repeat' };
      window.__macroRunListeners.forEach((fn) => fn(evtStep));
      window.__macroRuns.push({
        runId,
        macroId,
        accountId,
        status: 'completed',
        trigger: 'manual',
        startedAt: Date.now() - 1200,
        endedAt: Date.now(),
        steps: [{ path: [0], type: 'repeat', ok: true }]
      });
      return { status: 'started', runId };
    },
    stop: async (accountId) => {
      const evtStop = { status: 'stopped', reason: 'Stopped by user', accountId };
      window.__macroRunListeners.forEach((fn) => fn(evtStop));
      return true;
    },
    runs: async (macroId) => window.__macroRuns.filter((r) => !macroId || r.macroId === macroId),
    importJson: async (raw) => {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const imported = arr.map((m, idx) => ({ ...m, id: m.id || ('imported-' + idx) }));
      window.__macros.push(...imported);
      return { macros: imported, errors: [] };
    },
    exportJson: async (ids) => {
      const list = Array.isArray(ids) && ids.length ? window.__macros.filter((m) => ids.includes(m.id)) : window.__macros;
      return JSON.stringify(list, null, 2);
    }
  },
  onMacroRun: (callback) => {
    window.__macroRunListeners.push(callback);
    return () => {
      window.__macroRunListeners = window.__macroRunListeners.filter((fn) => fn !== callback);
    };
  },
  notify: {
    list: async () => structuredClone(window.__notifyChannels),
    save: async (payload) => {
      const existing = window.__notifyChannels.find((c) => c.id === payload.id);
      const rawSecret = payload.type === 'discord' ? payload.webhookUrl : payload.botToken;
      const secretHint = rawSecret ? ('••••' + String(rawSecret).slice(-4)) : (existing?.secretHint || '••••1234');
      const saved = {
        id: existing?.id || ('chan-' + (window.__notifyChannels.length + 1)),
        type: payload.type || 'discord',
        name: payload.name,
        enabled: payload.enabled !== false,
        events: payload.events || [],
        accountIds: payload.accountIds ?? null,
        includeTimestamp: payload.includeTimestamp === true,
        chatId: payload.chatId || existing?.chatId || '',
        hasSecret: true,
        secretHint
      };
      const idx = window.__notifyChannels.findIndex((c) => c.id === saved.id);
      if (idx === -1) window.__notifyChannels.push(saved);
      else window.__notifyChannels[idx] = saved;
      return structuredClone(saved);
    },
    delete: async (id) => {
      window.__notifyChannels = window.__notifyChannels.filter((c) => c.id !== id);
      return { ok: true };
    },
    test: async (id) => {
      window.__notifyTests.push(id);
      return { ok: true };
    }
  }
};
"""


def run() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('AFK_DESK_TEST_BROWSER') or None)
        errors = []
        page = browser.new_page(viewport={"width": 1366, "height": 768})
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(STUB)
        page.goto(URL, wait_until="networkidle")
        page.locator("#dashboard:not([hidden])").wait_for()
        page.locator("body").click(position={"x": 500, "y": 100})
        page.keyboard.down("w")
        page.keyboard.up("w")
        assert not page.locator('[data-control="jump"]').is_visible()
        page.locator('[data-collapse-target="movement-panel"]').click()
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
        page.locator("#macro-menu-trigger").click()
        page.locator("#manage-macros").click()
        page.locator("#macro-dialog").wait_for(state="visible")
        page.locator("#add-macro").click()
        rows = page.locator(".macro-row")
        rows.nth(1).locator(".macro-label-input").fill("Home")
        rows.nth(1).locator(".macro-message-input").fill("/home")
        page.locator("#save-macros").click()
        page.locator("#macro-dialog").wait_for(state="hidden")
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
        assert page.locator("#app-version").inner_text() == "v0.10.0-beta.7-test"
        page.locator("#display-menu-trigger").click()
        page.locator("#quick-scale").fill("105")
        assert page.evaluate("window.__scale") == 105
        assert page.locator("#quick-scale-value").inner_text() == "105%"
        page.locator("#display-menu-trigger").click()
        page.locator("#reset-scale").click()
        assert page.evaluate("window.__scale") == 100
        page.locator("#display-menu-trigger").click()
        number_scale = page.locator("#quick-scale-number")
        number_scale.fill("")
        number_scale.type("9")
        assert number_scale.input_value() == "9"
        assert page.evaluate("window.__scale") == 100
        number_scale.type("3")
        number_scale.press("Enter")
        assert page.evaluate("window.__scale") == 93
        assert page.locator("#quick-scale-value").inner_text() == "93%"
        sidebar_width = page.locator(".sidebar").bounding_box()["width"]
        page.locator("#toggle-sidebar").click()
        page.wait_for_timeout(220)
        assert page.locator(".sidebar").bounding_box()["width"] < sidebar_width
        page.locator("#toggle-sidebar").click()
        page.wait_for_timeout(220)
        page.locator('[data-collapse-target="details-panel"]').click()
        assert not page.locator(".details-list").is_visible()
        page.locator('[data-collapse-target="details-panel"]').click()
        page.locator('[data-collapse-target="macro-section"]').click()
        assert not page.locator("#macro-pad").is_visible()
        page.locator('[data-collapse-target="macro-section"]').click()
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
        assert page.locator("#focus-chat").count() == 0
        assert page.locator("#move-selected").count() == 0
        page.locator("#toggle-inventory").click()
        assert page.locator(".inventory-panel").bounding_box()["height"] <= 60
        assert page.locator(".console-panel").bounding_box()["height"] > normal_chat_height
        page.locator("#toggle-inventory").click()
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
        sword.drag_to(page.locator('.minecraft-slot[data-slot="37"]'))
        assert page.evaluate("window.__inventoryMoves") == [[36, 37]]
        sword.click()
        page.locator("#lock-selected").click()
        assert "locked" in sword.get_attribute("class")
        assert page.locator("#drop-selected").is_disabled()
        pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XfSUWQAAAABJRU5ErkJggg=="
        container_svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect x="38" y="0" width="176" height="227" fill="white"/></svg>'
        container_art = "data:image/svg+xml;base64," + base64.b64encode(container_svg.encode()).decode()
        page.evaluate("([pixel, art]) => window.__botEvent({ type: 'window', id: 'one', payload: { open: true, title: 'Town Menu', resourceTitle: { text: 'Town Menu', glyphs: [{ character: 'T', image: art, sourceX: 0, sourceY: 0, sourceWidth: 256, sourceHeight: 256, renderHeight: 256, ascent: 19, advance: 256 }] }, size: 54, slots: [{ slot: 0, name: 'emerald', displayName: 'Join Town', count: 1, resourceIcon: pixel, resourceModel: 'veridian:item/mission' }] } })", [pixel, container_art])
        page.locator("#server-window-dialog").wait_for(state="visible")
        page.locator("#server-window-art:not([hidden])").wait_for()
        menu_item = page.get_by_role("button", name="Join Town")
        stage_box = page.locator("#server-window-stage").bounding_box()
        grid_box = page.locator("#server-window-grid").bounding_box()
        slot_box = menu_item.bounding_box()
        assert round(stage_box["width"]) == 352 and round(stage_box["height"]) == 454, stage_box
        assert round(grid_box["x"] - stage_box["x"]) == 16 and round(grid_box["y"] - stage_box["y"]) == 36, (stage_box, grid_box)
        assert round(slot_box["width"]) == 32 and round(slot_box["height"]) == 32, slot_box
        assert menu_item.locator(".minecraft-item-icon.custom-resource").count() == 1
        menu_item.hover()
        assert page.evaluate("document.querySelector('#item-tooltip').parentElement.id") == "server-window-dialog"
        assert page.locator("#item-tooltip").is_visible()
        menu_item.click()
        assert page.evaluate("window.__windowClicks") == [0]
        page.locator("#close-server-window").click()
        page.locator("#server-window-dialog").wait_for(state="hidden")
        page.locator("#display-menu-trigger").click()
        assert page.locator("#quick-scale-number").is_visible()
        page.locator("#display-menu-trigger").click()
        page.locator("#edit-account").click()
        assert page.locator("#auto-deposit-range").input_value() == "5"
        page.locator("#auto-deposit-range").fill("9")
        page.locator("#save-account").click()
        page.locator("#account-dialog").wait_for(state="hidden")
        assert page.evaluate("window.__savedAccount.autoDepositRange") == 9
        page.locator("#display-menu-trigger").click()
        desktop = str(Path(gettempdir()) / "afkdesk-ui-desktop.png")
        page.screenshot(path=desktop)
        page.locator("#display-menu-trigger").click()

        # Stage 3 Flow A/B/C: Macro Library, Editor (join -> chat, repeat with wait inside, keyboard reorder, save), Live run & Runs tab
        page.locator("#open-automations").click()
        page.locator("#automation-dialog").wait_for(state="visible")
        assert page.locator(".macro-library-item").count() == 2
        assert page.locator(".macro-library-item.has-errors input[type='checkbox']").is_disabled()
        macro_lib_1366 = str(Path(gettempdir()) / "afkdesk-macro-library-1366.png")
        page.screenshot(path=macro_lib_1366)

        page.locator("#macro-new-btn").click()
        page.locator("#macro-name-input").fill("Join Lobby & Loop")
        page.locator("#macro-trigger-type").select_option("join")
        step0 = page.locator('.macro-step-card[data-step-path="[0]"]')
        step0.locator(".macro-step-type-select").select_option("chat")
        step0.locator(".step-chat-message").fill("/lobby")

        # Add a repeat step via step picker
        page.locator("#macro-open-step-picker").click()
        page.locator('#macro-step-picker [data-step-type="repeat"]').click()
        step1 = page.locator('.macro-step-card[data-step-path="[1]"]')
        step1.wait_for()
        # Add a second wait step inside the repeat block via the nested step selector
        step1.locator(".step-add-nested-select").select_option("wait")
        assert page.locator('.macro-step-card[data-step-path="[1,0]"]').count() == 1
        assert page.locator('.macro-step-card[data-step-path="[1,1]"]').count() == 1

        # Reorder via keyboard (Alt+ArrowUp moves selected step [1] up to [0])
        step1.focus()
        page.keyboard.press("Alt+ArrowUp")
        assert page.locator('.macro-step-card[data-step-path="[0]"] > .macro-step-header .macro-step-type-select').input_value() == "repeat"
        assert page.locator('.macro-step-card[data-step-path="[1]"] > .macro-step-header .macro-step-type-select').input_value() == "chat"

        # Save via keyboard Ctrl+Enter and verify it is listed in the library
        page.keyboard.press("Control+Enter")
        page.locator(".macro-library-item", has_text="Join Lobby & Loop").wait_for()
        assert page.locator(".macro-library-item").count() == 3

        # Trigger live run so step [0] highlights, then take editor screenshot at 1366x768
        page.locator("#macro-run-now").click()
        page.locator(".macro-step-card.live-running").wait_for()
        page.locator("#macro-steps-card").scroll_into_view_if_needed()
        macro_editor_1366 = str(Path(gettempdir()) / "afkdesk-macro-editor-1366.png")
        page.screenshot(path=macro_editor_1366)

        # Open Runs tab and take screenshot at 1366x768
        page.locator(".macro-library-item", has_text="Auto-eat when hunger < 14").click()
        page.locator("#macro-tab-runs").click()
        page.locator(".macro-run-record").first.wait_for()
        assert "Item cooked_beef not found in inventory" in page.locator("#macro-runs-list").inner_text()
        macro_runs_1366 = str(Path(gettempdir()) / "afkdesk-macro-runs-1366.png")
        page.screenshot(path=macro_runs_1366)
        page.locator("#close-automation").click()
        page.locator("#automation-dialog").wait_for(state="hidden")

        # Stage 3 Flow D: Notifications panel inside Settings -> add Discord channel -> Send test -> toast
        page.locator("#open-settings").click()
        page.locator("#settings-dialog").wait_for(state="visible")
        page.locator("#notifications-panel").scroll_into_view_if_needed()
        page.locator("#add-notification-channel").click()
        page.locator("#notification-channel-dialog").wait_for(state="visible")
        page.locator("#notify-channel-type").select_option("discord")
        page.locator("#notify-channel-name").fill("Ops Discord")
        page.locator("#notify-webhook-url").fill("https://discord.com/api/webhooks/123456/abcdef9876")
        page.locator("#save-notification-channel").click()
        page.locator("#notification-channel-dialog").wait_for(state="hidden")

        channel_row = page.locator(".notification-channel-row", has_text="Ops Discord")
        channel_row.wait_for()
        assert "•••• 9876" in channel_row.inner_text()
        channel_row.locator(".notify-test-btn").click()
        page.locator(".toast", has_text="Test notification sent to Ops Discord.").wait_for()

        # Verify secret is never echoed back on Edit
        channel_row.locator(".notify-edit-btn").click()
        page.locator("#notification-channel-dialog").wait_for(state="visible")
        assert page.locator("#notify-webhook-url").input_value() == ""
        assert page.locator("#notify-webhook-url").get_attribute("placeholder") == "•••• 9876 (unchanged)"
        page.locator("#cancel-notification-channel").click()
        page.locator("#notification-channel-dialog").wait_for(state="hidden")
        notifications_1366 = str(Path(gettempdir()) / "afkdesk-notifications-1366.png")
        page.screenshot(path=notifications_1366)
        page.locator("#close-settings").click()
        page.locator("#settings-dialog").wait_for(state="hidden")

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
        assert compact.evaluate("document.querySelector('.main-content').scrollHeight > document.querySelector('.main-content').clientHeight")
        compact.locator(".topbar").hover()
        compact.mouse.wheel(0, 400)
        compact.wait_for_timeout(200)
        assert compact.evaluate("document.querySelector('.main-content').scrollTop > 0")
        compact_path = str(Path(gettempdir()) / "afkdesk-ui-compact.png")
        compact.screenshot(path=compact_path)

        # Stage 3 screenshots at 860x600
        compact.locator("#open-automations").click()
        compact.locator("#automation-dialog").wait_for(state="visible")
        macro_lib_860 = str(Path(gettempdir()) / "afkdesk-macro-library-860.png")
        compact.screenshot(path=macro_lib_860)
        compact.locator("#macro-open-step-picker").click()
        compact.locator('#macro-step-picker [data-step-type="repeat"]').click()
        compact.locator('.macro-step-card[data-step-path="[2]"]').scroll_into_view_if_needed()
        macro_editor_860 = str(Path(gettempdir()) / "afkdesk-macro-editor-860.png")
        compact.screenshot(path=macro_editor_860)
        compact.locator("#macro-tab-runs").click()
        compact.locator(".macro-run-record").first.wait_for()
        macro_runs_860 = str(Path(gettempdir()) / "afkdesk-macro-runs-860.png")
        compact.screenshot(path=macro_runs_860)
        compact.locator("#close-automation").click()
        compact.locator("#automation-dialog").wait_for(state="hidden")

        compact.locator("#open-settings").click()
        compact.locator("#settings-dialog").wait_for(state="visible")
        compact.locator("#notifications-panel").scroll_into_view_if_needed()
        compact.locator("#add-notification-channel").click()
        compact.locator("#notify-channel-name").fill("Ops Discord")
        compact.locator("#notify-webhook-url").fill("https://discord.com/api/webhooks/123456/abcdef9876")
        compact.locator("#save-notification-channel").click()
        compact.locator("#notifications-panel").scroll_into_view_if_needed()
        notifications_860 = str(Path(gettempdir()) / "afkdesk-notifications-860.png")
        compact.screenshot(path=notifications_860)
        compact.locator("#close-settings").click()

        narrow = browser.new_page(viewport={"width": 700, "height": 800})
        narrow.add_init_script(STUB)
        narrow.goto(URL, wait_until="domcontentloaded")
        narrow.locator("#dashboard:not([hidden])").wait_for()
        assert narrow.evaluate("document.documentElement.scrollWidth <= innerWidth")
        narrow_path = str(Path(gettempdir()) / "afkdesk-ui-narrow.png")
        narrow.screenshot(path=narrow_path, full_page=True)

        pov = browser.new_page(viewport={"width": 1366, "height": 768})
        pov.set_default_timeout(10000)
        pov.on('pageerror', lambda error: errors.append(str(error)))
        pov.add_init_script(STUB)
        pov.goto(URL, wait_until="networkidle")
        pov.locator("#dashboard:not([hidden])").wait_for()
        pov.locator("#open-pov").click()
        pov.locator("#pov-dialog").wait_for(state="visible")
        pov.locator('#pov-grid canvas[data-position]').wait_for()
        assert pov.locator(".pov-card").count() == 1
        pov.locator("#pov-search").fill("no match")
        assert pov.locator("#pov-grid").inner_text() == "No profiles match this filter."
        pov.locator("#pov-search").fill("")
        pov.locator(".pov-expand").click()
        canvas = pov.locator("#pov-grid canvas")
        canvas.focus()
        pov.keyboard.down("w")
        pov.keyboard.up("w")
        assert pov.evaluate("window.__controls") == [["forward", True], ["forward", False]]
        pov.locator("#pov-x").fill("3")
        pov.locator("#pov-y").fill("64")
        pov.locator("#pov-z").fill("5")
        pov.locator('[data-world-action="look-at"]').click()
        assert pov.evaluate("window.__worldActions[0]") == {"id": "one", "action": "look-at", "target": {"x": 3, "y": 64, "z": 5, "range": 1}}
        canvas.focus()
        pov.keyboard.press("Digit2")
        pov.wait_for_function("window.__world.quickBarSlot === 1")
        canvas.hover()
        pov.mouse.wheel(0, 100)
        pov.wait_for_function("window.__world.quickBarSlot === 2")
        pov.locator("#pov-x").fill("19")
        assert pov.evaluate("window.__world.quickBarSlot") == 2
        canvas.click()
        pov.wait_for_function("document.pointerLockElement !== null")
        pov.mouse.down()
        pov.mouse.up()
        pov.mouse.down(button="right")
        pov.mouse.up(button="right")
        assert pov.evaluate("window.__worldActions.slice(-4).map(entry => entry.action)") == ["dig-crosshair", "stop-dig", "use-crosshair", "stop-use"]
        pov.evaluate("document.exitPointerLock()")
        canvas.focus()
        pov.keyboard.down("w")
        pov.locator("#pov-pause").click()
        assert pov.evaluate("window.__controls.slice(-1)") == [["forward", False]]
        pov.keyboard.up("w")
        pov.locator("#pov-pause").click()
        pov.locator("#pov-view-mode").select_option("map")
        assert pov.evaluate("window.__settings.povViewMode") == "map"
        pov.locator("#pov-pause").click()
        assert pov.locator("#pov-pause").inner_text() == "Resume"
        pov.locator("#pov-pause").click()
        assert pov.locator("#pov-pause").inner_text() == "Pause"
        pov.locator("#pov-view-mode").select_option("perspective")
        pov.locator('#pov-grid canvas[data-position]').wait_for()
        pov.locator("#pov-grid canvas").focus()
        pov.keyboard.press("Digit1")
        pov.wait_for_function("window.__world.quickBarSlot === 0")
        pov_path = str(Path(gettempdir()) / "afkdesk-ui-pov.png")
        pov.screenshot(path=pov_path)
        pov.locator("#pov-grid canvas").focus()
        pov.keyboard.press("KeyE")
        pov.locator("#pov-dialog").wait_for(state="hidden")
        assert not errors, errors
        browser.close()
        for p in [
            desktop,
            compact_path,
            narrow_path,
            pov_path,
            macro_lib_1366,
            macro_editor_1366,
            macro_runs_1366,
            notifications_1366,
            macro_lib_860,
            macro_editor_860,
            macro_runs_860,
            notifications_860,
        ]:
            print(p)


if __name__ == "__main__":
    run()
