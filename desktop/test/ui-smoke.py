from pathlib import Path
from tempfile import gettempdir
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
URL = (ROOT / "src" / "index.html").as_uri()
STUB = r"""
window.__sent = [];
window.__scale = 100;
window.__settings = { startWithWindows: false, staggerStartupConnections: true, startupConnectionDelay: 3, uiScale: 100, macros: [{ label: 'Town', message: '/server towny' }] };
window.afkDesk = {
  listAccounts: async () => [{ id: 'one', label: 'TestPlayer', username: 'test@example.com', host: 'play.example.com', port: 25565, antiAfk: true, environmentalMovement: true }],
  getSettings: async () => ({ ...window.__settings }),
  saveSettings: async (input) => (window.__settings = { ...window.__settings, ...input }),
  setUiScale: (value) => { window.__scale = value; },
  onBotEvent: (callback) => { setTimeout(() => callback({ type: 'status', id: 'one', payload: { status: 'online', detail: 'Ready', at: Date.now() } }), 0); return () => {}; },
  sendChat: async (_id, message) => { window.__sent.push(message); },
  reorderAccounts: async () => [], control: async () => {}, look: async () => {},
  connect: async () => {}, disconnect: async () => {}, dropStack: async () => {}, setAutoDeposit: async () => {},
  saveAccount: async (value) => value, deleteAccount: async () => {},
  remoteStatus: async () => ({ localUrl: 'http://127.0.0.1', port: 37123 }),
  listRemoteGrants: async () => [], createRemoteGrant: async () => ({}), revokeRemoteGrant: async () => {},
  openExternal: async () => {}, openIsolatedLogin: async () => {}, openRemoteDashboard: async () => {}, enableTailscale: async () => ({})
};
"""


def run() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1366, "height": 768})
        page.add_init_script(STUB)
        page.goto(URL, wait_until="domcontentloaded")
        page.locator("#dashboard:not([hidden])").wait_for()
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
        assert page.evaluate("document.body.scrollHeight <= innerHeight")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert page.locator("#macro-pad").is_visible()
        desktop = str(Path(gettempdir()) / "afkdesk-ui-desktop.png")
        page.screenshot(path=desktop)

        narrow = browser.new_page(viewport={"width": 700, "height": 800})
        narrow.add_init_script(STUB)
        narrow.goto(URL, wait_until="domcontentloaded")
        narrow.locator("#dashboard:not([hidden])").wait_for()
        assert narrow.evaluate("document.documentElement.scrollWidth <= innerWidth")
        narrow_path = str(Path(gettempdir()) / "afkdesk-ui-narrow.png")
        narrow.screenshot(path=narrow_path, full_page=True)
        browser.close()
        print(desktop)
        print(narrow_path)


if __name__ == "__main__":
    run()
