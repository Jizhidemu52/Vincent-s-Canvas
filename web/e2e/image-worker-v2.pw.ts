import { readFile, writeFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import type { Page } from "@playwright/test";
import { test, expect, newCanvas } from "./fixtures";

async function watchWorkers(page: Page) {
    await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        const stats = { created: 0, terminated: 0, active: 0, tasks: [] as string[], hold: false, events: [] as { time: number; type: string; label?: string }[] };
        Object.assign(window, { imageWorkerStats: stats });
        window.Worker = class extends NativeWorker {
            tracked: boolean; stopped = false; heldTransfers: ImageBitmap[] = [];
            constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.tracked = String(url).includes("canvas-image.worker"); if (this.tracked) { stats.created++; stats.active++; stats.events.push({ time: performance.now(), type: "create" }); this.addEventListener("message", event => stats.events.push({ time: performance.now(), type: event.data.type, label: event.data.progress?.label })); } }
            postMessage(message: any, transfer: any) { if (this.tracked) { stats.tasks.push(message.kind); if (stats.hold) { this.heldTransfers = transfer || []; return; } } super.postMessage(message, transfer); }
            terminate() { if (this.tracked && !this.stopped) { stats.terminated++; stats.active--; this.stopped = true; this.heldTransfers.forEach(bitmap => bitmap.close()); } super.terminate(); }
        };
    });
}
async function frames(page: Page, start: boolean) {
    return page.evaluate(begin => {
        const w = window as any;
        if (!begin) { cancelAnimationFrame(w.imageFrameId); w.imageTaskObserver?.disconnect(); w.imageLoafObserver?.disconnect(); return w.imageFrames as number[]; }
        w.imageFrames = []; let previous = performance.now();
        w.imageMeasureStart = previous; w.imageLongTasks = []; w.imageLongAnimationFrames = [];
        w.imageTaskObserver = new PerformanceObserver(list => w.imageLongTasks.push(...list.getEntries().map(entry => entry.toJSON())));
        w.imageTaskObserver.observe({ type: "longtask" });
        if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) { w.imageLoafObserver = new PerformanceObserver(list => w.imageLongAnimationFrames.push(...list.getEntries().map(entry => entry.toJSON()))); w.imageLoafObserver.observe({ type: "long-animation-frame" }); }
        const tick = (now: number) => { w.imageFrames.push(now - previous); previous = now; w.imageFrameId = requestAnimationFrame(tick); };
        w.imageFrameId = requestAnimationFrame(tick); return [];
    }, start);
}
async function inspect(page: Page, bytes: Buffer, mime: string) {
    return page.evaluate(async ({ encoded, type }) => {
        const blob = await (await fetch(`data:${type};base64,${encoded}`)).blob();
        const bitmap = await createImageBitmap(blob); const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0); bitmap.close();
        return { width: canvas.width, height: canvas.height, corner: [...context.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data], painted: [...context.getImageData(4, 4, 1, 1).data] };
    }, { encoded: bytes.toString("base64"), type: mime });
}

test("4MP真实对比和导出：不冻结、精确差异、PNG透明、JPG白底、字节不变和Worker回收", async ({ page, context, api }, info) => {
    test.setTimeout(120_000); await watchWorkers(page);
    await context.route("**/api/assets/*/variants", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        const variant = { assetId: id, url: `/api/assets/${id}/content`, mimeType: "image/png", filename: "source.png" };
        return route.fulfill({ json: { primary: variant, original: variant, maskComposited: false } });
    });
    const id = await newCanvas(page);
    const skip = page.getByRole("button", { name: "跳过引导", exact: true }); if (await skip.isVisible()) await skip.click();
    const collapse = page.getByRole("button", { name: "收起创建面板", exact: true }); if (await collapse.isVisible()) await collapse.click();
    const sources = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 2000; canvas.height = 2000;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = "rgb(100,90,50)"; ctx.fillRect(0, 0, 1500, 1500);
        const a = canvas.toDataURL("image/png").split(",")[1]; ctx.fillStyle = "rgb(150,90,50)"; ctx.fillRect(0, 0, 32, 32);
        return [a, canvas.toDataURL("image/png").split(",")[1]];
    });
    for (const [index, source] of sources.entries()) {
        const chooser = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "上传素材", exact: true }).click();
        await (await chooser).setFiles({ name: `4MP-${index}.png`, mimeType: "image/png", buffer: Buffer.from(source, "base64") });
        await expect.poll(() => api.document(id)?.nodes.length).toBe(index + 1);
    }
    await page.keyboard.press("Control+a");
    await page.getByRole("button", { name: "设计工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "改款前后对比", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "改款前后对比", exact: true });
    const preview = dialog.locator("canvas"); await expect(preview).toBeVisible();
    await frames(page, true);
    await dialog.getByText("差异图", { exact: true }).click();
    await expect(preview).toBeVisible(); await expect(preview).toHaveAttribute("width", "2000");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const intervals = await frames(page, false); const maxFrameMs = Math.max(...intervals);
    const diagnostics = await page.evaluate(() => ({ start: (window as any).imageMeasureStart, tasks: (window as any).imageLongTasks, frames: (window as any).imageLongAnimationFrames, events: (window as any).imageWorkerStats.events }));
    await writeFile(info.outputPath("frame-diagnostics.json"), JSON.stringify({ maxFrameMs, intervals, ...diagnostics }, null, 2));
    await info.attach("frame-diagnostics.json", { path: info.outputPath("frame-diagnostics.json"), contentType: "application/json" });
    console.log(JSON.stringify({ maxFrameMs, ...diagnostics }));
    const pixels = await preview.evaluate((canvas: HTMLCanvasElement) => { const ctx = canvas.getContext("2d")!; return { changed: [...ctx.getImageData(4, 4, 1, 1).data], same: [...ctx.getImageData(100, 100, 1, 1).data], clear: [...ctx.getImageData(1999, 1999, 1, 1).data] }; });
    expect(pixels).toEqual({ changed: [50, 50, 50, 255], same: [0, 0, 0, 255], clear: [0, 0, 0, 255] });
    const diffDownload = page.waitForEvent("download"); await dialog.getByRole("button", { name: "导出当前对比 PNG", exact: true }).click();
    const diff = await diffDownload; await diff.saveAs(info.outputPath("4mp-difference.png"));
    expect((await inspect(page, await readFile(info.outputPath("4mp-difference.png")), "image/png")).width).toBe(2000);
    await dialog.screenshot({ path: info.outputPath("difference-worker.png") });
    // Hold dispatch to deterministically exercise cancellation while the actual UI is busy.
    await page.evaluate(() => { (window as any).imageWorkerStats.hold = true; });
    await dialog.getByText("滑块", { exact: true }).click(); await expect(preview).toHaveAttribute("width", "1000");
    await dialog.getByText("差异图", { exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(1);
    const createdBeforeSwap = await page.evaluate(() => (window as any).imageWorkerStats.created);
    await dialog.getByRole("button", { name: "交换前后", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.created)).toBe(createdBeforeSwap + 1);
    expect(await page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(1);
    await dialog.getByRole("button", { name: "取消处理", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("已取消");
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(0);
    await dialog.getByText("滑块", { exact: true }).click(); await expect(preview).toBeVisible();
    await dialog.getByText("差异图", { exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(0);
    await page.evaluate(() => { (window as any).imageWorkerStats.hold = false; });
    await page.keyboard.press("Escape");
    const selected = api.document(id)!.nodes[1];
    await page.locator(`[data-node-id="${selected.id}"]`).click({ position: { x: 30, y: 12 } });
    await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    const direct = page.getByRole("button", { name: "下载图片", exact: true });
    if (await direct.isVisible()) await direct.click();
    else { await page.getByRole("button", { name: "更多图片工具", exact: true }).click(); await page.getByRole("menuitem", { name: "下载", exact: true }).click(); }
    const downloadDialog = page.getByRole("dialog", { name: "下载图片", exact: true });
    await downloadDialog.getByRole("radio", { name: "JPG（白底）", exact: true }).check();
    await page.evaluate(() => { (window as any).imageWorkerStats.hold = true; });
    await downloadDialog.getByRole("button", { name: "下载 JPG 图片", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(1);
    await downloadDialog.getByRole("button", { name: "取消处理", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(0);
    await page.evaluate(() => { (window as any).imageWorkerStats.hold = false; });
    for (const format of ["PNG", "JPG"] as const) {
        await downloadDialog.getByRole("radio", { name: format === "PNG" ? "PNG（保留透明）" : "JPG（白底）", exact: true }).check();
        const event = page.waitForEvent("download"); await downloadDialog.getByRole("button", { name: `下载 ${format} 图片`, exact: true }).click();
        const download = await event; const path = info.outputPath(`4mp-export.${format.toLowerCase()}`); await download.saveAs(path); const bytes = await readFile(path);
        const decoded = await inspect(page, bytes, format === "PNG" ? "image/png" : "image/jpeg");
        expect([decoded.width, decoded.height]).toEqual([2000, 2000]);
        expect(decoded.corner).toEqual(format === "PNG" ? [0, 0, 0, 0] : [255, 255, 255, 255]);
        if (format === "PNG") expect(bytes).toEqual(Buffer.from(sources[1], "base64"));
    }
    await downloadDialog.getByRole("button", { name: "Close", exact: true }).click();
    const openBatch = async () => {
        await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
        await page.getByRole("menuitem", { name: "导出图片集 / PDF", exact: true }).click();
        const batch = page.getByRole("dialog", { name: "导出图片集", exact: true });
        await batch.getByRole("button", { name: "全选", exact: true }).click(); return batch;
    };
    let batch = await openBatch(); await batch.getByRole("radio", { name: "JPG 图片（ZIP）", exact: true }).check();
    await page.evaluate(() => { (window as any).imageWorkerStats.hold = true; });
    await batch.getByRole("button", { name: "导出并下载", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(1);
    await batch.getByRole("button", { name: "取消处理", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).imageWorkerStats.active)).toBe(0);
    await page.evaluate(() => { (window as any).imageWorkerStats.hold = false; });
    for (const original of [false, true]) {
        if (original) { batch = await openBatch(); await batch.getByRole("radio", { name: "原图（ZIP）", exact: true }).check(); }
        const event = page.waitForEvent("download"); await batch.getByRole("button", { name: "导出并下载", exact: true }).click();
        const file = await event; const path = info.outputPath(original ? "originals.zip" : "jpg-images.zip"); await file.saveAs(path);
        const images = Object.values(unzipSync(await readFile(path))); expect(images).toHaveLength(2);
        if (original) expect(images.map(bytes => Buffer.from(bytes).toString("base64")).sort()).toEqual([...sources].sort());
        else for (const bytes of images) { const image = await inspect(page, Buffer.from(bytes), "image/jpeg"); expect([image.width, image.height, ...image.corner]).toEqual([2000, 2000, 255, 255, 255, 255]); }
    }
    const stats = await page.evaluate(() => (window as any).imageWorkerStats);
    expect(stats.tasks).toContain("difference"); expect(stats.tasks.filter((task: string) => task === "encode").length).toBeGreaterThanOrEqual(2);
    expect(stats.active).toBe(0); expect(stats.created).toBe(stats.terminated);
    expect([...api.assetBytes.values()].map(bytes => bytes.toString("base64"))).toEqual(sources);
    expect(api.submissions).toHaveLength(0);
    await writeFile(info.outputPath("worker-performance.json"), JSON.stringify({ dimensions: [2000, 2000], maxFrameMs, frameSamples: intervals.length, stats, pixels }, null, 2));
    await info.attach("worker-performance.json", { path: info.outputPath("worker-performance.json"), contentType: "application/json" });
    console.log(JSON.stringify({ imageWorker4MP: { maxFrameMs, samples: intervals.length, workers: stats.created } }));
    // Timing budgets apply to production chunks, not Vite on-demand source
    // compilation. Both runs still assert every pixel/byte/cancellation contract.
    // v2 acceptance is <=100 ms; the allowance is timestamp floating-point noise.
    if (process.env.CANVAS_IMAGE_WORKER_PREVIEW === "1") expect(maxFrameMs, `4MP max rAF gap; samples=${intervals.length}`).toBeLessThanOrEqual(100.01);
});

test("真实后台编码与取消：PNG透明、原件不转码、有限兼容模式和过期Worker终止", async ({ page, api }, info) => {
    test.skip(process.env.CANVAS_IMAGE_WORKER_PREVIEW === "1", "直接源码模块的补充契约检查在dev服务运行；正式包由上一个真实UI用例覆盖");
    await watchWorkers(page); await newCanvas(page);
    const result = await page.evaluate(async () => {
        const path = "/src/lib/canvas/canvas-image-encoding.ts";
        const { encodeImageBlob, prepareCanvasImageFormat } = await import(/* @vite-ignore */ path);
        const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48; const context = canvas.getContext("2d")!;
        context.fillStyle = "#f00"; context.fillRect(0, 0, 16, 16);
        const source = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/webp"));
        const png = await encodeImageBlob(source, "image/png"); const bitmap = await createImageBitmap(png);
        context.clearRect(0, 0, 64, 48); context.drawImage(bitmap, 0, 0); bitmap.close();
        const transparent = [...context.getImageData(62, 46, 1, 1).data];
        const original = await prepareCanvasImageFormat(source, "original");
        const controller = new AbortController(); const pending = encodeImageBlob(source, "image/jpeg", { signal: controller.signal }); controller.abort();
        const abortName = await pending.then(() => "unexpected result", (error: Error) => error.name);
        const native = window.Worker; Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: undefined });
        const progress: string[] = []; let fallback: Blob;
        try { fallback = await encodeImageBlob(source, "image/jpeg", { onProgress: (update: { label: string }) => progress.push(update.label) }); }
        finally { window.Worker = native; }
        return { transparent, originalSame: original.blob === source, abortName, fallbackType: fallback!.type, progress, stats: (window as any).imageWorkerStats };
    });
    expect(result.transparent).toEqual([0, 0, 0, 0]); expect(result.originalSame).toBe(true); expect(result.abortName).toBe("AbortError"); expect(result.fallbackType).toBe("image/jpeg"); expect(result.progress.join(" ")).toContain("兼容模式");
    expect(result.stats.active).toBe(0); expect(result.stats.created).toBe(result.stats.terminated); expect(api.submissions).toHaveLength(0);
    await writeFile(info.outputPath("encoding-cancellation.json"), JSON.stringify(result, null, 2));
    await info.attach("encoding-cancellation.json", { path: info.outputPath("encoding-cancellation.json"), contentType: "application/json" });
});
