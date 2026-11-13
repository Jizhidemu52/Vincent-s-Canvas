import type { Page } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";
import { moduleDefinitions } from "../../shared/feature-catalog";

function seed(api: MockCanvasApi, id: string, empty = false) {
    const now = new Date().toISOString();
    const nodes = empty ? [] : [
        { id: "a", type: "image", title: "原始参考A", width: 160, height: 160, position: { x: 390, y: 260 }, metadata: { content: "/api/assets/a/content" } },
        { id: "b", type: "image", title: "原始参考B", width: 160, height: 160, position: { x: 960, y: 260 }, metadata: { content: "/api/assets/b/content" } },
        { id: "c", type: "image", title: "原始参考C", width: 160, height: 160, position: { x: 960, y: 580 }, metadata: { content: "/api/assets/c/content" } },
    ];
    const document = { id, title: "视图与常驻模板入口", createdAt: now, updatedAt: now, nodes,
        connections: empty ? [] : [{ id: "edge-ab", fromNodeId: "a", toNodeId: "b", kind: "reference" }, { id: "edge-ac", fromNodeId: "a", toNodeId: "c", kind: "reference" }],
        groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
    api.documents.set(id, { id, revision: 1, deleted: false, document, updatedAt: now });
    return structuredClone(document);
}

async function midpoint(page: Page) {
    const a = (await page.locator('[data-node-id="a"]').boundingBox())!;
    const b = (await page.locator('[data-node-id="b"]').boundingBox())!;
    return { x: (a.x + a.width + b.x) / 2, y: a.y + a.height / 2 };
}
async function paintedPixels(page: Page) {
    return page.locator("[data-canvas-viewport] > canvas").evaluateAll(canvases => canvases.map(element => {
        const canvas = element as HTMLCanvasElement, context = canvas.getContext("2d");
        if (!context) return 0;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) count++;
        return count;
    }).reduce((sum, count) => sum + count, 0));
}

for (const renderer of ["canvas2d", "svg-fallback"] as const) {
    test(`${renderer}: view-only toggle persists without deleting saved connections and retains live drag feedback`, async ({ page, api }, info) => {
        if (renderer === "svg-fallback") await page.addInitScript(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement["getContext"]>) {
                if (args[0] === "2d" && this.parentElement?.hasAttribute("data-canvas-viewport")) return null;
                return Reflect.apply(original, this, args);
            } as HTMLCanvasElement["getContext"];
        });
        const id = `view-only-${renderer}`, original = seed(api, id);
        await page.goto(`/canvas/${id}`);
        await expect(page.locator('[data-node-id="b"]')).toBeVisible();
        if (renderer === "canvas2d") await expect.poll(() => paintedPixels(page)).toBeGreaterThan(0);
        else await expect(page.locator("[data-connection-id]")).toHaveCount(2);
        const initialMidpoint = await midpoint(page);
        await page.mouse.click(initialMidpoint.x, initialMidpoint.y);
        await expect(page.getByRole("button", { name: "拖动改接终点", exact: true })).toBeVisible();

        const toggle = page.getByRole("button", { name: "隐藏连接线", exact: true });
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await toggle.click();
        await expect(page.getByRole("button", { name: "显示连接线", exact: true })).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByRole("button", { name: "拖动改接终点", exact: true })).toHaveCount(0);
        if (renderer === "canvas2d") await expect.poll(() => paintedPixels(page)).toBe(0);
        else await expect(page.locator("[data-connection-id]")).toHaveCount(0);
        expect(api.document(id)?.connections).toEqual(original.connections);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wireless-canvas:canvas_view")!))).toEqual({ state: { showConnections: false }, version: 0 });
        await page.screenshot({ path: info.outputPath(`${renderer}-hidden-view-control.png`) });
        await page.mouse.click(initialMidpoint.x, initialMidpoint.y);
        await expect(page.locator("[data-connection-endpoint]")).toHaveCount(0);

        // Trigger an actual cloud-document save while hidden, not only a view repaint.
        const moved = page.locator('[data-node-id="c"]'), bounds = (await moved.boundingBox())!;
        await page.mouse.move(bounds.x + 80, bounds.y + 80); await page.mouse.down();
        await page.mouse.move(bounds.x + 118, bounds.y + 98, { steps: 5 }); await page.mouse.up();
        await expect.poll(() => api.document(id)?.nodes.find((node: { id: string }) => node.id === "c")?.position).not.toEqual(original.nodes[2]!.position);
        expect(api.document(id)?.connections).toEqual(original.connections);
        expect(api.document(id)?.nodes.map((node: { id: string; metadata: unknown }) => ({ id: node.id, metadata: node.metadata }))).toEqual(original.nodes.map(node => ({ id: node.id, metadata: node.metadata })));
        await page.keyboard.press("Control+z");
        await expect.poll(() => api.document(id)?.nodes.find((node: { id: string }) => node.id === "c")?.position).toEqual(original.nodes[2]!.position);

        await page.reload();
        await expect(page.locator('[data-node-id="c"]')).toBeVisible();
        await expect(page.getByRole("button", { name: "显示连接线", exact: true })).toHaveAttribute("aria-pressed", "false");
        const source = page.locator('[data-node-id="c"]'); await source.hover();
        const port = source.locator('[data-canvas-connection-handle="right"]'); await expect(port).toBeVisible();
        const portBox = (await port.boundingBox())!;
        await page.mouse.move(portBox.x + portBox.width / 2, portBox.y + portBox.height / 2); await page.mouse.down();
        await page.mouse.move(portBox.x + 170, portBox.y - 80, { steps: 8 });
        const preview = page.locator("[data-canvas-viewport] > .origin-top-left > svg > path[stroke-width='2'][d]");
        await expect(preview).toBeVisible(); await expect(preview).toHaveAttribute("d", /^M /);
        await page.screenshot({ path: info.outputPath(`${renderer}-hidden-live-connection.png`) });
        await page.keyboard.press("Escape"); await page.mouse.up();
        expect(api.document(id)?.connections).toEqual(original.connections);
        await page.getByRole("button", { name: "显示连接线", exact: true }).click();
        if (renderer === "canvas2d") await expect.poll(() => paintedPixels(page)).toBeGreaterThan(0);
        else await expect(page.locator("[data-connection-id]")).toHaveCount(2);
        const restoredMidpoint = await midpoint(page); await page.mouse.click(restoredMidpoint.x, restoredMidpoint.y);
        await expect(page.getByRole("button", { name: "拖动改接终点", exact: true })).toBeVisible();
        expect(api.document(id)?.connections).toEqual(original.connections);
        expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
    });
}

test("More tools opens the same template library on non-empty canvases and adding stays local", async ({ page, api }, info) => {
    const emptyId = "template-empty", populatedId = "template-populated";
    seed(api, emptyId, true); const original = seed(api, populatedId);
    await page.goto(`/canvas/${emptyId}`);
    await page.getByTestId("canvas-empty-start").getByRole("button", { name: /用模板开始/ }).click();
    const dialog = page.getByRole("dialog", { name: "整套服装画布模板", exact: true });
    await expect(dialog).toBeVisible();
    const templateIds = await dialog.locator("[data-template-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-template-id")));
    expect(templateIds.length).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto(`/canvas/${populatedId}`);
    await expect(page.locator('[data-node-id="b"]')).toBeVisible();
    await expect(page.getByTestId("canvas-empty-start")).toHaveCount(0);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "用模板开始", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("populated-template-menu.png") });
    await page.getByRole("menuitem", { name: "用模板开始", exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(await dialog.locator("[data-template-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-template-id")))).toEqual(templateIds);
    expect(api.document(populatedId)?.nodes).toEqual(original.nodes);
    expect(api.document(populatedId)?.connections).toEqual(original.connections);
    await dialog.getByRole("button", { name: "添加这套流程", exact: true }).first().click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => api.document(populatedId)?.nodes.length).toBeGreaterThan(original.nodes.length);
    expect(api.document(populatedId)?.connections).toEqual(expect.arrayContaining(original.connections));
    for (const node of original.nodes) expect(api.document(populatedId)?.nodes.find((saved: { id: string }) => saved.id === node.id)).toEqual(node);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("disabled canvas-local-tools removes the persistent template action", async ({ page, context, api }, info) => {
    await context.route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: item.moduleKey !== "canvas-local-tools" })) } }));
    const id = "template-disabled"; const original = seed(api, id);
    await page.goto(`/canvas/${id}`);
    await expect(page.locator('[data-node-id="b"]')).toBeVisible();
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "用模板开始", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("template-module-disabled.png") });
    expect(api.document(id)?.nodes).toEqual(original.nodes); expect(api.document(id)?.connections).toEqual(original.connections);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

for (const scenario of [{ name: "desktop-light-English", width: 1680, height: 1000, theme: "light", english: true }, { name: "mobile-dark-Chinese", width: 390, height: 844, theme: "dark", english: false }]) {
    test(`${scenario.name}: bottom-right view control and template entry stay clear of panels`, async ({ page, context, api }, info) => {
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.addInitScript(({ theme, english }) => {
            localStorage.setItem("wireless-canvas:theme_store", JSON.stringify({ state: { theme }, version: 0 }));
            localStorage.setItem("inchoice.ui-locale", english ? "en-US" : "zh-CN");
        }, scenario);
        await context.route("**/api/display-translations", async route => {
            const body = route.request().postDataJSON();
            await route.fulfill({ json: { translations: body.texts.map((_text: string, index: number) => `Fixture display ${index + 1}`) } });
        });
        await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
        const id = `layout-${scenario.name}`, original = seed(api, id);
        await page.goto(`/canvas/${id}`);
        const control = page.getByTestId("canvas-connection-visibility-control"), toggle = control.getByRole("button");
        await expect(toggle).toHaveAccessibleName(scenario.english ? "Hide connections" : "隐藏连接线");
        await expect(page.locator(".cw-workspace")).toHaveAttribute("data-theme", scenario.theme);
        const bounds = (await control.boundingBox())!;
        expect(scenario.width - bounds.x - bounds.width).toBeCloseTo(12, 0);
        expect(scenario.height - bounds.y - bounds.height).toBeCloseTo(64, 0);
        expect(bounds.width).toBeGreaterThanOrEqual(40);
        expect(await toggle.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
        })).toBe(true);
        await toggle.click();
        await expect(toggle).toHaveAccessibleName(scenario.english ? "Show connections" : "显示连接线");
        await toggle.focus(); await page.keyboard.press("Space");
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await page.screenshot({ path: info.outputPath(`${scenario.name}-idle.png`), animations: "disabled" });

        await page.locator('[data-usage-control="canvas-tool.zoom"]').click();
        await page.getByRole("button", { name: scenario.english ? "Show minimap" : "打开小地图", exact: true }).click();
        await page.locator('[data-usage-control="canvas-tool.zoom"]').click();
        const minimap = page.getByTestId("canvas-mini-map"); await expect(minimap).toBeVisible();
        const mapBounds = (await minimap.boundingBox())!;
        expect(mapBounds.y + mapBounds.height).toBeLessThanOrEqual(bounds.y);
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");

        await page.locator('[data-usage-control="canvas-tool.generate"]').click();
        const generator = page.getByTestId("canvas-quick-generate-panel"); await expect(generator).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${scenario.name}-create-panel.png`), animations: "disabled" });
        const generationBounds = (await generator.boundingBox())!;
        const generationOverlap = Math.max(0, Math.min(bounds.x + bounds.width, generationBounds.x + generationBounds.width) - Math.max(bounds.x, generationBounds.x)) * Math.max(0, Math.min(bounds.y + bounds.height, generationBounds.y + generationBounds.height) - Math.max(bounds.y, generationBounds.y));
        if (scenario.width <= 720) await expect(toggle).toBeHidden();
        else { await expect(toggle).toBeVisible(); expect(generationOverlap, "connection control must not overlay the create panel").toBe(0); }
        await page.getByRole("button", { name: scenario.english ? "Collapse creation panel" : scenario.width < 1024 ? "关闭画布生图" : "收起创建面板", exact: true }).click();
        await expect(generator).toHaveCount(0);

        await page.getByTestId("canvas-left-generator-rail").getByRole("tab").nth(1).click();
        const assistant = page.locator('.cw-agent-panel:not([aria-hidden="true"])'); await expect(assistant).toBeVisible();
        await expect(assistant.getByRole("tab").first()).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${scenario.name}-chat-panel.png`), animations: "disabled" });
        const assistantBounds = (await assistant.boundingBox())!;
        const assistantOverlap = Math.max(0, Math.min(bounds.x + bounds.width, assistantBounds.x + assistantBounds.width) - Math.max(bounds.x, assistantBounds.x)) * Math.max(0, Math.min(bounds.y + bounds.height, assistantBounds.y + assistantBounds.height) - Math.max(bounds.y, assistantBounds.y));
        if (scenario.width <= 720) await expect(toggle).toBeHidden();
        else { await expect(toggle).toBeVisible(); expect(assistantOverlap, "connection control must not overlay the chat panel").toBe(0); }
        await assistant.getByRole("tab").first().click();
        await expect(assistant).toHaveCount(0);
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await page.locator('[data-usage-control="canvas-tool.more"]').click();
        const templateAction = page.getByRole("menuitem").filter({ has: page.locator('[data-usage-control="canvas-tool.designTemplate"]') });
        await expect(templateAction).toBeVisible();
        await templateAction.click();
        const templateDialog = page.getByRole("dialog");
        await expect(templateDialog.locator("[data-template-id]").first()).toBeVisible();
        await expect(templateDialog).toHaveCSS("opacity", "1");
        await expect(templateDialog).not.toHaveClass(/(?:enter|appear)(?:-|\s|$)/);
        if (scenario.english) await expect(templateDialog).not.toContainText(/[\u3400-\u9fff]/);
        await page.screenshot({ path: info.outputPath(`${scenario.name}-template-dialog.png`), animations: "disabled" });
        expect(api.document(id)?.nodes).toEqual(original.nodes); expect(api.document(id)?.connections).toEqual(original.connections);
        expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
    });
}
