import type { Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { test, expect, MockCanvasApi } from "./fixtures";
import { performanceRaster } from "./canvas-performance-fixture";
import { BUDGET, summarizeFrames } from "../scripts/canvas-performance-budget.mjs";

const PROJECT = "60000000-0000-4000-8000-000000000001";
async function scene(page: Page, api: MockCanvasApi, count = 1, grouped = false) {
    const nodes = Array.from({ length: count }, (_, index) => {
        const asset = `61000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        api.assetBytes.set(asset, performanceRaster(index, 256, 256));
        return { id: `alt-source-${index}`, type: "image", title: `原始款式 ${index}`, width: 80, height: 56,
            position: { x: index % 10 * 96, y: Math.floor(index / 10) * 72 },
            metadata: { status: "success", content: `/api/assets/${asset}/content`, naturalWidth: 256, naturalHeight: 256,
                prompt: "原始提示词", size: "1024x1024", references: ["asset:reference"], generationOrigin: { sourceNodeId: "outside-source", configNodeId: "outside-config", runId: "historical-run", mode: "image" } } };
    });
    const document = { id: PROJECT, title: "Alt 拖拽隔离验收", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
        nodes, connections: nodes.slice(1).map((node, index) => ({ id: `alt-link-${index}`, fromNodeId: nodes[index]!.id, toNodeId: node.id })),
        groups: grouped ? [{ id: "original-group", title: "整组款式", nodeIds: nodes.map(node => node.id), collapsed: false }] : [],
        chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
        viewport: { x: 520, y: 140, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    api.documents.set(PROJECT, { id: PROJECT, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    await page.goto(`/canvas/${PROJECT}`);
    await expect(page.locator('[data-node-id="alt-source-0"]')).toBeVisible();
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    if (await skip.isVisible()) await skip.click();
    await page.evaluate(async () => { await document.fonts.ready; });
    return structuredClone(document);
}
async function startDrag(page: Page, id: string, alt = true) {
    const box = await page.locator(`[data-node-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`Node absent: ${id}`);
    const start = { x: box.x + 30, y: box.y + 15 };
    await page.mouse.move(start.x, start.y);
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.down();
    return start;
}
async function endDrag(page: Page) { await page.mouse.up(); await page.keyboard.up("Alt"); }
async function selectedIds(page: Page) {
    return page.locator('[data-node-id][aria-label*="已选择"]').evaluateAll(elements => elements.map(element => element.getAttribute("data-node-id")!));
}

test("Alt click is inert; five independent copies follow the pointer and each undo includes the move", async ({ page, api }) => {
    const original = await scene(page, api);
    let start = await startDrag(page, "alt-source-0");
    await page.mouse.move(start.x + 3, start.y);
    await expect(page.locator("[data-node-id]")).toHaveCount(1);
    await endDrag(page);
    expect(api.document(PROJECT)!.nodes).toHaveLength(1);
    const ids: string[] = ["alt-source-0"];
    for (let index = 0; index < 5; index++) {
        start = await startDrag(page, ids.at(-1)!);
        // Modifier is latched at mousedown, not consulted on future moves.
        if (index === 0) await page.keyboard.up("Alt");
        await page.mouse.move(start.x + 12, start.y + 4);
        await expect(page.locator("[data-node-id]")).toHaveCount(index + 2);
        const selected = await selectedIds(page);
        expect(selected).toHaveLength(1); expect(ids).not.toContain(selected[0]);
        ids.push(selected[0]!);
        await page.mouse.move(start.x + 80, start.y + 16, { steps: 6 });
        const copyBox = await page.locator(`[data-node-id="${ids.at(-1)}"]`).boundingBox();
        expect(copyBox!.x + 30).toBeCloseTo(start.x + 80, 0);
        expect(copyBox!.y + 15).toBeCloseTo(start.y + 16, 0);
        await endDrag(page);
    }
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(6);
    const result = structuredClone(api.document(PROJECT)!);
    expect(result.nodes[0]).toEqual(original.nodes[0]);
    for (let index = 1; index <= 5; index++) {
        expect(result.nodes[index].title).toBe(original.nodes[0]!.title);
        expect(result.nodes[index].position).toEqual({ x: index * 80, y: index * 16 });
        expect(result.nodes[index].metadata.generationOrigin).toEqual(original.nodes[0]!.metadata.generationOrigin);
    }
    expect(result.history.past).toHaveLength(5);
    for (let count = 5; count >= 1; count--) { await page.keyboard.press("Control+z"); await expect(page.locator("[data-node-id]")).toHaveCount(count); }
    for (let count = 2; count <= 6; count++) { await page.keyboard.press("Control+Shift+z"); await expect(page.locator("[data-node-id]")).toHaveCount(count); }
    await expect.poll(() => api.document(PROJECT)!.nodes).toEqual(result.nodes);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("repeat duplicate uses the last world offset, selection changes reset it, and cancelled copies leave no history", async ({ page, api }) => {
    await scene(page, api);
    await page.keyboard.press("Control+-");
    await expect.poll(() => api.document(PROJECT)!.viewport.k).toBeLessThan(1);
    const k = api.document(PROJECT)!.viewport.k;
    let start = await startDrag(page, "alt-source-0");
    await page.mouse.move(start.x + 60, start.y + 30, { steps: 5 }); await endDrag(page);
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(2);
    const first = api.document(PROJECT)!.nodes[1];
    expect(first.position.x).toBeCloseTo(60 / k, 4);
    await page.keyboard.press("Control+d");
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(3);
    const repeated = api.document(PROJECT)!.nodes[2];
    expect(repeated.position.x).toBeCloseTo(first.position.x * 2, 4);
    expect(repeated.position.y).toBeCloseTo(first.position.y * 2, 4);
    // Another Alt gesture always follows the pointer rather than snapping to the last offset.
    start = await startDrag(page, repeated.id);
    await page.mouse.move(start.x - 22, start.y + 8, { steps: 3 });
    await expect(page.locator("[data-node-id]")).toHaveCount(4);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up(); await page.keyboard.up("Alt");
    await expect(page.locator("[data-node-id]")).toHaveCount(3);
    await page.keyboard.press("Control+z");
    await expect(page.locator("[data-node-id]")).toHaveCount(2);
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(2);
    // Selecting a different source breaks the repeat-copy lineage.
    await page.locator('[data-node-id="alt-source-0"]').click({ position: { x: 20, y: 15 } });
    expect(await selectedIds(page)).toEqual(["alt-source-0"]);
    await page.keyboard.press("Control+d");
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(3);
    expect(api.document(PROJECT)!.nodes[2].position).toEqual({ x: 36, y: 36 });
    expect(api.submissions).toEqual([]);
});

test("100 selected nodes retain their complete group and internal connections in one copy transaction", async ({ page, api }) => {
    const original = await scene(page, api, 100, true);
    await page.keyboard.press("Control+a");
    expect(await selectedIds(page)).toHaveLength(100);
    const start = await startDrag(page, "alt-source-0");
    await page.mouse.move(start.x + 48, start.y + 24, { steps: 12 }); await endDrag(page);
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(200);
    const result = api.document(PROJECT)!;
    expect(result.nodes.slice(0, 100)).toEqual(original.nodes);
    expect(result.connections).toHaveLength(198); expect(result.groups).toHaveLength(2);
    const copiedIds = new Set(result.nodes.slice(100).map((node: any) => node.id));
    expect(result.groups[1].nodeIds.every((id: string) => copiedIds.has(id))).toBe(true);
    expect(result.connections.slice(99).every((edge: any) => copiedIds.has(edge.fromNodeId) && copiedIds.has(edge.toNodeId))).toBe(true);
    expect(result.nodes.slice(100).every((node: any, index: number) => node.position.x === original.nodes[index]!.position.x + 48 && node.position.y === original.nodes[index]!.position.y + 24)).toBe(true);
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(PROJECT)!.nodes).toEqual(original.nodes);
    expect(api.document(PROJECT)!.connections).toEqual(original.connections);
    expect(api.document(PROJECT)!.groups).toEqual(original.groups);
    expect(api.submissions).toEqual([]);
});

test("100-node Alt drag preserves the existing relative frame budgets", async ({ page, api, browser }, info) => {
    test.skip(!process.env.CANVAS_UX_DIST, "Performance acceptance requires a production build");
    await scene(page, api, 100);
    await page.locator("[data-node-id] img").evaluateAll(async images => { await Promise.all(images.map(image => (image as HTMLImageElement).decode())); });
    const samples: { alt: boolean; frames: ReturnType<typeof summarizeFrames>; rawFramesMs: number[] }[] = [];
    for (let repetition = 0; repetition < 3; repetition++) for (const alt of [false, true]) {
        await page.evaluate(() => {
            const state = { active: true, values: [] as number[], last: 0, hidden: document.hidden ? 1 : 0 };
            (window as any).__altFrames = state;
            const frame = (time: number) => { if (!state.active) return; if (state.last) state.values.push(time - state.last); state.last = time; if (document.hidden) state.hidden++; requestAnimationFrame(frame); };
            requestAnimationFrame(frame);
        });
        const start = await startDrag(page, "alt-source-0", alt);
        for (let index = 0; index < 60; index++) {
            await page.mouse.move(start.x + 12 + Math.sin(index / 18) * 80, start.y + Math.sin(index / 21) * 40);
            await page.waitForTimeout(16);
        }
        await endDrag(page);
        const raw = await page.evaluate(() => { const state = (window as any).__altFrames; state.active = false; return { values: state.values as number[], hidden: state.hidden as number }; });
        samples.push({ alt, frames: summarizeFrames(raw.values, raw.hidden), rawFramesMs: raw.values });
        await page.keyboard.press("Control+z");
        await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(100);
        await expect.poll(() => api.document(PROJECT)!.nodes[0].position).toEqual({ x: 0, y: 0 });
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
    const normal = samples.filter(sample => !sample.alt), copies = samples.filter(sample => sample.alt);
    const ratios = { p95: median(copies.map(sample => sample.frames.p95Ms)) / median(normal.map(sample => sample.frames.p95Ms)),
        mean: median(copies.map(sample => sample.frames.meanMs)) / median(normal.map(sample => sample.frames.meanMs)),
        longRateIncrease: median(copies.map(sample => sample.frames.longFrameRate)) - median(normal.map(sample => sample.frames.longFrameRate)) };
    const report = { scene: { nodes: 100, distinctRasterImages: 100, connections: 99 }, browser: browser.version(), viewport: page.viewportSize(),
        comparison: "Three ordinary drags versus three Alt copies of one node in the same production build and scene", samples, ratios, budget: BUDGET };
    const reportPath = info.outputPath("100-node-alt-frame-samples.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await info.attach("100-node-alt-frame-samples", { path: reportPath, contentType: "application/json" });
    console.log(`Alt drag frame ratios: P95 ${ratios.p95.toFixed(3)}, mean ${ratios.mean.toFixed(3)}, long-frame increase ${ratios.longRateIncrease.toFixed(3)}`);
    for (const sample of samples) { expect(sample.frames.count).toBeGreaterThanOrEqual(40); expect(sample.frames.hiddenCount).toBe(0); expect(sample.frames.stalledCount).toBe(0); expect(sample.frames.invalidCount).toBe(0); }
    expect(ratios.p95).toBeLessThanOrEqual(BUDGET.p95Ratio);
    expect(ratios.mean).toBeLessThanOrEqual(BUDGET.meanFrameRatio);
    expect(ratios.longRateIncrease).toBeLessThanOrEqual(BUDGET.longFrameRateIncrease);
    expect(api.submissions).toEqual([]);
});
