// From web/: bun build scripts/mark-usage-browser-qa.mjs --target=node --packages=external '--external=/src/*' --outfile=../output/mark-usage-qa/runner.mjs
// node ../output/mark-usage-qa/runner.mjs. Independent browser; every API request is fulfilled locally. Zero provider traffic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog.ts";
const { chromium } = createRequire(path.resolve(process.cwd(), "../labs/design-workbench/package.json"))("playwright");
const origin = "http://127.0.0.1:5190", output = path.resolve(process.cwd(), "../output/mark-usage-qa");
await fs.mkdir(output, { recursive: true });
const accountA = "e9000000-0000-4000-8000-000000000001", accountB = "e9000000-0000-4000-8000-000000000002";
let owner = accountA, enterprise = true, disabledAssets = false, authenticated = true;
const models = [{ id: "d5000000-0000-4000-8000-000000000001", modelId: "d5000000-0000-4000-8000-000000000001", name: "aplmart-gpt2.5", publicName: "aplmart-gpt2.5", publicDescription: "高清出图与精细编辑", providerName: "APIMart", capabilities: ["generate", "edit", "batch"], imageParameterProfile: "quality-resolution", imageSupportsMask: true, creditCost: 0, rmbCost: 0 }];
const report = { startedAt: new Date().toISOString(), scope: "Real isolated Chrome UI with all API calls intercepted; account sessions and analytics are mocked. No real authorization, server persistence or provider call is claimed.", scenarios: [], batches: [], paid: [], unexpectedWrites: [], external: [], errors: [] };
const rows = new Map();
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, serviceWorkers: "block" });
await context.routeWebSocket("**/*", socket => socket.close());
const page = await context.newPage(); page.setDefaultTimeout(15000);
page.on("pageerror", error => report.errors.push(error.message));
await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { report.external.push({ pathname, method }); return route.abort("blockedbyclient"); }
    if (!pathname.startsWith("/api/")) return ["GET", "HEAD"].includes(method) ? route.continue() : route.abort("blockedbyclient");
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (pathname === "/api/deployment") return json({ authenticationEnabled: enterprise, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: enterprise });
    if (pathname === "/api/auth/session") return authenticated ? json({ user: { id: owner, username: "usage-qa", displayName: owner === accountA ? "使用分析 QA A" : "使用分析 QA B", role: "designer", status: "active", mustChangePassword: false, creditBalance: 999, departmentId: null, groupId: null } }) : json({ code: "UNAUTHENTICATED" }, 401);
    if (pathname === "/api/models") return json({ models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) });
    if (pathname === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: item.moduleKey !== "assets" || !disabledAssets })) });
    if (pathname === "/api/usage/events" && method === "POST") {
        const payload = request.postDataJSON(); assert(Array.isArray(payload.events) && payload.events.length <= 50);
        report.batches.push({ owner, events: payload.events }); let accepted = 0;
        for (const event of payload.events) { if (!rows.has(`${owner}:${event.eventId}`)) { rows.set(`${owner}:${event.eventId}`, { owner, ...event }); accepted++; } }
        return json({ code: 0, data: { accepted, duplicates: payload.events.length - accepted }, msg: "" });
    }
    if (pathname === "/api/usage/me") {
        const counts = {}; for (const row of rows.values()) if (row.owner === owner && row.action === "visit") counts[row.boardKey] = (counts[row.boardKey] || 0) + 1;
        return json({ code: 0, data: { boards: Object.entries(counts).map(([key, count]) => ({ key, label: key, count })), controls: [], coverage: { collectionStartedAt: new Date().toISOString(), historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, notes: [] } }, msg: "" });
    }
    if (/\/tasks|\/responses|\/batch|\/chat\/(?:completions|image)|\/video|\/audio/.test(pathname) && method !== "GET") { report.paid.push({ pathname, method }); return json({ code: "QA_BLOCKED" }, 403); }
    if (!["GET", "HEAD"].includes(method)) { report.unexpectedWrites.push({ pathname, method }); return json({ code: "QA_BLOCKED" }, 403); }
    if (pathname === "/api/assets") return json({ assets: [], total: 0, page: 1, pageSize: 50 });
    if (pathname === "/api/projects") return json({ projects: [] });
    if (pathname === "/api/prompt-templates") return json({ templates: [], total: 0, page: 1, pageSize: 50 });
    if (pathname.includes("tasks")) return json({ tasks: [], total: 0 });
    return json({});
});
const allEvents = () => report.batches.flatMap(batch => batch.events.map(event => ({ ...event, owner: batch.owner })));
const flush = async () => { await page.evaluate(async () => { const url = performance.getEntriesByType("resource").map(item => item.name).find(value => new URL(value).pathname === "/src/stores/use-usage-store.ts"); if (url) await (await import(url)).flushUsage(); }); };
const state = () => page.evaluate(async () => { const url = performance.getEntriesByType("resource").map(item => item.name).find(value => new URL(value).pathname === "/src/stores/use-usage-store.ts"); return (await import(url)).useUsageStore.getState(); });
const waitCounts = async expected => { for (let i = 0; i < 100; i++) { const current = await state(); if (Object.entries(expected).every(([key, count]) => current.counts[key] === count)) return; await page.waitForTimeout(50); } assert.fail(`Counts did not settle: ${JSON.stringify(await state())}`); };
const selectModel = async () => { await page.locator('button[data-usage-control="model"]').first().click(); await page.getByRole("option", { name: "aplmart-gpt2.5 · 高清出图与精细编辑", exact: true }).click(); await page.locator('select[data-usage-control="resolution"]').first().waitFor(); await page.locator('select[data-usage-control="size"]').first().selectOption("1:1"); };
const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: "disabled" });
async function scenario(name, callback) { try { const detail = await callback(); report.scenarios.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); } catch (error) { await shot(`${name}-failure`).catch(() => {}); report.scenarios.push({ name, passed: false, error: error.message }); report.debug = await page.evaluate(async () => { const resources = performance.getEntriesByType("resource").map(item => item.name).filter(value => /(?:use-usage-store|use-user-store|deployment-features)\.ts/.test(value)); const modules = []; for (const url of resources) { const module = await import(url); modules.push({ url, state: module.useUsageStore?.getState() || module.useUserStore?.getState() || module.deploymentFeatures }); } const databases = await indexedDB.databases(); const saved = []; for (const database of databases.filter(item => item.name?.includes(":usage:"))) { saved.push(await new Promise(resolve => { const open = indexedDB.open(database.name); open.onsuccess = () => { const db = open.result; const request = db.transaction("usage").objectStore("usage").get("activity-v1"); request.onsuccess = () => { resolve({ name: database.name, state: request.result }); db.close(); }; }; })); } return { resources, modules, saved }; }).catch(error => ({ error: error.message })); throw error; } }
try {
    await scenario("01-entry-and-desktop-favorites", async () => {
        await page.goto(`${origin}/image`); await selectModel();
        await waitCounts({ image: 1 });
        await flush(); assert.equal(allEvents().filter(event => event.action === "visit" && event.boardKey === "image").length, 1, "StrictMode must not duplicate the initial visit");
        await page.getByRole("link", { name: "素材库", exact: true }).first().click(); await page.getByRole("heading", { name: "我的素材", exact: true }).waitFor();
        await page.getByRole("link", { name: "文生图", exact: true }).first().click(); await page.locator('[data-usage-control="resolution"]').first().waitFor();
        await page.getByRole("link", { name: "创意设计", exact: true }).first().click(); await waitCounts({ creative: 1 }); await page.getByRole("link", { name: "文生图", exact: true }).first().click(); await waitCounts({ image: 3 });
        await flush(); const current = await state(); assert.equal(current.counts.image, 3); assert.equal(current.counts.assets, 1); assert.equal(current.counts.creative, 1);
        const favorites = page.locator('aside section[aria-label="常用板块"]'); assert((await favorites.locator("a").first().getAttribute("href")) === "/image");
        const firstNavChild = await page.locator("aside nav").evaluate(element => element.firstElementChild?.getAttribute("aria-label")); assert.equal(firstNavChild, "常用板块");
        await shot("01-desktop-favorites"); return { counts: current.counts, initialVisits: 1, firstSection: firstNavChild };
    });
    await scenario("02-enum-parameters-and-private-inputs", async () => {
        await page.locator('select[data-usage-control="size"]').first().selectOption("3:2");
        await page.locator('select[data-usage-control="resolution"]').first().selectOption("2k");
        await page.locator('select[data-usage-control="quality"]').first().selectOption("high");
        await page.evaluate(() => {
            const box = document.createElement("section"); box.id = "usage-qa-probe"; box.style.cssText = "position:fixed;right:5px;bottom:5px;background:white;z-index:9999;padding:8px";
            box.innerHTML = '<button id="customer-name-987" aria-label="Private customer reference 987">UNREDACTED CUSTOMER BODY</button><input id="plain-probe"><textarea id="textarea-probe"></textarea><input type="password" id="password-probe"><input name="api_key" id="credential-probe"><div role="slider" tabindex="0" id="slider-probe">Slider</div><div draggable="true" id="drag-probe">Drag</div>';
            document.body.append(box);
            for (const id of ["plain-probe", "textarea-probe", "password-probe", "credential-probe"]) { const element = document.getElementById(id); Object.defineProperty(element, "value", { get() { throw new Error("COLLECTOR_READ_RAW_INPUT"); } }); element.dispatchEvent(new Event("change", { bubbles: true })); }
            document.getElementById("customer-name-987").click(); document.getElementById("password-probe").click(); document.getElementById("credential-probe").click();
        });
        await page.locator("#slider-probe").click(); await page.locator("#slider-probe").press("ArrowRight");
        await page.locator("#textarea-probe").focus(); await page.keyboard.type("arbitrary-text-key-events"); await page.keyboard.press("Control+z");
        await page.locator("#drag-probe").hover(); await page.mouse.down(); await page.mouse.move(1200, 800, { steps: 6 }); await page.mouse.up();
        await page.locator("#customer-name-987").focus(); await page.keyboard.press("Control+z"); await page.keyboard.press("Control+Shift+z");
        await flush(); const entries = allEvents();
        assert(entries.some(event => event.parameters?.resolution === "2K")); assert(entries.some(event => event.parameters?.quality === "high")); assert(entries.some(event => event.parameters?.aspectRatio === "3:2"));
        assert(entries.some(event => /^fallback:button:\d/.test(event.controlKey || ""))); assert(entries.some(event => event.controlKey === "drag"));
        assert.equal(entries.filter(event => event.controlKey === "undo").length, 1); assert.equal(entries.filter(event => event.controlKey === "redo").length, 1);
        const payload = JSON.stringify(entries); for (const forbidden of ["Private customer", "UNREDACTED", "customer-name", "arbitrary-text", "password-probe", "credential-probe", "plain-probe", "textarea-probe"]) assert(!payload.includes(forbidden));
        assert(!report.errors.some(error => error.includes("COLLECTOR_READ_RAW_INPUT"))); await page.locator("#usage-qa-probe").evaluate(element => element.remove());
        return { restrictedParameters: true, rawValueGetterReads: 0, fallbackControls: entries.filter(event => event.controlKey?.startsWith("fallback:")).length, dragCompletion: true, commandOnlyKeys: true };
    });
    await scenario("03-disabled-and-mobile-favorites", async () => {
        disabledAssets = true; await page.reload(); await page.locator('aside section[aria-label="常用板块"]').waitFor();
        await page.locator('aside section[aria-label="常用板块"] a[href="/assets"]').waitFor({ state: "detached" });
        assert.equal(await page.locator('aside section[aria-label="常用板块"] a[href="/assets"]').count(), 0);
        await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
        const drawer = page.locator(".ant-drawer-body"); await drawer.getByRole("region", { name: "常用板块" }).waitFor();
        assert.equal(await drawer.locator('section[aria-label="常用板块"] a').first().getAttribute("href"), "/image"); assert.equal(await drawer.locator('a[href="/assets"]').count(), 0);
        await shot("03-mobile-favorites"); await drawer.getByRole("link", { name: "创意设计（常用）", exact: true }).click(); await page.waitForURL("**/creative");
        await page.setViewportSize({ width: 1512, height: 1100 }); return { mobileNavigationFirst: true, disabledAssetsRemovedBoth: true };
    });
    await scenario("04-logout-and-account-isolation", async () => {
        await flush(); const before = report.batches.length;
        authenticated = false;
        await page.evaluate(async () => { const url = performance.getEntriesByType("resource").map(item => item.name).find(value => new URL(value).pathname === "/src/stores/use-user-store.ts"); const user = await import(url); window.dispatchEvent(new CustomEvent("business-model-usage", { detail: { action: "open" } })); await Promise.resolve(); user.useUserStore.getState().invalidateSession(); });
        await page.getByRole("heading", { name: "请从公司 OA 重新进入", exact: true }).waitFor(); await page.waitForTimeout(2200); assert.equal(report.batches.length, before, "No old queue may submit after logout");
        owner = accountB; authenticated = true;
        await page.goto(`${origin}/image`); await selectModel(); await waitCounts({ image: 1 });
        const b = await state(); assert.equal(b.owner, accountB); assert.equal(b.counts.image, 1); assert.equal(b.counts.assets, undefined); await flush();
        const ownVisits = {}; for (const event of allEvents()) if (event.owner === accountB && event.action === "visit") ownVisits[event.boardKey] = (ownVisits[event.boardKey] || 0) + 1;
        assert.deepEqual(b.counts, ownVisits, "B must contain only visits made as B, including the app's identity-boundary reload if it entered the previous route");
        return { accountBCounts: b.counts, accountBRecordedVisits: ownVisits, oldOwnerPostsAfterLogout: 0 };
    });
    await scenario("05-private-routes-and-trial-no-upload", async () => {
        await flush(); await page.goto(`${origin}/admin`); await page.waitForTimeout(150);
        assert(!allEvents().some(event => ["admin", "team", "performance", "login"].includes(event.boardKey)));
        enterprise = false; const before = report.batches.length; await page.goto(`${origin}/image`); await selectModel(); await page.locator('select[data-usage-control="resolution"]').first().selectOption("4k"); await flush(); await page.waitForTimeout(2100);
        assert.equal(report.batches.length, before); return { adminRouteExcluded: true, trialUploadCount: 0 };
    });
    assert.equal(report.paid.length, 0); assert.equal(report.unexpectedWrites.length, 0); assert.equal(report.errors.length, 0);
} finally {
    report.completedAt = new Date().toISOString(); report.upstreamCalls = 0;
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2)); await browser.close();
}
