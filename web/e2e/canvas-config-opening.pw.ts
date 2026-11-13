import { test, expect } from "./fixtures";

for (const slowModule of [false, true]) {
    test(`connected generation config preloads without model calls (held module: ${slowModule})`, async ({ page, api }, info) => {
        const id = `config-open-${slowModule}`, now = new Date().toISOString();
        const source = { id: "source", type: "image", title: "原始参考", width: 160, height: 160, position: { x: 390, y: 260 }, metadata: { content: "/api/assets/source/content" } };
        const nodes = [source];
        const document = { id, title: "配置打开检查", createdAt: now, updatedAt: now, nodes, connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
        api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
        const events: { event: string; time: number }[] = [];
        let releaseModule = () => {};
        const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
        if (slowModule) await page.route("**/canvas-config-node-panel.tsx*", async route => { await moduleGate; await route.continue(); });
        page.on("request", request => { if (request.url().includes("canvas-config-node-panel.tsx")) events.push({ event: "config-module-request", time: Date.now() }); });
        await page.goto(`/canvas/${id}`);
        const image = page.locator('[data-node-id="source"]'); await expect(image).toBeVisible();
        await image.hover();
        const port = (await image.locator('[data-canvas-connection-handle="right"]').boundingBox())!;
        await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2); await page.mouse.down();
        await page.mouse.move(port.x + 140, port.y, { steps: 5 }); await page.mouse.up();
        const option = page.getByRole("menuitem", { name: /^生成配置/ });
        await expect(option).toBeVisible(); events.push({ event: "menu-visible", time: Date.now() });
        await expect.poll(() => events.some(event => event.event === "config-module-request")).toBe(true);
        const clickAt = Date.now(); events.push({ event: "click", time: clickAt });
        await option.click();
        if (slowModule) {
            try {
                await expect(page.getByRole("status").filter({ hasText: "正在加载生成配置…" })).toBeVisible();
                expect(api.submissions).toEqual([]);
                await page.screenshot({ path: info.outputPath("loading-config.png") });
            } finally { releaseModule(); }
        }
        const editor = page.locator('[data-node-id] [contenteditable="true"]').first();
        await expect(editor).toBeVisible();
        const elapsed = Date.now() - clickAt; events.push({ event: "editor-visible", time: Date.now() });
        await editor.fill("保留原图结构，背景改为浅灰");
        await expect.poll(() => api.document(id)?.nodes.find((node: { type: string }) => node.type === "config")?.metadata?.composerContent).toBe("保留原图结构，背景改为浅灰");
        const saved = api.document(id)!;
        expect(saved.nodes.find((node: { id: string }) => node.id === "source")).toEqual(source);
        expect(saved.connections).toEqual([expect.objectContaining({ fromNodeId: "source", toNodeId: saved.nodes.find((node: { type: string }) => node.type === "config")?.id })]);
        expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
        expect(events.find(event => event.event === "config-module-request")!.time).toBeLessThanOrEqual(clickAt);
        await info.attach("opening-timing", { body: JSON.stringify({ slowModule, elapsed, events }, null, 2), contentType: "application/json" });
        console.log(JSON.stringify({ slowModule, elapsed, events }));
    });
}
