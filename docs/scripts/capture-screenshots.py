from pathlib import Path
import os
import re
from PIL import Image
from playwright.sync_api import sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_ROOT = REPO_ROOT / "desktop"
INDEX_URL = (DESKTOP_ROOT / "src" / "index.html").as_uri()
OUTPUT_DIR = REPO_ROOT / "docs" / "images"
MAX_BYTES = 400 * 1024

STUB = r"""
window.__sent = [];
window.__controls = [];
window.__windowClicks = [];
window.__inventoryMoves = [];
window.__equips = [];
window.__worldActions = [];
window.__lookDeltas = [];
window.__world = {
  position: { x: 0.5, y: 64, z: 2.5 },
  yaw: 0,
  pitch: -0.16,
  radius: 9,
  blockRevision: 1,
  blocks: [],
  entities: [
    { type: 'player', username: 'AlexBot', x: 2.5, y: 64, z: -2.5 }
  ],
  health: 20,
  food: 18,
  quickBarSlot: 0,
  heldItem: { name: 'diamond_sword', displayName: 'Diamond Sword', customName: 'Town Blade', count: 1 }
};
for (let x = -8; x <= 8; x++) {
  for (let z = -9; z <= 4; z++) {
    window.__world.blocks.push({
      x,
      y: 63,
      z,
      name: x > 4 ? 'water' : 'grass_block',
      solid: x <= 4,
      water: x > 4
    });
  }
}
for (let y = 64; y < 68; y++) {
  window.__world.blocks.push({ x: -3, y, z: -3, name: 'oak_log', solid: true });
}
for (let x = -4; x <= -2; x++) {
  for (let z = -4; z <= -2; z++) {
    window.__world.blocks.push({ x, y: 68, z, name: 'oak_leaves', solid: true });
  }
}
for (let x = 1; x <= 4; x++) {
  for (let y = 64; y <= 66; y++) {
    window.__world.blocks.push({
      x,
      y,
      z: -5,
      name: x === 2 && y === 65 ? 'glass' : y === 64 ? 'stone' : 'oak_planks',
      solid: true
    });
  }
}
window.__world.blocks.push(
  { x: 0, y: 64, z: -2, name: 'stone_slab', solid: true, shapes: [[0, 0, 0, 1, 0.5, 1]] },
  { x: -1, y: 64, z: -5, name: 'diamond_ore', solid: true }
);

window.__scale = 100;
window.__settings = {
  startWithWindows: false,
  notificationsEnabled: true,
  staggerStartupConnections: true,
  startupConnectionDelay: 3,
  uiScale: 100,
  workspaceDesign: 'hybrid',
  colorTheme: 'obsidian',
  sidePanelWidth: 300,
  inventoryHeight: 230,
  povRefreshMs: 1500,
  povFrameRate: 30,
  povRadius: 6,
  povColumns: 3,
  povMaxFeeds: 9,
  povViewMode: 'perspective',
  povShowHud: true,
  macros: [
    { label: 'Town', message: '/server towny' },
    { label: 'Spawn', message: '/spawn' },
    { label: 'AFK', message: '/afk' }
  ]
};

const baseInventory = [
  {
    slot: 5,
    slotType: 'helmet',
    name: 'diamond_helmet',
    displayName: 'Diamond Helmet',
    count: 1,
    enchants: [{ name: 'protection', level: 4 }, { name: 'unbreaking', level: 3 }],
    durability: { remaining: 350, maximum: 363, percent: 96 }
  },
  {
    slot: 6,
    slotType: 'chestplate',
    name: 'iron_chestplate',
    displayName: 'Iron Chestplate',
    count: 1,
    durability: { remaining: 210, maximum: 240, percent: 88 }
  },
  {
    slot: 45,
    slotType: 'off-hand',
    name: 'shield',
    displayName: 'Shield',
    count: 1,
    durability: { remaining: 312, maximum: 336, percent: 93 }
  },
  {
    slot: 9,
    slotType: 'inventory',
    name: 'cobblestone',
    displayName: 'Cobblestone',
    count: 64
  },
  {
    slot: 10,
    slotType: 'inventory',
    name: 'oak_log',
    displayName: 'Oak Log',
    count: 48
  },
  {
    slot: 11,
    slotType: 'inventory',
    name: 'iron_ingot',
    displayName: 'Iron Ingot',
    count: 24
  },
  {
    slot: 12,
    slotType: 'inventory',
    name: 'redstone',
    displayName: 'Redstone Dust',
    count: 64
  },
  {
    slot: 36,
    slotType: 'inventory',
    name: 'diamond_sword',
    displayName: 'Diamond Sword',
    customName: 'Town Blade',
    lore: ['Bound to town', 'Protected gear'],
    loreSegments: [
      [{ text: 'Bound to town', color: '#ffaa00' }],
      [{ text: 'Protected gear', color: '#55ffff' }]
    ],
    enchants: [{ name: 'sharpness', level: 5 }, { name: 'unbreaking', level: 3 }],
    count: 1,
    durability: { remaining: 1500, maximum: 1561, percent: 96 }
  },
  {
    slot: 37,
    slotType: 'inventory',
    name: 'diamond_pickaxe',
    displayName: 'Diamond Pickaxe',
    enchants: [{ name: 'efficiency', level: 5 }, { name: 'fortune', level: 3 }],
    count: 1,
    durability: { remaining: 1420, maximum: 1561, percent: 91 }
  },
  {
    slot: 38,
    slotType: 'inventory',
    name: 'golden_carrot',
    displayName: 'Golden Carrot',
    count: 42
  },
  {
    slot: 39,
    slotType: 'inventory',
    name: 'oak_planks',
    displayName: 'Oak Planks',
    count: 32
  },
  {
    slot: 40,
    slotType: 'inventory',
    name: 'torch',
    displayName: 'Torch',
    count: 64
  }
];

window.__accounts = [
  {
    id: 'one',
    identityId: 'identity-one',
    edition: 'java',
    profileName: 'Towny AFK',
    label: 'BuilderOne',
    minecraftName: 'BuilderOne',
    username: 'builder@example.com',
    host: 'play.example.com',
    port: 25565,
    version: '',
    lastSuccessfulVersion: '1.21.4',
    connectOnStartup: true,
    antiAfk: true,
    antiAfkMinDelay: 35,
    antiAfkMaxDelay: 55,
    antiAfkActionDuration: 0.25,
    antiAfkLookDegrees: 15,
    antiAfkWalkDistance: 0.5,
    antiAfkJump: true,
    antiAfkLook: true,
    antiAfkSneak: false,
    antiAfkSwing: false,
    antiAfkWalk: false,
    environmentalMovement: true,
    autoReconnect: true,
    autoReconnectDelay: 5,
    autoReconnectBackoffMultiplier: 2,
    autoReconnectMaxDelay: 300,
    autoReconnectRateLimitDelay: 30,
    autoReconnectMaxAttempts: 0,
    connectTimeoutSeconds: 60,
    reconnectResetDelay: 60,
    autoDepositToChest: true,
    autoDepositRange: 5,
    lockedInventorySlots: [36, 37],
    joinMessage: '/server towny',
    serverChangeMessage: '/afk',
    messageDelay: 5,
    proxyMode: 'manual',
    proxy: {
      enabled: true,
      type: 'socks5',
      host: 'proxy.example.net',
      port: 1080,
      username: 'afk-user',
      hasPassword: true
    },
    automations: [
      {
        id: 'auto-1',
        name: 'Join and AFK',
        enabled: true,
        trigger: { type: 'connected' },
        steps: [
          { type: 'wait', milliseconds: 1500 },
          { type: 'chat', message: '/afk' },
          { type: 'look', direction: 'left' }
        ]
      },
      {
        id: 'auto-2',
        name: 'Periodic Deposit',
        enabled: true,
        trigger: { type: 'timer', intervalSeconds: 300 },
        steps: [
          { type: 'deposit', slot: 9, count: 64 },
          { type: 'notify', message: 'Deposited cobblestone stack' }
        ]
      }
    ]
  },
  {
    id: 'two',
    identityId: 'identity-two',
    edition: 'java',
    profileName: 'Market Stand',
    label: 'TownKeeper',
    minecraftName: 'TownKeeper',
    username: 'keeper@example.com',
    host: 'hub.example.org',
    port: 25565,
    version: '1.20.4',
    connectOnStartup: false,
    antiAfk: true,
    antiAfkMinDelay: 45,
    antiAfkMaxDelay: 60,
    environmentalMovement: true,
    autoReconnect: true,
    autoDepositToChest: false,
    autoDepositRange: 5,
    lockedInventorySlots: []
  }
];

window.afkDesk = {
  listAccounts: async () => window.__accounts,
  getSettings: async () => ({ ...window.__settings }),
  getAppVersion: async () => '0.10.0-beta.9',
  getSupportedVersions: async () => ['1.21.11', '1.21.4', '1.20.4', '1.19.4', '1.16.5', '1.12.2', '1.8.8'],
  getWorldSnapshot: async () => window.__world,
  worldAction: async (id, action, target) => {
    window.__worldActions.push({ id, action, target });
    if (action === 'select-hotbar') window.__world.quickBarSlot = target.slot;
  },
  lookDelta: async (id, yaw, pitch) => { window.__lookDeltas.push({ id, yaw, pitch }); },
  listLogs: async () => [],
  clearLogs: async () => {},
  getProxyHealth: async () => [],
  runAutomation: async () => {},
  stopAutomation: async () => {},
  completeChat: async () => [],
  duplicateProfile: async () => ({}),
  dropItems: async () => {},
  depositSlot: async () => {},
  saveSettings: async (input) => (window.__settings = { ...window.__settings, ...input }),
  setUiScale: (value) => { window.__scale = value; },
  onBotEvent: (callback) => {
    window.__botEvent = callback;
    const now = Date.now();
    setTimeout(() => {
      callback({
        type: 'status',
        id: 'one',
        payload: { status: 'online', detail: 'Online as BuilderOne', at: now - 180000 }
      });
      callback({
        type: 'version',
        id: 'one',
        payload: { version: '1.21.4', automatic: true, stable: true }
      });
      callback({
        type: 'log',
        id: 'one',
        payload: {
          kind: 'system',
          message: 'Connected to play.example.com:25565 (Minecraft 1.21.4).',
          at: now - 175000
        }
      });
      callback({
        type: 'log',
        id: 'one',
        payload: {
          kind: 'chat',
          message: '[Server] Welcome back, BuilderOne! Type /rewards to claim daily items.',
          segments: [
            { text: '[Server] ', color: '#55ffff', bold: true },
            { text: 'Welcome back, BuilderOne! Type ', color: '#ffffff' },
            { text: '/rewards', color: '#55ff55', underlined: true, click: { action: 'suggest_command', value: '/rewards' } },
            { text: ' to claim daily items.', color: '#ffffff' }
          ],
          at: now - 170000
        }
      });
      callback({
        type: 'log',
        id: 'one',
        payload: {
          kind: 'sent',
          message: '/server towny',
          at: now - 165000
        }
      });
      callback({
        type: 'log',
        id: 'one',
        payload: {
          kind: 'chat',
          message: '[Towny] BuilderOne joined Oakridge (Safezone).',
          segments: [
            { text: '[Towny] ', color: '#ffaa00' },
            { text: 'BuilderOne joined Oakridge (Safezone).', color: '#ffff55' }
          ],
          at: now - 160000
        }
      });
      callback({
        type: 'telemetry',
        id: 'one',
        payload: {
          health: 20,
          food: 18,
          selectedHotbarSlot: 0,
          position: { x: 124, y: 64, z: -38 },
          dimension: 'minecraft:overworld',
          environment: { enabled: true, physicsEnabled: true, waterStatus: 'dry' },
          nearestChest: { type: 'barrel', x: 125, y: 64, z: -38, distance: 1 },
          inventory: baseInventory
        }
      });
    }, 0);
    return () => {};
  },
  sendChat: async (_id, message) => { window.__sent.push(message); },
  reorderAccounts: async () => window.__accounts,
  control: async () => {},
  setControlState: async (_id, control, active) => { window.__controls.push([control, active]); },
  look: async () => {},
  connect: async () => {},
  disconnect: async () => {},
  dropStack: async () => {},
  setItemLock: async (_id, slot, locked) => ({ lockedInventorySlots: locked ? [slot] : [] }),
  setAutoDeposit: async () => {},
  moveInventorySlot: async (_id, sourceSlot, destinationSlot) => {
    window.__inventoryMoves.push([sourceSlot, destinationSlot]);
    return { account: {}, sourceSlot, targetSlot: destinationSlot };
  },
  equipInventoryItem: async (_id, slot, destination) => {
    window.__equips.push([slot, destination]);
    return { account: {}, sourceSlot: slot, targetSlot: slot, destination: destination === 'auto' ? 'head' : destination };
  },
  clickWindowSlot: async (_id, slot) => { window.__windowClicks.push(slot); },
  closeServerWindow: async () => { window.__botEvent({ type: 'window', id: 'one', payload: { open: false } }); },
  saveAccount: async (value) => value,
  deleteAccount: async () => {},
  openExternal: async () => {},
  openIsolatedLogin: async () => {}
};
"""


def find_browser_executable() -> str | None:
    env_browser = os.environ.get("AFK_DESK_TEST_BROWSER")
    if env_browser and Path(env_browser).exists():
        return env_browser
    edge_candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]
    for candidate in edge_candidates:
        if candidate.exists():
            return str(candidate)
    return None


def optimize_png(path: Path) -> None:
    with Image.open(path) as img:
        img.load()
        img.save(path, format="PNG", optimize=True)
    if path.stat().st_size > MAX_BYTES:
        with Image.open(path) as img:
            quantized = img.convert("P", palette=Image.Palette.ADAPTIVE, colors=256)
            quantized.save(path, format="PNG", optimize=True)
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise RuntimeError(f"{path.name} exceeds 400 KB after optimization ({size} bytes)")


def save_shot(page, filename: str, clip: dict | None = None) -> Path:
    target = OUTPUT_DIR / filename
    page.screenshot(path=str(target), clip=clip)
    optimize_png(target)
    print(f"Captured {target.name} ({target.stat().st_size / 1024:.1f} KB)")
    return target


def run() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    executable = find_browser_executable()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=executable)
        errors: list[str] = []

        page = browser.new_page(viewport={"width": 1366, "height": 768})
        page.set_default_timeout(10000)
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.add_init_script(STUB)
        page.goto(INDEX_URL, wait_until="networkidle")
        page.locator("#dashboard:not([hidden])").wait_for()
        page.locator('.minecraft-slot[aria-label^="Town Blade"]').wait_for()
        page.wait_for_timeout(150)

        # 1. Main window (1366x768)
        save_shot(page, "main-window.png")

        # 2. Inventory panel with full grid, item selection, and rich tooltip
        page.locator('[data-workspace-view="inventory"]').click()
        page.wait_for_timeout(120)
        sword = page.locator('.minecraft-slot[aria-label^="Town Blade"]')
        sword.click()
        sword_box = sword.bounding_box()
        page.mouse.move(sword_box["x"] + sword_box["width"] - 2, sword_box["y"] + sword_box["height"] / 2)
        page.locator("#item-tooltip:not([hidden])").wait_for()
        inv_box = page.locator(".inventory-panel").bounding_box()
        tip_box = page.locator("#item-tooltip").bounding_box()
        clip_top = max(0, min(inv_box["y"], tip_box["y"]) - 12)
        clip_left = max(0, min(inv_box["x"], tip_box["x"]) - 12)
        clip_right = min(1366, max(inv_box["x"] + inv_box["width"], tip_box["x"] + tip_box["width"]) + 12)
        clip_bottom = min(768, max(inv_box["y"] + inv_box["height"], tip_box["y"] + tip_box["height"]) + 12)
        save_shot(
            page,
            "inventory-panel.png",
            clip={
                "x": clip_left,
                "y": clip_top,
                "width": clip_right - clip_left,
                "height": clip_bottom - clip_top,
            },
        )
        page.locator('[data-workspace-view="overview"]').click()
        page.locator("body").click(position={"x": 500, "y": 40})

        # 3. Account editor dialog
        page.locator("#edit-account").click()
        page.locator("#account-dialog").wait_for(state="visible")
        page.wait_for_timeout(100)
        save_shot(page, "account-editor.png")
        page.locator("[data-close-account]").first.click()
        page.locator("#account-dialog").wait_for(state="hidden")

        # 4. Settings dialog
        page.locator("#open-settings").click()
        page.locator("#settings-dialog").wait_for(state="visible")
        page.wait_for_timeout(100)
        save_shot(page, "settings-dialog.png")
        page.locator("#close-settings").click()
        page.locator("#settings-dialog").wait_for(state="hidden")

        # 5. Automation dialog
        page.locator("#open-automations").click()
        page.locator("#automation-dialog").wait_for(state="visible")
        page.locator(".automation-node.action").first.click()
        page.wait_for_timeout(100)
        save_shot(page, "automation-dialog.png")
        page.locator("#close-automation").click()
        page.locator("#automation-dialog").wait_for(state="hidden")

        # 6. POV view (focused perspective view with world and HUD)
        page.locator("#open-pov").click()
        page.locator("#pov-dialog").wait_for(state="visible")
        page.locator("#pov-grid canvas[data-position]").wait_for()
        page.locator(".pov-expand").first.click()
        page.locator("#pov-grid canvas[data-position]").wait_for()
        page.locator("#pov-x").fill("1")
        page.locator("#pov-y").fill("64")
        page.locator("#pov-z").fill("-5")
        page.wait_for_timeout(150)
        save_shot(page, "pov-view.png")
        page.locator("#close-pov").click()
        page.locator("#pov-dialog").wait_for(state="hidden")

        # 7. Compact / narrow layout
        compact = browser.new_page(viewport={"width": 860, "height": 600})
        compact.set_default_timeout(10000)
        compact.on("pageerror", lambda err: errors.append(str(err)))
        compact.add_init_script(STUB)
        compact.goto(INDEX_URL, wait_until="networkidle")
        compact.locator("#dashboard:not([hidden])").wait_for()
        compact.locator('.minecraft-slot[aria-label^="Town Blade"]').wait_for()
        compact.locator("#toggle-sidebar").click()
        compact.wait_for_timeout(250)
        save_shot(compact, "compact-layout.png")

        assert not errors, f"Page errors encountered: {errors}"
        browser.close()

    verify_relative_links()


def verify_relative_links() -> None:
    files = [
        REPO_ROOT / "README.md",
        REPO_ROOT / "CONTRIBUTING.md",
        *sorted((REPO_ROOT / "docs" / "user-guide").glob("*.md")),
    ]
    md_pattern = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
    html_pattern = re.compile(r'(?:href|src)="([^"]+)"')
    broken: list[str] = []
    checked = 0

    for doc in files:
        text = doc.read_text(encoding="utf-8")
        for raw in md_pattern.findall(text) + html_pattern.findall(text):
            target = raw.split("#", 1)[0].strip()
            if not target or target.startswith(("http://", "https://", "mailto:")):
                continue
            checked += 1
            resolved = (doc.parent / target).resolve()
            if not resolved.exists():
                broken.append(f"{doc.relative_to(REPO_ROOT)} -> {raw}")

    if broken:
        raise RuntimeError("Broken relative links:\n  " + "\n  ".join(broken))
    print(f"Verified {checked} relative links across {len(files)} markdown files.")


if __name__ == "__main__":
    run()
