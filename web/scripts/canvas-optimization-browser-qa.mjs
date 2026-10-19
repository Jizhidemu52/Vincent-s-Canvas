// Run from web with Node 22+ (native TypeScript stripping). Local Vite; all APIs mocked.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog.ts";
const { chromium } = createRequire(path.resolve("../labs/design-workbench/package.json"))("playwright");
const origin = process.env.CANVAS_QA_URL || "http://127.0.0.1:5199";
const output = path.resolve("../output/canvas-optimization-qa");
await fs.mkdir(output, { recursive: true });
const report = { scope: "250 nodes; isolated local browser; mocked APIs; no provider calls", checks: [], errors: [], blocked: [], submissions: [] };
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
await context.routeWebSocket("**/*", socket => socket.close());
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on("pageerror", error => report.errors.push(error.message));
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==", "base64");
const model = { id: "10000000-0000-4000-8000-000000000001", name: "QA GPT Image", modelId: "gpt-image-2", providerName: "Mock", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
const tasks = new Map();
await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname, method = request.method();
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { report.blocked.push(url.origin); return route.abort(); }
    if (!pathname.startsWith("/api/")) return route.continue();
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (pathname === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    if (pathname === "/api/auth/session") return json({ user: { id: "local-optimization-qa", username: "qa", displayName: "本地隔离验证", role: "designer", status: "active", mustChangePassword: false, creditBalance: 999 } });
    if (pathname === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
    if (pathname === "/api/models") return json({ models: [model], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) });
    if (pathname === "/api/tasks" && method === "POST") {
        const input = request.postDataJSON(); report.submissions.push(input);
        const task = { ...input, id: crypto.randomUUID(), status: "success", resultUrls: ["/api/assets/20000000-0000-4000-8000-000000000001/content"], createdAt: new Date().toISOString(), failureReason: null };
        tasks.set(task.id, task); return json({ task }, 201);
    }
    if (pathname === "/api/tasks") return json({ tasks: [...tasks.values()], nextCursor: null });
    if (pathname.startsWith("/api/tasks/")) return json({ task: tasks.get(pathname.split("/").at(-1)) });
    if (/^\/api\/assets\/[^/]+\/(content|thumb)$/.test(pathname)) return route.fulfill({ status: 200, contentType: "image/png", body: image });
    if (pathname === "/api/assets/upload-request") return json({ assetId: crypto.randomUUID(), uploadUrl: "/api/qa-upload" });
    if (pathname === "/api/qa-upload") return json({});
    if (pathname === "/api/projects/sync") return json({ project: { id: "local-optimization-qa" } });
    return json({ code: 0, data: [], models: [], assets: [], projects: [], documents: [], history: [], tasks: [], total: 0, nextCursor: null });
});
const saved = () => page.evaluate(async () => {
    const { readCanvasProjects } = await import("/src/lib/canvas/canvas-project-storage.ts");
    return (await readCanvasProjects("wireless-canvas:canvas_store")).find(project => project.id === location.pathname.split("/").at(-1));
});
const until = async check => { const end = Date.now() + 20000; while (!await check()) { if (Date.now() > end) throw new Error("QA state condition timed out"); await new Promise(resolve => setTimeout(resolve, 60)); } };
const step = async (name, fn) => { console.log(name); await fn(); report.checks.push(name); };
try {
    await page.goto(origin + "/canvas");
    await page.getByRole("button", { name: "新建画布", exact: true }).first().waitFor();
    await page.waitForFunction(async () => (await import("/src/stores/canvas/use-canvas-store.ts")).useCanvasStore.getState().hydrated);
    const id = await page.evaluate(async () => {
        const { useCanvasStore, flushCanvasPersistence } = await import("/src/stores/canvas/use-canvas-store.ts");
        const nodes = Array.from({ length: 250 }, (_, i) => ({ id: `qa-node-${i}`, type: "text", title: `验证节点 ${i + 1}`, position: { x: 80 + i % 25 * 220, y: 140 + Math.floor(i / 25) * 140 }, width: 180, height: 100, metadata: { content: `第 ${i + 1} 个节点`, status: "idle" } }));
        const id = useCanvasStore.getState().importProject({ title: "250 节点优化验收", nodes, connections: nodes.slice(1).map((node, i) => ({ id: `qa-edge-${i}`, fromNodeId: nodes[i].id, toNodeId: node.id })), viewport: { x: 0, y: 0, k: 1 } });
        await flushCanvasPersistence(); return id;
    });
    await page.goto(`${origin}/canvas/${id}`);
    const node = page.locator('[data-node-id="qa-node-0"]');
    await node.waitFor();
    await step("250-node graph loads and visible-node virtualization remains active", async () => {
        assert.equal((await saved()).nodes.length, 250);
        const visible = await page.locator("[data-node-id]").count();
        assert.ok(visible > 0 && visible < 250); report.visibleNodes = visible;
    });
    await step("real pointer drag, undo and redo persist exact positions", async () => {
        const box = await node.boundingBox();
        await page.mouse.move(box.x + 50, box.y + 35); await page.mouse.down();
        await page.mouse.move(box.x + 130, box.y + 75, { steps: 8 }); await page.mouse.up();
        await until(async () => (await saved()).nodes[0].position.x > 130);
        const dragged = (await saved()).nodes[0].position;
        await page.keyboard.press("Control+z");
        await until(async () => (await saved()).nodes[0].position.x === 80);
        await page.keyboard.press("Control+Shift+z");
        await until(async () => (await saved()).nodes[0].position.x === dragged.x);
    });
    await step("native node clipboard, duplicate, select-all delete and undo", async () => {
        await page.keyboard.down("Control");
        await page.mouse.move(50, 120); await page.mouse.down();
        await page.mouse.move(730, 260, { steps: 8 }); await page.mouse.up();
        await page.keyboard.up("Control");
        await until(async () => await page.locator("[data-node-id].z-50").count() >= 2);
        report.marqueeSelectedNodes = await page.locator("[data-node-id].z-50").count();
        await page.keyboard.press("Escape");
        await node.click({ position: { x: 50, y: 35 } });
        await page.keyboard.press("Control+c"); await page.keyboard.press("Control+v");
        await until(async () => (await saved()).nodes.length === 251);
        await page.keyboard.press("Control+z"); await until(async () => (await saved()).nodes.length === 250);
        await node.click({ position: { x: 50, y: 35 } }); await page.keyboard.press("Control+d");
        await until(async () => (await saved()).nodes.length === 251);
        await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
        await until(async () => (await saved()).nodes.length === 0);
        await page.keyboard.press("Control+z"); await until(async () => (await saved()).nodes.length === 251);
    });
    await step("zoom presets, image file import and autosave across reload", async () => {
        await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
        await page.getByRole("button", { name: "25%", exact: true }).click();
        await until(async () => Math.round((await saved()).viewport.k * 100) === 25);
        await page.getByRole("button", { name: "100%", exact: true }).click();
        await page.keyboard.press("Escape");
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "上传素材", exact: true }).click();
        await (await chooser).setFiles({ name: "local-qa.png", mimeType: "image/png", buffer: image });
        await until(async () => (await saved()).nodes.some(n => n.type === "image"));
        const count = (await saved()).nodes.length;
        await page.evaluate(async () => { const m = await import("/src/stores/canvas/use-canvas-store.ts"); await m.flushCanvasPersistence(); });
        await page.reload(); await node.waitFor();
        assert.equal((await saved()).nodes.length, count);
    });
    await step("generation runtime reaches success with mocked API only", async () => {
        await page.keyboard.press("Escape");
        await page.getByRole("tab", { name: "创建", exact: true }).click();
        const prompt = page.getByLabel("描述图像", { exact: true });
        await prompt.fill("仅本地模拟生成，不提交任何外部服务");
        await page.getByTestId("canvas-quick-generate-panel").locator(".cw-generate-button").click();
        await until(() => report.submissions.length === 1);
        await until(async () => (await saved()).nodes.some(n => n.metadata?.generationType === "generation" && n.metadata?.status === "success"));
    });
    await page.screenshot({ path: path.join(output, "250-node-editor.png"), fullPage: true });
    assert.deepEqual(report.errors, []);
    report.status = "passed";
} catch (error) {
    report.status = "failed"; report.failure = String(error);
    report.location = page.url();
    report.store = await page.evaluate(async () => { const s = (await import("/src/stores/canvas/use-canvas-store.ts")).useCanvasStore.getState(); return { hydrated: s.hydrated, ids: s.projects.map(p => p.id) }; }).catch(() => null);
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
    await fs.writeFile(path.join(output, "failure.txt"), await page.locator("body").innerText());
    process.exitCode = 1;
} finally {
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
}
