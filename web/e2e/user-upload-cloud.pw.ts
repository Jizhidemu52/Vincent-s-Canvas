import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, fixturePng, IMAGE, newCanvas, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const owner = "00000000-0000-4000-8000-000000000099";
const secondOwner = "00000000-0000-4000-8000-000000000088";

function cloud(api: MockCanvasApi) {
    const writes: Array<{ owner: string; metadata: Record<string, unknown>; clientReferenceId: string }> = [];
    const lists: Array<{ owner: string; cursor: string | null; limit: string | null }> = [];
    let failUpload = false;
    const attach = async (context: BrowserContext, employee = owner) => {
        if (employee !== owner) await context.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: employee, username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }));
        await context.route("**/api/assets**", async route => {
            const request = route.request(), url = new URL(request.url()), path = url.pathname;
            if (path === "/api/assets/upload-request") {
                const input = request.postDataJSON();
                expect(request.headers()["x-canvas-owner-id"]).toBe(employee);
                writes.push({ owner: employee, metadata: input.metadata, clientReferenceId: input.clientReferenceId });
                if (failUpload) return route.fulfill({ status: 503, json: { message: "原件暂时无法保存，请重试" } });
                const existing = [...api.assets.values()].find(asset => asset.ownerUserId === employee && asset.clientReferenceId === input.clientReferenceId);
                if (existing) return route.fulfill({ json: { assetId: existing.id, uploadUrl: null, reused: true } });
                const id = randomUUID();
                api.assets.set(id, { ...input, id, ownerUserId: employee, ownerName: employee, status: "uploading", source: "upload", visibilityScope: "private", createdAt: new Date().toISOString(), contentUrl: `/api/assets/${id}/content`, thumbnailUrl: `/api/assets/${id}/thumb?w=256`, resultStatus: "unused", eventCount: 0, downloadCount: 0, usabilityScore: 0 });
                return route.fulfill({ json: { assetId: id, uploadUrl: `/api/assets/${id}/upload` } });
            }
            if (path === "/api/assets") {
                lists.push({ owner: employee, cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") });
                return route.fulfill({ json: { assets: [...api.assets.values()].filter(asset => asset.ownerUserId === employee && asset.status === "ready").reverse(), nextCursor: null, hasMore: false } });
            }
            const match = /^\/api\/assets\/([^/]+)(?:\/(upload|content|thumb))?$/.exec(path);
            if (!match) return route.fallback();
            const asset = api.assets.get(match[1]!);
            if (!asset || asset.ownerUserId !== employee) return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
            if (match[2] === "upload") {
                api.assetBytes.set(asset.id, request.postDataBuffer()!); asset.status = "ready";
                return route.fulfill({ json: {} });
            }
            if (match[2] === "content" || match[2] === "thumb") return route.fulfill({ contentType: "image/png", body: api.assetBytes.get(asset.id)! });
            return route.fulfill({ json: { asset } });
        });
    };
    return { attach, writes, lists, fail: (value: boolean) => { failUpload = value; } };
}

async function upload(page: Page, trigger: Locator, name: string, bytes = IMAGE) {
    const pending = page.waitForEvent("filechooser"); await trigger.click();
    await (await pending).setFiles({ name, mimeType: "image/png", buffer: bytes });
}

async function original(image: Locator, bytes = IMAGE) {
    await expect(image).toBeVisible();
    expect(Buffer.from(await image.evaluate(async (element: HTMLImageElement) => [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())]))).toEqual(bytes);
}

test("upload without generation reaches an independent browser and owner isolation, then reuses one cloud original", async ({ page, context, api, baseURL }, info) => {
    const server = cloud(api); await server.attach(context);
    const independentBrowser = await chromium.launch();
    const remoteContext = await independentBrowser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const otherContext = await independentBrowser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    try {
        await api.attach(remoteContext); await server.attach(remoteContext);
        await api.attach(otherContext); await server.attach(otherContext, secondOwner);
        const remote = await remoteContext.newPage(), other = await otherContext.newPage();
        await remote.goto("/assets"); await other.goto("/assets");
        await expect(remote.getByRole("heading", { name: "素材库", exact: true })).toBeVisible();
        expect(await remote.evaluate(async () => {
            let count = 0;
            for (const database of await indexedDB.databases()) {
                if (!database.name) continue;
                count += await new Promise<number>((resolve, reject) => {
                    const opening = indexedDB.open(database.name!);
                    opening.onerror = () => reject(opening.error);
                    opening.onsuccess = () => {
                        const db = opening.result;
                        if (!db.objectStoreNames.contains("image_files")) { db.close(); resolve(0); return; }
                        const read = db.transaction("image_files", "readonly").objectStore("image_files").count();
                        read.onsuccess = () => { db.close(); resolve(read.result); };
                        read.onerror = () => { db.close(); reject(read.error); };
                    };
                });
            }
            return count;
        })).toBe(0);
        await page.goto("/image?tool=image-edit");
        await upload(page, page.getByRole("button", { name: "上传图片", exact: true }).first(), "只上传不生成.png");
        await original(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "只上传不生成.png", exact: true }));
        expect(api.submissions).toHaveLength(0); expect(server.writes).toHaveLength(1);
        await expect(remote.getByText("只上传不生成.png", { exact: true }).first()).toBeVisible({ timeout: 27_000 });
        expect(server.lists.every(read => read.cursor === null && (read.limit === "60" || read.limit === null))).toBe(true);
        const id = [...api.assets.keys()][0]!;
        expect(await remote.evaluate(async id => [...new Uint8Array(await (await fetch(`/api/assets/${id}/content`)).arrayBuffer())], id)).toEqual([...IMAGE]);
        await remote.screenshot({ path: info.outputPath("independent-browser-assets.png"), animations: "disabled" });
        await remote.reload(); await expect(remote.getByText("只上传不生成.png", { exact: true }).first()).toBeVisible();
        await expect(other.getByText("只上传不生成.png", { exact: true })).toHaveCount(0);
        expect(await other.evaluate(async id => (await fetch(`/api/assets/${id}/content`)).status, id)).toBe(404);
        await page.reload();
        await original(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "只上传不生成.png", exact: true }));
        await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("保留原图构图，仅将背景改为浅色");
        await page.getByRole("button", { name: "开始编辑", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        expect(api.submissions[0]!.sourceUrls).toEqual([`/api/assets/${id}/content`]);
        expect(server.writes).toHaveLength(1);
        await page.screenshot({ path: info.outputPath("source-reused-for-generation.png"), animations: "disabled" });
    } finally { await independentBrowser.close(); }
});

test("picker cloud failure never inserts local-only success and explicit retry saves once", async ({ page, context, api }, info) => {
    const server = cloud(api); await server.attach(context); server.fail(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/image?tool=image-edit");
    await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
    const trigger = dialog.getByRole("button", { name: "从相册 / 本机上传", exact: true });
    await upload(page, trigger, "失败后重试.png");
    await expect(dialog.getByText("原件暂时无法保存，请重试", { exact: true })).toBeVisible();
    expect(api.assets.size).toBe(0); expect(api.submissions).toHaveLength(0);
    await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("cloud-upload-failure-mobile.png"), animations: "disabled" });
    server.fail(false); await upload(page, trigger, "失败后重试.png");
    await expect(dialog).not.toBeVisible();
    await original(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "失败后重试.png", exact: true }));
    expect(api.assets.size).toBe(1); expect(server.writes).toHaveLength(2); expect(api.submissions).toHaveLength(0);
});

test("video and creative uploads save exact originals before any generation", async ({ page, context, api }, info) => {
    const server = cloud(api); await server.attach(context);
    const model = { id: "10000000-0000-4000-8000-000000000003", name: "隔离视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
    await context.route("**/api/models", route => route.fulfill({ json: { models: [model], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })), prices: [] } }));
    await page.goto("/video"); await upload(page, page.getByRole("button", { name: "上传图片 · 首帧 / 尾帧", exact: true }), "视频首帧.png");
    await original(page.getByRole("img", { name: "视频首帧.png", exact: true }));
    await page.goto("/creative/virtual-try-on");
    const product = page.getByRole("region", { name: "产品图", exact: false });
    await upload(page, product.locator(".cs-upload-control"), "创意产品图.png", fixturePng(80));
    await original(product.getByRole("img", { name: "创意产品图.png", exact: true }), fixturePng(80));
    expect(api.assets.size).toBe(2); expect(server.writes).toHaveLength(2); expect(api.submissions).toHaveLength(0);
    await page.goto("/assets");
    await expect(page.getByText("视频首帧.png", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("创意产品图.png", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("video-and-creative-originals.png"), animations: "disabled" });
});

test("additional seamless and local workbench uploads preserve originals without generation and reject cloud failures", async ({ page, context, api }, info) => {
    const server = cloud(api); await server.attach(context);
    await page.goto("/image?tool=seamless-stitch");
    await upload(page, page.getByRole("button", { name: "上传", exact: true }), "拼接原件.png");
    await original(page.getByRole("img", { name: "拼接原件.png", exact: true }));
    await page.goto("/creative/pattern-placement");
    await expect(page.getByRole("combobox", { name: "本地工程" })).toBeEnabled();
    await upload(page, page.getByRole("button", { name: "替换服装底图", exact: true }), "定位原件.png", fixturePng(80));
    await expect(page.locator(".placement-base-name")).toHaveText("定位原件.png");
    server.fail(true);
    await upload(page, page.getByRole("button", { name: "替换服装底图", exact: true }), "失败原件.png", fixturePng(90));
    await expect(page.getByRole("alert")).toContainText("原件暂时无法保存，请重试");
    await expect(page.locator(".placement-base-name")).toHaveText("定位原件.png");
    server.fail(false);
    await page.goto("/creative/pattern-repeat");
    await expect(page.getByRole("combobox", { name: "本地工程" })).toBeEnabled();
    await upload(page, page.getByTestId("repeat-upload"), "循环原件.png", fixturePng(100));
    await expect(page.getByText("元素已加入。文件原有透明度保留，不自动去背景。", { exact: true })).toBeVisible();
    expect([...api.assetBytes.values()]).toEqual([IMAGE, fixturePng(80), fixturePng(100)]);
    expect(server.writes.map(write => write.metadata.source)).toEqual(["seamless-stitch-reference", "design-workbench-reference", "design-workbench-reference", "design-workbench-reference"]);
    expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0);
    await page.goto("/assets");
    for (const name of ["拼接原件.png", "定位原件.png", "循环原件.png"]) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("additional-tools-originals.png"), animations: "disabled" });
});

test("additional local Agent archives file and pasted images while preserving the local turn protocol", async ({ page, context, api }, info) => {
    const server = cloud(api); await server.attach(context);
    const streams = new Set<ServerResponse>(), turns: Array<{ attachments: Array<{ dataUrl: string }> }> = [];
    const agent = createServer(async (request, response) => {
        response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); response.setHeader("Access-Control-Allow-Headers", "content-type"); response.setHeader("Access-Control-Allow-Private-Network", "true");
        if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
        const path = new URL(request.url!, "http://fixture").pathname;
        if (path === "/events") { streams.add(response); response.once("close", () => streams.delete(response)); response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }); response.write("event: hello\ndata: {}\n\n"); return; }
        if (path === "/agent/codex/turn") {
            const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); turns.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, data: [], threadId: "local-fixture-thread" }));
    });
    await new Promise<void>(resolve => agent.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
    await context.route(`${endpoint}/**`, route => route.continue());
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    try {
        await newCanvas(page); await page.getByRole("tab", { name: "对话", exact: true }).first().click();
        const panel = page.locator(".cw-agent-panel");
        await panel.getByRole("button", { name: "对话选项", exact: true }).click();
        await page.getByRole("menuitem", { name: "本机 Agent", exact: true }).click();
        await panel.getByRole("tablist", { name: "Agent 面板", exact: true }).getByRole("tab", { name: "连接", exact: true }).click();
        await panel.getByPlaceholder("例如 http://127.0.0.1:17371", { exact: true }).fill(endpoint);
        await panel.getByPlaceholder("自动发现，或手动填入 Connect token", { exact: true }).fill("isolated-e2e-token");
        await panel.getByRole("button", { name: /^连\s*接$/ }).click();
        await expect(panel.getByText("已连接", { exact: true })).toBeVisible();
        await panel.getByRole("tablist", { name: "Agent 面板", exact: true }).getByRole("tab", { name: "对话", exact: true }).click();
        await upload(page, panel.getByRole("button", { name: "添加参考图", exact: true }), "本机附件原件.png");
        await original(panel.getByRole("img", { name: "本机附件原件.png", exact: true }));
        const composer = panel.getByPlaceholder("询问 Codex，或让它操作画布", { exact: true });
        await composer.evaluate((element, bytes) => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "粘贴原件.png", { type: "image/png" })); element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); }, [...fixturePng(80)]);
        await expect.poll(() => api.assetBytes.size).toBe(2);
        await expect(panel.getByRole("img")).toHaveCount(2);
        await page.screenshot({ path: info.outputPath("local-agent-originals-before-send.png"), animations: "disabled" });
        await composer.fill("只测试传输格式，不调用任何模型");
        await panel.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => turns.length).toBe(1);
        expect(turns[0]!.attachments.map(item => Buffer.from(item.dataUrl.split(",")[1]!, "base64"))).toEqual([IMAGE, fixturePng(80)]);
        expect([...api.assetBytes.values()]).toEqual([IMAGE, fixturePng(80)]);
        expect(server.writes.every(write => write.metadata.source === "canvas-local-agent-reference")).toBe(true);
        expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0);
    } finally { await page.close(); for (const stream of streams) stream.destroy(); agent.closeAllConnections(); await new Promise<void>(resolve => agent.close(() => resolve())); }
});
