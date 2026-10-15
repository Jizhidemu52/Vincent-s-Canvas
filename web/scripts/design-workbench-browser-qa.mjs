import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const origin = process.env.DESIGN_WORKBENCH_URL || "http://127.0.0.1:5188";
const output = path.resolve(process.cwd(), "../output/design-workbench-formal");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "chrome" });
const context = await browser.newContext({ viewport: { width: 1512, height: 1120 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [],
    requests = [],
    completed = [];
let identity = "local-workbench-qa-a";
const flags = { creative: true, "pattern-placement": true, "pattern-repeat": true, canvas: false };
const user = () => ({ id: identity, username: identity, displayName: "工作台隔离验证", role: "designer", status: "active", mustChangePassword: false, avatarUrl: "", groupId: null });
await context.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    requests.push({ path: pathname, method: route.request().method() });
    const json =
        pathname === "/api/deployment"
            ? { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false }
            : pathname === "/api/auth/session"
              ? { user: user() }
              : pathname === "/api/modules"
                ? { modules: Object.entries(flags).map(([moduleKey, enabled]) => ({ moduleKey, enabled })) }
                : pathname === "/api/models"
                  ? { models: [], prices: [], tools: [] }
                  : { code: 0, data: [], projects: [], documents: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
});
await page.addInitScript(() => {
    window.__localQa = { urls: new Set(), activeObservers: new Set() };
    const createUrl = URL.createObjectURL.bind(URL),
        revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        const url = createUrl(blob);
        window.__localQa.urls.add(url);
        return url;
    };
    URL.revokeObjectURL = (url) => {
        window.__localQa.urls.delete(url);
        return revokeUrl(url);
    };
    const OriginalObserver = ResizeObserver;
    window.ResizeObserver = class extends OriginalObserver {
        observe(target, ...args) {
            if (target.closest?.(".local-design-workbench")) window.__localQa.activeObservers.add(this);
            return super.observe(target, ...args);
        }
        disconnect() {
            window.__localQa.activeObservers.delete(this);
            return super.disconnect();
        }
    };
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
});
const button = (name) => page.getByRole("button", { name, exact: true });
const number = (name) => page.getByRole("spinbutton", { name, exact: true });
const pauseFor = (condition) => page.waitForFunction(condition);
async function numeric(name, value) {
    await number(name).fill(String(value));
    await number(name).press("Tab");
}
async function download(locator, filename) {
    const pending = page.waitForEvent("download");
    await locator.click();
    const artifact = await pending;
    const destination = path.join(output, filename);
    await artifact.saveAs(destination);
    return fs.readFile(destination);
}
async function switchUser(id) {
    identity = id;
    await page.evaluate(async (next) => {
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        useUserStore.getState().updateUser(next);
    }, user());
}
async function refreshFlags() {
    await page.evaluate(async () => {
        const { useModuleStore } = await import("/src/stores/use-module-store.ts");
        await useModuleStore.getState().refresh();
    });
}
async function assertCleanup() {
    await pauseFor(() => window.__localQa.activeObservers.size === 0 && window.__localQa.urls.size === 0);
}
try {
    await page.goto(origin + "/creative/pattern-placement");
    await button("胸前花朵").waitFor();
    assert.equal(await page.locator(".placement-layer").count(), 1);
    const image = await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 48;
        c.height = 24;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#b83345";
        ctx.fillRect(0, 0, 48, 24);
        return c.toDataURL("image/png").split(",")[1];
    });
    const fixture = { name: "qa-pattern.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") };
    await page.locator('[data-input="art"]').setInputFiles(fixture);
    await button("qa-pattern.png").waitFor();
    await numeric("图案宽度", 287);
    await numeric("旋转角度", 20);
    const canvas = page.locator(".placement-demo canvas");
    const box = await canvas.boundingBox(),
        size = await canvas.evaluate((c) => ({ width: c.width, height: c.height }));
    const x = Number(await number("横向 X").inputValue()),
        y = Number(await number("纵向 Y").inputValue());
    await page.mouse.move(box.x + (x / size.width) * box.width, box.y + (y / size.height) * box.height);
    await page.mouse.down();
    await page.mouse.move(box.x + (x / size.width) * box.width + 24, box.y + (y / size.height) * box.height + 12, { steps: 5 });
    await page.mouse.up();
    assert.ok(Number(await number("横向 X").inputValue()) > x + 10);
    await canvas.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await button("本地保存").click();
    await page.getByText(/本地已保存 ·/).waitFor();
    await numeric("图案宽度", 390);
    await button("打开本地工程").click();
    await pauseFor(() => document.querySelector('input[data-prop="width"]').value === "287");
    const png = await download(button("导出合成 PNG"), "placement.png");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    const savedProject = JSON.parse((await download(button("导出工程 JSON"), "placement.json")).toString());
    assert.equal(savedProject.type, "garment-pattern-placement");
    assert.equal(savedProject.layers.at(-1).width, 287);
    assert.match(savedProject.layers.at(-1).src, /^data:image\/png;base64,/);
    await button("删除").click();
    await page.locator('[data-input="project"]').setInputFiles({ name: "restore.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(savedProject)) });
    await button("qa-pattern.png").waitFor();
    await page.locator('[data-input="base"]').setInputFiles(fixture);
    await pauseFor(() => document.querySelector(".placement-demo canvas").width === 48);
    await button("撤销").click();
    assert.equal(await canvas.evaluate((c) => c.width), 1024);
    await page.screenshot({ path: path.join(output, "placement-desktop.png"), fullPage: true });
    completed.push("placement: upload artwork/base, scaled drag, keyboard move, numeric resize/rotation, undo, owner-local save/reopen, JSON import/export, actual 1024x1024 PNG");
    await switchUser("local-workbench-qa-b");
    await button("胸前花朵").waitFor();
    await button("打开本地工程").click();
    await page.getByRole("alert").filter({ hasText: "还没有本地工程" }).waitFor();
    assert.equal(await page.locator(".placement-layer").count(), 1);
    await switchUser("local-workbench-qa-a");
    await button("胸前花朵").waitFor();
    await button("打开本地工程").click();
    await button("qa-pattern.png").waitFor();
    assert.equal(await number("图案宽度").inputValue(), "287");
    flags["pattern-placement"] = false;
    await refreshFlags();
    await page.waitForURL(origin + "/");
    await assertCleanup();
    await page.goto(origin + "/creative/pattern-placement");
    await page.waitForURL(origin + "/");
    completed.push("placement: employee A/B isolation, account-return restore, module disable redirects and blocks direct URL, observer/object-URL cleanup");

    await page.goto(origin + "/creative/pattern-repeat");
    await page.locator('[data-testid="repeat-canvas"]').waitFor();
    await page.locator('[data-role="image-file"]').setInputFiles(fixture);
    await page.getByRole("button", { name: "8 qa-pattern", exact: true }).waitFor();
    const repeatCanvas = page.locator('[data-testid="repeat-canvas"]');
    const rb = await repeatCanvas.boundingBox();
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width / 2 + 22, rb.y + rb.height / 2 + 15, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-role="size"]').fill("0.4");
    await page.locator('[data-role="angle"]').fill("42");
    await page.locator('[data-testid="repeat-width"]').fill("5");
    await page.locator('[data-testid="repeat-width"]').press("Tab");
    await page.locator('[data-testid="repeat-height"]').fill("4");
    await page.locator('[data-testid="repeat-height"]').press("Tab");
    await page.locator('[data-testid="repeat-save"]').click();
    await page.locator('[data-role="status"]').filter({ hasText: "已保存" }).waitFor();
    await page.locator('[data-testid="repeat-mode-mirror"]').click();
    await page.locator('[data-testid="repeat-restore"]').click();
    await page.locator('[data-testid="repeat-mode-half"][aria-pressed="true"]').waitFor();
    const repeatPng = await download(page.locator('[data-testid="repeat-export-unit"]'), "repeat-half.png");
    assert.equal(repeatPng.readUInt32BE(16), 590);
    assert.equal(repeatPng.readUInt32BE(20), 236);
    const repeatJson = JSON.parse((await download(page.locator('[data-testid="repeat-export-json"]'), "repeat.json")).toString());
    assert.equal(repeatJson.elements.at(-1).angle, 42);
    assert.equal(repeatJson.elements.at(-1).size, 0.4);
    assert.ok(repeatJson.elements.at(-1).x > 0.5);
    assert.equal(repeatJson.metadata.pngDpiMetadata, false);
    await page.locator('[data-testid="repeat-mode-mirror"]').click();
    const mirror = await download(page.locator('[data-testid="repeat-export-unit"]'), "repeat-mirror.png");
    assert.equal(mirror.readUInt32BE(16), 590);
    assert.equal(mirror.readUInt32BE(20), 472);
    await page.locator('[data-role="json-file"]').setInputFiles({ name: "repeat.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(repeatJson)) });
    await page.locator('[data-testid="repeat-mode-half"][aria-pressed="true"]').waitFor();
    await page.locator('[data-testid="repeat-width"]').fill("60");
    await page.locator('[data-testid="repeat-width"]').press("Tab");
    assert.equal(await page.locator('[data-testid="repeat-export-unit"]').isDisabled(), true);
    await page.locator('[data-testid="repeat-restore"]').click();
    await page.locator('[data-testid="repeat-export-unit"]:enabled').waitFor();
    await page.screenshot({ path: path.join(output, "repeat-desktop.png"), fullPage: true });
    const lightBackground = await page.locator(".repeat-right").evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.evaluate(async () => {
        const { useThemeStore } = await import("/src/stores/use-theme-store.ts");
        useThemeStore.getState().setTheme("dark");
    });
    await page.waitForFunction((light) => getComputedStyle(document.querySelector(".repeat-right")).backgroundColor !== light, lightBackground);
    await page.screenshot({ path: path.join(output, "repeat-dark.png"), fullPage: true });
    await page.evaluate(async () => {
        const { useThemeStore } = await import("/src/stores/use-theme-store.ts");
        useThemeStore.getState().setTheme("light");
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, "repeat-mobile.png"), fullPage: true });
    const overflow = await page.locator(".local-design-workbench").evaluate((el) => el.scrollWidth > el.clientWidth + 2);
    assert.equal(overflow, false, "mobile workbench must not overflow horizontally");
    completed.push("repeat: upload, drag, scale/rotation, physical dimensions, save/restore, JSON import/export, actual half 590x236 and mirror 590x472 PNG, export bounds, dark theme and 390px layout");
    await switchUser("local-workbench-qa-b");
    await page.locator('[data-testid="repeat-restore"]').click();
    await page.getByRole("alert").filter({ hasText: "尚无存档" }).waitFor();
    flags["pattern-repeat"] = false;
    await refreshFlags();
    await page.waitForURL(origin + "/");
    await assertCleanup();
    await page.goto(origin + "/creative/pattern-repeat");
    await page.waitForURL(origin + "/");
    completed.push("repeat: employee partition isolation, disabled direct URL rejection, observer/object-URL cleanup");
    assert.deepEqual(errors, []);
    assert.equal(
        requests.some((item) => /tasks|generate|completions|admin/.test(item.path)),
        false,
    );
    await fs.writeFile(
        path.join(output, "report.json"),
        JSON.stringify({ passed: true, completed, errors, requests, scope: "Isolated browser context; all API requests fulfilled with test identity/config; no backend writes or paid generation." }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, completed, output }, null, 2));
} catch (error) {
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
    await fs.writeFile(path.join(output, "failure.json"), JSON.stringify({ message: error.message, errors, completed, url: page.url() }, null, 2));
    throw error;
} finally {
    await context.close();
    await browser.close();
}
