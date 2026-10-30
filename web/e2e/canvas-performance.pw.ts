import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { decodePerformanceThumbnails, inspectRenderedPerformanceImages, openPerformanceScene, preparePerformanceScene, PROJECT_ID } from "./canvas-performance-fixture";
import { summarizeFrames, memoryBudgetFailures } from "../scripts/canvas-performance-budget.mjs";
import { analyzeCanvasHeap } from "../scripts/canvas-performance-heap.mjs";

const variant = process.env.CANVAS_PERF_VARIANT;
const output = resolve(import.meta.dirname, `../../output/canvas-performance/${variant || "not-run"}`);
test.skip(!variant, "Use the isolated canvas-performance.config.ts and a production build");

async function startFrames(page: Page, busyMs: number) {
    await page.evaluate(ms => {
        const state = { frames: [] as number[], hiddenCount: document.hidden ? 1 : 0, active: true, last: undefined as number | undefined };
        const visibility = () => { if (document.hidden) state.hiddenCount++; };
        document.addEventListener("visibilitychange", visibility);
        (window as any).__performanceFrames = { state, stop: () => { state.active = false; document.removeEventListener("visibilitychange", visibility); } };
        const sample = (now: number) => {
            if (!state.active) return;
            // RAF timestamps denote frame start and can precede the evaluate
            // call's performance.now(). Only compare consecutive RAF stamps.
            if (state.last !== undefined) state.frames.push(now - state.last);
            state.last = now;
            // Test-only negative control. Fixed work, never derived from the
            // candidate's timings and never included in any production build.
            const end = performance.now() + ms;
            while (performance.now() < end) Math.sqrt(Math.random());
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }, busyMs);
}
async function finishFrames(page: Page) {
    return page.evaluate(() => {
        const probe = (window as any).__performanceFrames; probe.stop();
        const result = { frames: probe.state.frames as number[], hiddenCount: probe.state.hiddenCount as number };
        delete (window as any).__performanceFrames; return result;
    });
}
async function experienceMetrics(page: Page) {
    const text = await page.getByTestId("canvas-task-feedback").locator("dl").textContent() || "";
    const match = text.match(/最近 FPS · P95\s*([\d.]+)\s*·\s*([\d.]+) ms/);
    if (!match) throw new Error(`Existing canvas tracker did not publish a valid interaction: ${text}`);
    return { text, fps: Number(match[1]), p95Ms: Number(match[2]) };
}
async function resetView(page: Page) {
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
}
async function gesture(page: Page, label: string) {
    if (label === "pan") {
        await page.mouse.move(1100, 850); await page.mouse.down({ button: "middle" });
        for (let index = 0; index < 60; index++) {
            await page.mouse.move(1100 - Math.sin(index / 18) * 380, 850 - Math.sin(index / 15) * 230);
            await page.waitForTimeout(16);
        }
        await page.mouse.up({ button: "middle" });
    } else if (label === "zoom") {
        await page.mouse.move(1100, 600);
        for (let index = 0; index < 60; index++) { await page.mouse.wheel(0, index < 30 ? 20 : -20); await page.waitForTimeout(20); }
        await page.waitForTimeout(250);
    } else {
        const node = page.locator('[data-node-id="performance-node-0"]');
        await node.scrollIntoViewIfNeeded();
        const box = await node.boundingBox(); if (!box) throw new Error("Drag node absent");
        const x = box.x + 60, y = box.y + 18;
        await page.mouse.move(x, y); await page.mouse.down();
        for (let index = 0; index < 60; index++) { await page.mouse.move(x + Math.sin(index / 18) * 80, y + Math.sin(index / 21) * 60); await page.waitForTimeout(16); }
        await page.mouse.up();
    }
}

test("500节点100栅格图：对照帧率、真实堆曲线与200步历史边界", async ({ page, context, api, browser }, testInfo) => {
    // Production diagnostics are intentionally hidden from normal designers.
    // Use the existing isolated administrator session for every comparison
    // variant instead of changing the build, product gate, or measured scene.
    api.role = "super_admin";
    const scene = await preparePerformanceScene(context, api);
    await openPerformanceScene(page);
    await expect(page.getByTestId("canvas-task-feedback").locator("dl"), "Performance acceptance requires the real product diagnostics").toHaveCount(1);
    const uiImages = [...scene.requests];
    const renderedImages = await inspectRenderedPerformanceImages(page);
    expect(renderedImages.length).toBeGreaterThan(0);
    for (const rendered of renderedImages) {
        const index = (Number(rendered.nodeId!.slice("performance-node-".length)) - 4) / 5;
        const expected = scene.imageHashes.get(`40000000-0000-4000-8000-${String(index).padStart(12, "0")}`)!;
        expect([expected.original, expected.thumbnail]).toContain(rendered.sha256);
    }
    const decoded = await decodePerformanceThumbnails(page);
    expect(decoded).toEqual({ count: 100, decodedPixels: 4_915_200, widths: [256] });
    expect(scene.manifest.uniqueImageHashes).toBe(100);
    const environment = { browser: browser.version(), viewport: page.viewportSize(), deviceScaleFactor: 1, platform: process.platform };
    const build = { indexSha256: createHash("sha256").update(await readFile(resolve(process.env.CANVAS_PERF_DIST!, "index.html"))).digest("hex") };
    const interactions: any[] = [];
    const busyMs = variant === "injected" ? 65 : 0;
    const repetitions = process.env.CANVAS_PERF_ONLY_MEMORY === "1" ? 0 : 3;
    for (let repetition = 0; repetition < repetitions; repetition++) for (const label of ["pan", "zoom", "drag"]) {
        // Normal UI reset and a fresh context per variant retain the real
        // persistence path rather than mutating private application stores.
        await resetView(page);
        if (label === "drag") {
            // Locate through the product command palette, not a private store.
            await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
            await page.getByRole("menuitem", { name: /搜索命令、节点和素材/ }).click();
            await page.getByRole("combobox", { name: "搜索命令、节点和素材" }).fill("性能样本 0");
            await page.getByRole("option").filter({ hasText: "画布节点" }).first().click();
            await page.waitForTimeout(300);
        }
        await startFrames(page, busyMs);
        await gesture(page, label);
        const raw = await finishFrames(page);
        // Product tracker publishes 150ms after interaction settles (wheel
        // has its own 120ms end debounce). Read that existing sample, not the
        // previous gesture, without adding idle frames to the raw recording.
        await page.waitForTimeout(400);
        interactions.push({ label, repetition, frames: summarizeFrames(raw.frames, raw.hiddenCount), rawFramesMs: raw.frames, productMetrics: await experienceMetrics(page) });
        console.log(`${variant} ${label} #${repetition + 1}: ${raw.frames.length} frames`);
        expect(raw.hiddenCount).toBe(0);
    }
    const report: any = { schema: 1, variant, build, scene: scene.manifest, environment, decoded, uiImages, renderedImages, interactions, memory: null };
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    expect(api.submissions).toHaveLength(0);
    if (variant === "injected" || process.env.CANVAS_PERF_SKIP_MEMORY === "1") return;

    // A new isolated browser context avoids loaded app references and IDB
    // handles surviving the reset. No product store is exposed for this probe.
    await page.close();
    const memoryContext = await browser.newContext({ viewport: { width: 1800, height: 1200 }, serviceWorkers: "block", deviceScaleFactor: 1 });
    const MemoryApi = (await import("./fixtures")).MockCanvasApi;
    const memoryApi = new MemoryApi(testInfo.project.use.baseURL!);
    memoryApi.role = "super_admin";
    await memoryApi.attach(memoryContext);
    await preparePerformanceScene(memoryContext, memoryApi);
    const memoryPage = await memoryContext.newPage();
    await memoryPage.goto(`${testInfo.project.use.baseURL}/canvas/${PROJECT_ID}`);
    await expect(memoryPage.locator('[data-node-id="performance-node-0"]')).toBeVisible();
    const skip = memoryPage.getByRole("button", { name: "跳过引导", exact: true }); if (await skip.isVisible()) await skip.click();
    await decodePerformanceThumbnails(memoryPage);
    const cdp = await memoryContext.newCDPSession(memoryPage);
    const curve: any[] = [];
    const sample = async (step: number) => {
        if (step) {
            // Once history is capped, length=200 alone also matches the old
            // checkpoint. Wait for this batch's cloud acknowledgement so the
            // persistence queue can release its previous merge baseline.
            await expect.poll(() => memoryApi.documents.get(PROJECT_ID)?.revision || 0, { timeout: 15_000 }).toBeGreaterThan(curve.at(-1).cloudRevision);
            await expect.poll(() => memoryApi.document(PROJECT_ID)?.history?.past?.length, { timeout: 15_000 }).toBe(Math.min(step, 200));
            await expect(memoryPage.getByRole("button", { name: "画布与图片已保存至服务器", exact: true })).toBeVisible();
        }
        await memoryPage.waitForTimeout(300);
        await cdp.send("HeapProfiler.collectGarbage");
        const heap = await cdp.send("Runtime.getHeapUsage");
        curve.push({ step, ...heap, historyLength: memoryApi.document(PROJECT_ID)?.history?.past?.length ?? 0, cloudRevision: memoryApi.documents.get(PROJECT_ID)?.revision || 0 });
        console.log(`${variant} memory step ${step}: ${(heap.usedSize / 1024 ** 2).toFixed(2)} MiB / ${curve.at(-1).historyLength} history entries`);
        report.memory = { curve };
        await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    };
    await sample(0);
    const node = memoryPage.locator('[data-node-id="performance-node-0"]');
    await node.focus();
    for (let step = 1; step <= 220; step++) {
        // Unique edits matter after the cap: alternating Right/Left recreates
        // the exact same 200-entry value every two commands. Persistence then
        // correctly elides that no-op and retains an older equivalent graph.
        await node.press("ArrowRight");
        // Separate history commands, exceeding the actual 180ms coalescing delay.
        await memoryPage.waitForTimeout(210);
        if (step % 20 === 0) await sample(step);
    }
    expect(curve.find(point => point.step === 200).historyLength).toBe(200);
    expect(curve.at(-1).historyLength).toBe(200);
    const chunks: string[] = [];
    cdp.on("HeapProfiler.addHeapSnapshotChunk", event => chunks.push(event.chunk));
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    const heapSnapshot = chunks.join("");
    const sharing = analyzeCanvasHeap(JSON.parse(heapSnapshot));
    await writeFile(resolve(output, "history-220.heapsnapshot"), heapSnapshot);
    const growthMiB = (curve.find(point => point.step === 200).usedSize - curve[0].usedSize) / 1024 ** 2;
    const growthThrough220MiB = (curve.at(-1).usedSize - curve[0].usedSize) / 1024 ** 2;
    const afterCapMiB = (curve.at(-1).usedSize - curve.find(point => point.step === 200).usedSize) / 1024 ** 2;
    report.memory = { method: "Chrome CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage", workload: "220 distinct one-pixel ArrowRight edits of one node, saved every 20 commands", curve, growthMiB, growthThrough220MiB, afterCapMiB, sharing,
        scope: "JS heap only; does not measure native image decode/GPU/process RSS. Raster thumbnails are retained equally in baseline and candidate.",
        boundary: "200 snapshots per undo/redo stack; metadata and unchanged nodes shared for single-node movement. All-node edits, unique media strings, chat, imported histories may retain substantially more; no universal byte cap." };
    report.memory.budgetFailures = memoryBudgetFailures(report.memory);
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    // An old baseline can contain a known leak. Keep its negative evidence,
    // but only the candidate is required to satisfy the new product budget.
    if (variant !== "baseline") expect(report.memory.budgetFailures).toEqual([]);
    expect(memoryApi.blocked).toEqual([]); expect(memoryApi.unexpected).toEqual([]); expect(memoryApi.pageErrors).toEqual([]);
    expect(memoryApi.submissions).toHaveLength(0); expect(api.submissions).toHaveLength(0);
    await memoryContext.close();
});
