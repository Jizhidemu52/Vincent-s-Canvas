// node smoke.mjs <playwright/index.mjs> <chromium.exe> [vite-origin]
// Fresh temporary profile only; mock API responses, never a live user's assets.
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const extension = path.dirname(fileURLToPath(import.meta.url));
const origin = process.argv[4] || "http://127.0.0.1:3391";
const profile = await mkdtemp(path.join(tmpdir(), "canvas-reference-smoke-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const source = createServer((req, res) => {
    if (req.url.startsWith("/image")) { res.writeHead(200, { "content-type": "image/png" }); res.end(png); }
    else { res.writeHead(200, { "content-type": "text/html;charset=utf-8" }); res.end('<!doctype html><title>测试参考网页</title><h1>参考图片</h1><img alt="测试原图" src="/image.png?token=private#fragment"><img alt="相同内容不同地址" src="/image-copy.png"><img alt="未勾选" src="/image-unselected.png">'); }
});
await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
const testExtension = path.join(profile, "extension-fixture");
await cp(extension, testExtension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(testExtension, "manifest.json"), "utf8"));
// Test-fixture only: headless Chrome cannot drive its native optional-permission
// dialog. Pregrant the two local fixture hosts, retaining production code.
manifest.host_permissions = [`${origin}/*`, `${sourceOrigin}/*`];
await writeFile(path.join(testExtension, "manifest.json"), JSON.stringify(manifest));
let context;
try {
    context = await chromium.launchPersistentContext(path.join(profile, "browser"), { executablePath: process.argv[3], headless: true, args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const apiRequests = [], uploads = [];
    let serverOwner = "reference-test-a", failedPuts = 0;
    await context.route(`${origin}/api/**`, async route => {
        const request = route.request(); const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/deployment") return route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: true } });
        if (pathname === "/api/auth/session") return route.fulfill({ json: { user: { id: serverOwner, role: "designer", displayName: "采集测试员工", username: "reference-test", status: "active", mustChangePassword: false } } });
        if (pathname === "/api/modules") return route.fulfill({ json: { modules: ["assets", "canvas"].map(moduleKey => ({ moduleKey, enabled: true })) } });
        if (pathname === "/api/assets/upload-request") { apiRequests.push({ body: request.postDataJSON(), owner: request.headers()["x-canvas-owner-id"] }); return route.fulfill({ json: { assetId: "reference-test-asset", uploadUrl: "/api/assets/reference-test-asset/content" } }); }
        if (request.method() === "PUT") { if (failedPuts > 0) { failedPuts--; return route.fulfill({ status: 503, json: { message: "测试上传暂时失败" } }); } uploads.push(request.postDataBuffer()); return route.fulfill({ status: 204 }); }
        return route.fulfill({ json: { assets: [], projects: [], tasks: [], groups: [], departments: [], providers: [], models: [], items: [] } });
    });
    const sourceTab = await worker.evaluate(async url => chrome.tabs.create({ url }), `${sourceOrigin}/?secret=page#fragment`);
    const collector = await context.newPage();
    await collector.goto(`chrome-extension://${extensionId}/collector.html?sourceTab=${sourceTab.id}`);
    await collector.locator("#origin").fill(origin);
    const permission = await collector.evaluate(async origins => chrome.permissions.contains({ origins }), [`${origin}/*`, `${sourceOrigin}/*`]);
    console.log("PERMISSION", permission);
    if (!permission) throw new Error("Optional host permission requires native Chrome approval; rerun this isolated profile headed and approve only the two local origins.");
    await collector.locator("#scan").click();
    await collector.locator('.tile input').first().waitFor();
    assert.equal(await collector.locator('.tile input').count(), 3);
    await collector.locator('.tile input').nth(0).check();
    await collector.locator('.tile input').nth(1).check();
    await collector.locator("#send").click();
    await collector.getByText("已送达审核页（尚未入库）", { exact: true }).waitFor({ timeout: 60000 });
    const review = context.pages().find(page => page.url().startsWith(`${origin}/reference-import`));
    assert.ok(review);
    await review.getByRole("button", { name: "确认导入 1 张" }).waitFor();
    assert.equal(apiRequests.length, 0, "Receiving must never upload automatically");
    assert.equal(await review.locator("article").count(), 1, "Identical original bytes deduplicated");
    await collector.locator("#send").click();
    await collector.getByText("已送达 1 张。", { exact: false }).waitFor();
    assert.equal(await review.locator("article").count(), 1, "Transport retry must not duplicate drafts");
    await review.getByRole("button", { name: "确认导入 1 张" }).click();
    await review.getByText("已成功 1 张", { exact: true }).waitFor();
    assert.equal(apiRequests.length, 1); assert.equal(uploads.length, 1); assert.deepEqual(uploads[0], png);
    assert.equal(apiRequests[0].owner, "reference-test-a");
    assert.equal(apiRequests[0].body.metadata.sourceImageUrl, `${sourceOrigin}/image.png`);
    assert.equal(apiRequests[0].body.metadata.sourcePageUrl, `${sourceOrigin}/`);
    assert.ok(apiRequests[0].body.clientReferenceId.startsWith("web-reference-"));
    const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const second = { id: "second-image", name: "第二张", mime: "image/gif", base64: gif, sourcePage: `${sourceOrigin}/`, sourceImage: `${sourceOrigin}/second.gif`, pageTitle: "测试" };
    const post = async (image, wrongNonce = false) => review.evaluate(({ image, wrongNonce }) => {
        window.postMessage({ channel: "canvas-reference-import/v1", nonce: wrongNonce ? "not-the-nonce" : new URLSearchParams(location.hash.slice(1)).get("referenceNonce"), requestId: "test-message", type: "image", image }, location.origin);
    }, { image, wrongNonce });
    await post(second, true); await review.waitForTimeout(100);
    assert.equal(await review.locator("article").count(), 1, "Wrong nonce rejected");
    await post(second); await review.getByRole("button", { name: "确认导入 1 张" }).waitFor();
    assert.equal(apiRequests.length, 1, "Second receipt still requires user confirmation");
    serverOwner = "reference-test-b";
    await review.getByRole("button", { name: "确认导入 1 张" }).click();
    await review.getByText("员工会话已变化，已停止导入", { exact: true }).waitFor();
    assert.equal(apiRequests.length, 1, "Changed server owner must stop before upload");
    serverOwner = "reference-test-a"; failedPuts = 1;
    await review.getByRole("button", { name: "确认导入 1 张" }).click();
    await review.getByText("测试上传暂时失败", { exact: true }).waitFor();
    assert.equal(apiRequests.length, 2);
    await review.getByRole("button", { name: "确认导入 1 张" }).click();
    await review.getByText("已成功 2 张", { exact: true }).waitFor();
    assert.equal(apiRequests.length, 3);
    assert.equal(apiRequests[1].body.clientReferenceId, apiRequests[2].body.clientReferenceId, "Upload retry must reuse client reference");
    assert.deepEqual(uploads[1], Buffer.from(gif, "base64"), "GIF animation bytes remain unchanged");
    await review.setViewportSize({ width: 390, height: 844 });
    assert.equal(await review.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const output = path.resolve(extension, "../../output/reference-import-smoke"); await mkdir(output, { recursive: true });
    await review.screenshot({ path: path.join(output, "review-mobile.png"), fullPage: true });
    await review.setViewportSize({ width: 1280, height: 900 });
    await review.screenshot({ path: path.join(output, "review-desktop.png"), fullPage: true });
    await collector.screenshot({ path: path.join(output, "collector.png"), fullPage: true });
    console.log(JSON.stringify({ ok: true, extensionId, checks: ["real MV3 load", "DOM scan", "selected images only", "byte deduplication", "nonce+ack transport", "wrong nonce rejected", "no automatic upload", "retry idempotence", "original PNG/GIF upload bytes", "expectedOwnerId", "server employee switch stops uploads", "failed PUT retry retains clientReferenceId", "URL sanitization", "mobile overflow"], limitations: ["Local fixture hosts pregranted in temporary manifest; native optional-permission dialog and toolbar activeTab gesture require manual verification", "Server authentication/upload responses mocked; no real OA account used"] }));
} finally {
    await context?.close(); await new Promise(resolve => source.close(resolve));
    // Exact directory returned by mkdtemp under the OS temp directory, owned by this run.
    if (path.dirname(profile) === tmpdir() && path.basename(profile).startsWith("canvas-reference-smoke-")) await rm(profile, { recursive: true, force: true });
}
