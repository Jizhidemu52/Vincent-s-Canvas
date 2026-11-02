import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-edit-lock-fixture.tsx"></script></body></html>`;
const state = (page: Page) => page.getByTestId("lock-state");

async function prepare(context: BrowserContext, fallback: boolean) {
    if (fallback) await context.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined, configurable: true }));
    await context.route("**/__lock?*", route => route.fulfill({ contentType: "text/html", body: fixture }));
}

for (const fallback of [false, true]) {
    const label = fallback ? "HTTP IndexedDB lease" : "Web Locks";
    test(`${label}: StrictMode single editor, isolated owners and safe two-tab handoff`, async ({ context, page }) => {
        await prepare(context, fallback);
        await page.goto("/__lock?project=handoff");
        await expect(state(page)).toHaveAttribute("data-state", "editing");
        const second = await context.newPage();
        await second.goto("/__lock?project=handoff");
        await expect(state(second)).toHaveAttribute("data-state", "readonly");
        const isolated = await context.newPage();
        await isolated.goto("/__lock?project=handoff&owner=another-owner");
        await expect(state(isolated)).toHaveAttribute("data-state", "editing");
        await second.getByRole("button", { name: "request", exact: true }).click();
        await expect(state(second)).toHaveAttribute("data-state", "editing");
        await expect(state(page)).toHaveAttribute("data-state", "readonly");
        await expect(page.getByTestId("flushes")).toHaveText("1");
        await expect(second.getByTestId("loads")).toHaveText("1");
    });
    test(`${label}: failed save retains owner, denied requester can retry`, async ({ context, page }) => {
        await prepare(context, fallback);
        await page.goto("/__lock?project=save-failure");
        await expect(state(page)).toHaveAttribute("data-state", "editing");
        await page.getByRole("button", { name: "toggle failure" }).click();
        const second = await context.newPage();
        await second.goto("/__lock?project=save-failure");
        await expect(state(second)).toHaveAttribute("data-state", "readonly");
        await second.getByRole("button", { name: "request", exact: true }).click();
        await expect(page.getByText("本页尚未保存成功", { exact: false })).toBeVisible();
        await expect(state(page)).toHaveAttribute("data-state", "editing");
        await expect(second.getByText("另一标签页尚未保存成功", { exact: false })).toBeVisible();
        await page.getByRole("button", { name: "toggle failure" }).click();
        await second.getByRole("button", { name: "request", exact: true }).click();
        await expect(state(second)).toHaveAttribute("data-state", "editing");
        await expect(state(page)).toHaveAttribute("data-state", "readonly");
    });
    test(`${label}: acquired reload failure releases ownership without enabling editing`, async ({ context, page }) => {
        await prepare(context, fallback);
        await page.goto("/__lock?project=reload-failure&failLoad=true");
        await expect(state(page)).toHaveAttribute("data-state", "error");
        const second = await context.newPage();
        await second.goto("/__lock?project=reload-failure");
        await expect(state(second)).toHaveAttribute("data-state", "editing");
        await expect(page.getByTestId("flushes")).toHaveText("0");
    });
}

test("IndexedDB atomic claims, expiration, ownership-checked renew/release and tab suspension", async ({ context, page }) => {
    await prepare(context, true);
    await page.goto("/__lock?project=lease-test");
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    const result = await page.evaluate(async () => {
        const module = await import("/src/lib/canvas/canvas-edit-lease.ts");
        const leases = Array.from({ length: 10 }, () => module.createCanvasEditLease("isolated-atomic-lock-test"));
        const claims = await Promise.all(leases.map((lease, index) => lease.claim("shared", `tab-${index}`, 1000)));
        const winner = claims.findIndex(Boolean);
        const loser = (winner + 1) % leases.length;
        const denied = await leases[loser].renew("shared", `tab-${loser}`, 2000);
        await leases[loser].release("shared", `tab-${loser}`);
        const retained = await leases[winner].renew("shared", `tab-${winner}`, 2000);
        const stolen = await leases[loser].claim("shared", `tab-${loser}`, 2000 + module.CANVAS_EDIT_LEASE_MS);
        const oldRenewal = await leases[winner].renew("shared", `tab-${winner}`, 2001 + module.CANVAS_EDIT_LEASE_MS);
        await leases[winner].release("shared", `tab-${winner}`);
        const newStillOwns = await leases[loser].renew("shared", `tab-${loser}`, 2002 + module.CANVAS_EDIT_LEASE_MS);
        leases.forEach(lease => lease.close());
        return { winners: claims.filter(Boolean).length, denied, retained: Boolean(retained), stolen: Boolean(stolen), oldRenewal, newStillOwns: Boolean(newStillOwns) };
    });
    expect(result).toEqual({ winners: 1, denied: null, retained: true, stolen: true, oldRenewal: null, newStillOwns: true });
    // Simulate a suspended tab resuming after its heartbeat has expired.
    await page.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 20_000; window.dispatchEvent(new FocusEvent("focus")); });
    await expect(state(page)).toHaveAttribute("data-state", "readonly");
});

test("real insecure HTTP origin has no Web Locks and still enforces exclusive editing", async ({ context, page }) => {
    // Route test-only HTTP hostname through the local fixture server. This is
    // genuinely a non-trustworthy browser origin, not a navigator.locks stub.
    await context.route("http://canvas-lock.test:5207/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/__lock") return route.fulfill({ contentType: "text/html", body: fixture });
        const response = await route.fetch({ url: `http://127.0.0.1:5207${url.pathname}${url.search}` });
        return route.fulfill({ response });
    });
    await context.routeWebSocket("ws://canvas-lock.test:5207/**", socket => socket.close());
    await page.goto("http://canvas-lock.test:5207/__lock?project=insecure");
    expect(await page.evaluate(() => ({ secure: isSecureContext, locks: typeof navigator.locks, randomUUID: typeof crypto.randomUUID, idb: typeof indexedDB }))).toEqual({ secure: false, locks: "undefined", randomUUID: "undefined", idb: "object" });
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    const second = await context.newPage();
    await second.goto("http://canvas-lock.test:5207/__lock?project=insecure");
    await expect(state(second)).toHaveAttribute("data-state", "readonly");
    await second.getByRole("button", { name: "request", exact: true }).click();
    await expect(state(second)).toHaveAttribute("data-state", "editing");
    await expect(state(page)).toHaveAttribute("data-state", "readonly");
});
