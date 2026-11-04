import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-edit-lock-fixture.tsx"></script></body></html>`;
const state = (page: Page) => page.getByTestId("lock-state");
const oldExpiredMessage = "编辑权已失效，已停止编辑";

async function expireLease(page: Page) {
    await page.evaluate(() => {
        const previousNow = Date.now;
        Date.now = () => previousNow() + 20_000;
        window.dispatchEvent(new FocusEvent("focus"));
    });
}

async function expectPreservedEditor(page: Page, draft: string) {
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    await expect(page.getByTestId("loads")).toHaveText("1");
    await expect(page.getByTestId("flushes")).toHaveText("0");
    await expect(page.getByRole("textbox", { name: "draft" })).toHaveValue(draft);
    await expect(page.getByText(oldExpiredMessage, { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => window.__lockFixture.canWrite())).toBe(true);
    expect(await page.evaluate(message => window.__lockObservations.some(item => item.status === "readonly" || item.error?.includes(message)), oldExpiredMessage)).toBe(false);
}

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

test("IndexedDB atomic claims, expiration and ownership-checked renew/release", async ({ context, page }) => {
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
});

test("HTTP single tab automatically resumes repeatedly without reload, draft loss or expiry warning", async ({ context, page }) => {
    await prepare(context, true);
    await page.goto("/__lock?project=resume-alone");
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    const draft = "unsaved garment draft after the last durable save";
    await page.getByRole("textbox", { name: "draft" }).fill(draft);
    for (let attempt = 0; attempt < 3; attempt++) {
        await expireLease(page);
        await expectPreservedEditor(page, draft);
    }
    await page.getByRole("button", { name: "write", exact: true }).click();
    await expect(page.getByTestId("writes")).toHaveText("1");
});

test("HTTP recovery blocks events and writes and coalesces concurrent wake-up events", async ({ context, page }) => {
    await prepare(context, true);
    await page.goto("/__lock?project=resume-concurrent");
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    const draft = "unsaved draft kept while the storage check is pending";
    await page.getByRole("textbox", { name: "draft" }).fill(draft);
    await page.evaluate(() => {
        // Keep real IDB transactions pending: no mock result can accidentally
        // enable writes before the ownership check commits atomically.
        const probe = (window as any).__leaseProbe = { hold: true, started: 0, active: 0, maxActive: 0 };
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (names, mode, options) {
            const transaction = original.call(this, names, mode, options);
            if (this.name !== "wireless-canvas-editor-locks" || mode !== "readwrite" || !probe.hold) return transaction;
            probe.started++;
            probe.active++;
            probe.maxActive = Math.max(probe.maxActive, probe.active);
            const done = () => { probe.active--; };
            transaction.addEventListener("complete", done, { once: true });
            transaction.addEventListener("abort", done, { once: true });
            const store = transaction.objectStore("leases");
            const keepAlive = () => {
                if (!probe.hold) return;
                store.get("__test_keepalive__").onsuccess = keepAlive;
            };
            keepAlive();
            return transaction;
        };
    });
    await expireLease(page);
    await expect(state(page)).toHaveAttribute("data-state", "recovering");
    const blocked = await page.evaluate(() => {
        const input = document.querySelector("input")!;
        let reachedInput = 0;
        input.addEventListener("keydown", () => reachedInput++);
        const results = [];
        for (let index = 0; index < 8; index++) {
            window.dispatchEvent(new FocusEvent("focus"));
            window.dispatchEvent(new PageTransitionEvent("pageshow"));
            document.dispatchEvent(new Event("visibilitychange"));
            results.push(input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })));
            results.push(input.dispatchEvent(new InputEvent("beforeinput", { data: "a", bubbles: true, cancelable: true })));
            results.push(input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })));
        }
        (window as any).__awaitedWrites = [];
        for (let index = 0; index < 8; index++) void window.__lockFixture.ensureWritable().then(value => (window as any).__awaitedWrites.push(value));
        return { results, reachedInput, canWrite: window.__lockFixture.canWrite(), write: window.__lockFixture.write(), ...((window as any).__leaseProbe) };
    });
    expect(blocked).toMatchObject({ reachedInput: 0, canWrite: false, write: false, started: 1, active: 1, maxActive: 1 });
    expect(blocked.results.every(value => value === false)).toBe(true);
    await expect(page.getByTestId("writes")).toHaveText("0");
    expect(await page.evaluate(() => (window as any).__awaitedWrites)).toEqual([]);
    await page.evaluate(() => { (window as any).__leaseProbe.hold = false; });
    await expectPreservedEditor(page, draft);
    expect(await page.evaluate(() => (window as any).__awaitedWrites)).toEqual(Array(8).fill(true));
});

for (const releaseNewOwner of [false, true]) {
    test(`HTTP suspended old tab cannot recover stale draft after another tab takes over${releaseNewOwner ? " and releases" : ""}`, async ({ context, page }) => {
        await prepare(context, true);
        const project = releaseNewOwner ? "takeover-released" : "takeover-held";
        await page.goto(`/__lock?project=${project}`);
        await expect(state(page)).toHaveAttribute("data-state", "editing");
        const draft = "old tab unsaved draft must not overwrite the new editor";
        await page.getByRole("textbox", { name: "draft" }).fill(draft);
        const session = await context.newCDPSession(page);
        await session.send("Page.setWebLifecycleState", { state: "frozen" });
        const second = await context.newPage();
        await second.addInitScript(() => {
            const previousNow = Date.now;
            Date.now = () => previousNow() + 20_000;
        });
        await second.goto(`/__lock?project=${project}`);
        await expect(state(second)).toHaveAttribute("data-state", "editing");
        await second.getByRole("button", { name: "write", exact: true }).click();
        await expect(second.getByTestId("writes")).toHaveText("1");
        if (releaseNewOwner) {
            await second.evaluate(() => window.__unmountLockFixture());
            // Navigation does not guarantee React cleanup. Explicitly unmount
            // and verify the new owner's lease was truly removed before resume.
            await expect.poll(() => second.evaluate(projectId => new Promise(resolve => {
                const open = indexedDB.open("wireless-canvas-editor-locks", 1);
                open.onsuccess = () => {
                    const database = open.result;
                    const request = database.transaction("leases", "readonly").objectStore("leases").get(`canvas-editor:${JSON.stringify(["test-owner", projectId])}`);
                    request.onsuccess = () => { resolve(request.result ?? null); database.close(); };
                    request.onerror = () => { resolve("read-error"); database.close(); };
                };
                open.onerror = () => resolve("open-error");
            }), project)).toBeNull();
        }
        await session.send("Page.setWebLifecycleState", { state: "active" });
        await expireLease(page);
        await expect(state(page)).toHaveAttribute("data-state", "readonly");
        await page.getByRole("button", { name: "write", exact: true }).click();
        expect(await page.evaluate(() => ({ canWrite: window.__lockFixture.canWrite(), write: window.__lockFixture.write() }))).toEqual({ canWrite: false, write: false });
        expect(await page.evaluate(() => window.__lockFixture.ensureWritable())).toBe(false);
        await expect(page.getByTestId("writes")).toHaveText("0");
        await expect(page.getByTestId("loads")).toHaveText("1");
        await expect(page.getByTestId("flushes")).toHaveText("0");
        await expect(page.getByRole("textbox", { name: "draft" })).toHaveValue(draft);
        await session.detach();
    });
}

test("HTTP storage error during resume fails closed without discarding the draft", async ({ context, page }) => {
    await prepare(context, true);
    await page.goto("/__lock?project=resume-storage-error");
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    const draft = "unsaved draft survives an unavailable local store";
    await page.getByRole("textbox", { name: "draft" }).fill(draft);
    await page.evaluate(() => {
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (names, mode, options) {
            if (this.name === "wireless-canvas-editor-locks" && mode === "readwrite") throw new DOMException("fixture unavailable storage", "UnknownError");
            return original.call(this, names, mode, options);
        };
    });
    await expireLease(page);
    await expect(state(page)).toHaveAttribute("data-state", /^(readonly|error)$/);
    expect(await page.evaluate(() => ({ canWrite: window.__lockFixture.canWrite(), write: window.__lockFixture.write() }))).toEqual({ canWrite: false, write: false });
    await expect(page.getByTestId("writes")).toHaveText("0");
    await expect(page.getByTestId("loads")).toHaveText("1");
    await expect(page.getByRole("textbox", { name: "draft" })).toHaveValue(draft);
});

for (const failProvider of [false, true]) {
    test(`HTTP fallback waits for its lease provider and ${failProvider ? "fails closed on unavailable code" : "enables writes only after acquisition"}`, async ({ context, page }) => {
        await prepare(context, true);
        let providerRequested = false;
        const gate = Promise.withResolvers<void>();
        await page.route("**/src/lib/canvas/canvas-edit-lease.ts", async route => {
            providerRequested = true;
            await gate.promise;
            if (failProvider) await route.abort("failed");
            else await route.continue();
        });
        await page.goto(`/__lock?project=provider-${failProvider}`, { waitUntil: "domcontentloaded" });
        await expect.poll(() => providerRequested).toBe(true);
        await expect(state(page)).toHaveAttribute("data-state", "checking");
        expect(await page.evaluate(async () => ({ write: window.__lockFixture.write(), ready: await window.__lockFixture.ensureWritable() }))).toEqual({ write: false, ready: false });
        await expect(page.getByTestId("loads")).toHaveText("0");
        gate.resolve();
        await expect(state(page)).toHaveAttribute("data-state", failProvider ? "error" : "editing");
        expect(await page.evaluate(() => window.__lockFixture.canWrite())).toBe(!failProvider);
        await expect(page.getByTestId("loads")).toHaveText(failProvider ? "0" : "1");
    });
}

test("HTTP same-page retry reloads a failed provider request after the network recovers", async ({ context, page }) => {
    await prepare(context, true);
    let unavailable = true, requests = 0;
    await page.route("**/src/lib/canvas/canvas-edit-lease.ts", route => {
        requests++;
        return unavailable ? route.abort("failed") : route.continue();
    });
    await page.goto("/__lock?project=provider-network-retry");
    await expect(state(page)).toHaveAttribute("data-state", "error");
    expect(requests).toBe(1);
    expect(await page.evaluate(async () => ({ write: window.__lockFixture.write(), ready: await window.__lockFixture.ensureWritable() }))).toEqual({ write: false, ready: false });
    await expect(page.getByTestId("loads")).toHaveText("0");
    unavailable = false;
    await page.getByRole("button", { name: "request", exact: true }).click();
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    expect(requests).toBe(2);
    await expect(page.getByTestId("loads")).toHaveText("1");
    expect(await page.evaluate(() => window.__lockFixture.canWrite())).toBe(true);
});

test("HTTP same-page retry reopens IndexedDB after an initial open error", async ({ context, page }) => {
    await prepare(context, true);
    await page.addInitScript(() => {
        const probe = (window as any).__leaseOpenProbe = { unavailable: true, attempts: 0 };
        const original = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (name, version) {
            if (name === "wireless-canvas-editor-locks") {
                probe.attempts++;
                if (probe.unavailable) {
                    const request = { error: new DOMException("fixture initial open unavailable", "UnknownError"), onerror: null as (() => void) | null };
                    queueMicrotask(() => request.onerror?.());
                    return request as unknown as IDBOpenDBRequest;
                }
            }
            return original.call(this, name, version);
        };
    });
    await page.goto("/__lock?project=idb-open-retry");
    await expect(state(page)).toHaveAttribute("data-state", "error");
    expect(await page.evaluate(async () => ({ attempts: (window as any).__leaseOpenProbe.attempts, write: window.__lockFixture.write(), ready: await window.__lockFixture.ensureWritable() }))).toEqual({ attempts: 1, write: false, ready: false });
    await expect(page.getByTestId("loads")).toHaveText("0");
    await page.evaluate(() => { (window as any).__leaseOpenProbe.unavailable = false; });
    await page.getByRole("button", { name: "request", exact: true }).click();
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    expect(await page.evaluate(() => (window as any).__leaseOpenProbe.attempts)).toBe(2);
    await expect(page.getByTestId("loads")).toHaveText("1");
    expect(await page.evaluate(() => window.__lockFixture.canWrite())).toBe(true);
});

test("Web Locks does not load the HTTP fallback provider", async ({ context, page }) => {
    await prepare(context, false);
    let providerRequests = 0;
    await page.route("**/src/lib/canvas/canvas-edit-lease.ts", route => { providerRequests++; return route.abort("failed"); });
    await page.goto("/__lock?project=native-without-idb-provider");
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    expect(providerRequests).toBe(0);
    expect(await page.evaluate(() => window.__lockFixture.canWrite())).toBe(true);
});

test("real insecure HTTP origin has no Web Locks and still enforces exclusive editing", async ({ context, page }, testInfo) => {
    // Route test-only HTTP hostname through the local fixture server. This is
    // genuinely a non-trustworthy browser origin, not a navigator.locks stub.
    const upstream = new URL(testInfo.project.use.baseURL!);
    const insecureOrigin = `http://canvas-lock.test:${upstream.port}`;
    await context.route(`${insecureOrigin}/**`, async route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/__lock") return route.fulfill({ contentType: "text/html", body: fixture });
        const response = await route.fetch({ url: new URL(`${url.pathname}${url.search}`, upstream).href });
        return route.fulfill({ response });
    });
    await context.routeWebSocket(`${insecureOrigin.replace("http:", "ws:")}/**`, socket => socket.close());
    await page.goto(`${insecureOrigin}/__lock?project=insecure`);
    expect(await page.evaluate(() => ({ secure: isSecureContext, locks: typeof navigator.locks, randomUUID: typeof crypto.randomUUID, idb: typeof indexedDB }))).toEqual({ secure: false, locks: "undefined", randomUUID: "undefined", idb: "object" });
    await expect(state(page)).toHaveAttribute("data-state", "editing");
    const draft = "real HTTP unsaved draft";
    await page.getByRole("textbox", { name: "draft" }).fill(draft);
    await expireLease(page);
    await expectPreservedEditor(page, draft);
    const second = await context.newPage();
    await second.goto(`${insecureOrigin}/__lock?project=insecure`);
    await expect(state(second)).toHaveAttribute("data-state", "readonly");
    await second.getByRole("button", { name: "request", exact: true }).click();
    await expect(state(second)).toHaveAttribute("data-state", "editing");
    await expect(state(page)).toHaveAttribute("data-state", "readonly");
});
