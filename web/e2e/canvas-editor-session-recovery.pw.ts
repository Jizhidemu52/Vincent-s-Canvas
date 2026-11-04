import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-editor-session-recovery.fixture.tsx"></script></body></html>`;
const draft = (page: Page) => page.getByRole("textbox", { name: "session draft" });
const editor = (page: Page) => page.getByTestId("session-editor");

test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined, configurable: true }));
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1" || url.pathname.startsWith("/api/")) return route.abort("blockedbyclient");
        if (url.pathname === "/__session") return route.fulfill({ contentType: "text/html", body: fixture });
        return route.continue();
    });
});

async function expectEditing(page: Page) {
    await expect(editor(page)).toBeVisible();
    await expect(page.locator("[data-canvas-edit-blocked=true]")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__editorSessionFixture.capabilities.at(-1)?.current)).toBe(true);
}

async function expireLease(page: Page) {
    await page.evaluate(() => {
        const previousNow = Date.now;
        Date.now = () => previousNow() + 20_000;
        window.dispatchEvent(new FocusEvent("focus"));
    });
}

async function takeover(context: BrowserContext, page: Page, project: string, waitForRecoveryView = true, clockAdvance = 20_000) {
    const session = await context.newCDPSession(page);
    await session.send("Page.setWebLifecycleState", { state: "frozen" });
    const second = await context.newPage();
    await second.addInitScript(advance => { const previousNow = Date.now; Date.now = () => previousNow() + advance; }, clockAdvance);
    await second.goto(`/__session?project=${project}`);
    await expectEditing(second);
    await draft(second).fill("latest graph saved by the other editor");
    await second.evaluate(() => window.__editorSessionFixture.save());
    await session.send("Page.setWebLifecycleState", { state: "active" });
    await expireLease(page);
    if (waitForRecoveryView) await expect(page.getByRole("button", { name: "备份并在此页编辑", exact: true })).toBeVisible();
    await expect(page.locator("[data-canvas-edit-blocked=true]")).toHaveCount(1);
    await session.detach();
    return second;
}

test("CanvasEditorSession keeps the same mounted editor and unsaved draft throughout HTTP recovery", async ({ page }) => {
    await page.goto("/__session?project=session-preserved");
    await expectEditing(page);
    await draft(page).fill("local unsaved garment design");
    const instance = await editor(page).getAttribute("data-instance");
    const baseline = await page.evaluate(() => {
        const probe = window.__editorSessionFixture;
        return { mounts: probe.mounts, unmounts: probe.unmounts, storeCommits: probe.storeCommits, capabilities: probe.capabilities.length };
    });
    await page.evaluate(() => {
        const probe = (window as any).__sessionLeaseGate = { hold: true };
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (names, mode, options) {
            const transaction = original.call(this, names, mode, options);
            if (this.name === "wireless-canvas-editor-locks" && mode === "readwrite" && probe.hold) {
                const store = transaction.objectStore("leases");
                const keepAlive = () => { if (probe.hold) store.get("__session_keepalive__").onsuccess = keepAlive; };
                keepAlive();
            }
            return transaction;
        };
    });
    await expireLease(page);
    await expect(page.getByRole("status")).toHaveText("正在恢复本页编辑连接，画布内容已保留…");
    await expect(editor(page)).toHaveAttribute("data-instance", instance!);
    await expect(draft(page)).toHaveValue("local unsaved garment design");
    expect(await draft(page).evaluate(element => Boolean(element.closest("[inert]")))).toBe(true);
    expect(await page.evaluate(() => window.__editorSessionFixture.write())).toBe(false);
    await page.evaluate(() => { (window as any).__sessionLeaseGate.hold = false; });
    await expectEditing(page);
    await expect(editor(page)).toHaveAttribute("data-instance", instance!);
    await expect(draft(page)).toHaveValue("local unsaved garment design");
    expect(await page.evaluate(() => {
        const probe = window.__editorSessionFixture;
        return { mounts: probe.mounts, unmounts: probe.unmounts, storeCommits: probe.storeCommits, capabilities: probe.capabilities.length };
    })).toEqual(baseline);
    await expect(page.getByText("编辑权已失效", { exact: false })).toHaveCount(0);
});

test("CanvasEditorSession retains a revoked draft and never requests editing when its backup fails", async ({ context, page }) => {
    const project = "session-backup-failure";
    await page.goto(`/__session?project=${project}`);
    await expectEditing(page);
    await draft(page).fill("irreplaceable unsaved old-page draft");
    const instance = await editor(page).getAttribute("data-instance");
    const second = await takeover(context, page, project);
    const baseline = await page.evaluate(() => ({ mounts: window.__editorSessionFixture.mounts, storeCommits: window.__editorSessionFixture.storeCommits }));
    await page.evaluate(() => { window.__editorSessionFixture.backupFailure = true; });
    await page.getByRole("button", { name: "备份并在此页编辑", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("fixture backup failed");
    await expect(editor(page)).toHaveAttribute("data-instance", instance!);
    await expect(draft(page)).toHaveValue("irreplaceable unsaved old-page draft");
    expect(await page.evaluate(() => {
        const probe = window.__editorSessionFixture;
        return { backups: probe.backups, discards: probe.discards, backedUpDrafts: probe.backedUpDrafts, mounts: probe.mounts, storeCommits: probe.storeCommits, writable: probe.capabilities[0].current };
    })).toEqual({ backups: 1, discards: 0, backedUpDrafts: [], ...baseline, writable: false });
    expect(await page.evaluate(() => window.__editorSessionFixture.capabilities[0].ensureWritable())).toBe(false);
    await expectEditing(second);
    expect(await second.evaluate(() => window.__editorSessionFixture.flushes)).toBe(0);
});

test("CanvasEditorSession loads recovery views only on a real loss and retains the draft if the chunk fails", async ({ context, page }) => {
    let blocked = true, viewRequests = 0;
    await page.route("**/src/pages/canvas/canvas-editor-session-views.tsx", route => {
        viewRequests++;
        return blocked ? route.abort("failed") : route.continue();
    });
    const project = "session-recovery-chunk";
    await page.goto(`/__session?project=${project}`);
    await expectEditing(page);
    await draft(page).fill("draft survives unavailable recovery controls");
    const instance = await editor(page).getAttribute("data-instance");
    await expireLease(page);
    await expectEditing(page);
    expect(viewRequests).toBe(0);
    const second = await takeover(context, page, project, false, 40_000);
    await expect(page.getByRole("status")).toHaveText("恢复界面暂时无法载入，本页内容已保留。");
    await expect(editor(page)).toHaveAttribute("data-instance", instance!);
    await expect(draft(page)).toHaveValue("draft survives unavailable recovery controls");
    expect(await page.evaluate(() => window.__editorSessionFixture.write())).toBe(false);
    expect(await page.evaluate(() => window.__editorSessionFixture.backups)).toBe(0);
    await expectEditing(second);
    blocked = false;
    await page.getByRole("button", { name: "重试载入恢复界面", exact: true }).click();
    await expect(page.getByRole("button", { name: "备份并在此页编辑", exact: true })).toBeVisible();
    await expect(editor(page)).toHaveAttribute("data-instance", instance!);
    await expect(draft(page)).toHaveValue("draft survives unavailable recovery controls");
});

test("CanvasEditorSession backs up once before reload, replaces the editor epoch and permanently revokes old capabilities", async ({ context, page }) => {
    const project = "session-backup-reacquire";
    await page.goto(`/__session?project=${project}`);
    await expectEditing(page);
    await draft(page).fill("old unsaved draft to export before reload");
    const instance = await editor(page).getAttribute("data-instance");
    const second = await takeover(context, page, project);
    await page.evaluate(() => {
        window.__editorSessionFixture.holdBackup = true;
        const button = [...document.querySelectorAll("button")].find(element => element.textContent === "备份并在此页编辑")!;
        // Reentrant same-tick actions must not duplicate backups or ownership requests.
        button.click();
        button.click();
    });
    await expect(page.getByRole("button", { name: "正在备份…", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => ({ backups: window.__editorSessionFixture.backups, discards: window.__editorSessionFixture.discards }))).toEqual({ backups: 1, discards: 0 });
    await expect(editor(page)).toHaveAttribute("data-instance", instance!);
    await expect(draft(page)).toHaveValue("old unsaved draft to export before reload");
    expect(await second.evaluate(() => window.__editorSessionFixture.flushes)).toBe(0);
    await page.evaluate(() => window.__editorSessionFixture.releaseBackup());
    await expectEditing(page);
    await expect(editor(page)).not.toHaveAttribute("data-instance", instance!);
    await expect(draft(page)).toHaveValue("latest graph saved by the other editor");
    const after = await page.evaluate(async () => {
        const probe = window.__editorSessionFixture;
        return {
            backups: probe.backups, discards: probe.discards, backedUpDrafts: probe.backedUpDrafts, discardSnapshots: probe.discardSnapshots,
            capabilityCount: probe.capabilities.length, oldWritable: probe.capabilities[0].current, oldEnsureWritable: await probe.capabilities[0].ensureWritable(), newWritable: probe.capabilities.at(-1)!.current,
            oldWrite: probe.write(0), newWrite: probe.write(), writes: probe.writes, mountsWritable: probe.mountsWritable,
            backupBeforeDiscard: probe.events.indexOf("backup:done") < probe.events.indexOf("discard"),
        };
    });
    expect(after).toMatchObject({ backups: 1, discards: 1, backedUpDrafts: ["old unsaved draft to export before reload"], discardSnapshots: ["latest graph saved by the other editor"], capabilityCount: 2, oldWritable: false, oldEnsureWritable: false, newWritable: true, oldWrite: false, newWrite: true, writes: 1, backupBeforeDiscard: true });
    expect(after.mountsWritable.every(Boolean)).toBe(true);
    await expect(second.locator("[data-canvas-edit-blocked=true]")).toHaveCount(1);
});
