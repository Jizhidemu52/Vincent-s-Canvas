import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";
import { activeWorkbench } from "./headless-workbench";

const owner = "00000000-0000-4000-8000-000000000099";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function recolor(page: Page, beforeSave?: () => Promise<void>) {
    await page.goto("/creative/pattern-colorway");
    const data = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64; const context = canvas.getContext("2d")!; context.fillStyle = "#FF0000"; context.fillRect(0, 0, 64, 50); return canvas.toDataURL("image/png").split(",")[1]; });
    await page.getByLabel("上传图案参考图", { exact: true }).setInputFiles({ name: "original-red.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") });
    await expect(page.getByRole("img", { name: "original-red.png", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /精确换色/ }).click();
    const dialog = page.getByRole("dialog", { name: "精确换色 · 本地处理", exact: true });
    await dialog.getByRole("textbox", { name: "原色 HEX 1", exact: true }).fill("#FF0000");
    await dialog.getByRole("textbox", { name: "目标色 HEX 1", exact: true }).fill("#00FF00");
    await dialog.getByRole("slider").press("Home");
    await beforeSave?.();
    await dialog.getByRole("button", { name: /保存换色结果$/ }).click();
    await expect(dialog).toHaveCount(0);
}

async function downloaded(page: Page) {
    const pending = page.waitForEvent("download");
    await page.getByRole("link", { name: "下载原件", exact: true }).click();
    const download = await pending, path = await download.path();
    expect(path).toBeTruthy();
    return readFile(path!);
}

test("exact recolor is saved once and a fresh browser downloads identical final bytes with complete parameters", async ({ browser, page, api }, info) => {
    await recolor(page);
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.localProcessingRecords.size).toBe(1); expect(api.submissions).toHaveLength(0);
    const record = [...api.localProcessingRecords.values()][0];
    expect(record.parameters.recolor).toEqual({ rules: [{ from: "#FF0000", to: "#00FF00" }], tolerance: 0 });
    expect(record.sourceTaskId).toBeNull();
    const final = api.assetBytes.get(record.outputAssetId)!;
    expect(hash(final)).toBe(record.contentSha256);
    const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
    await api.attach(other);
    try {
        expect((await other.storageState()).origins).toEqual([]);
        const fresh = await other.newPage(); await fresh.goto("/creative/pattern-colorway");
        const history = fresh.getByRole("region", { name: "账号云端历史" });
        await expect(history.getByRole("button", { name: /^查看云端记录/ })).toHaveCount(1);
        await expect(fresh.locator("button.cs-history-item")).toHaveCount(0);
        await history.getByRole("button", { name: /^查看云端记录/ }).click();
        const detail = fresh.getByTestId("account-local-processing-detail");
        await expect(detail.getByRole("img", { name: "账号历史原件" })).toBeVisible();
        await detail.getByText("查看处理参数与关联原任务").click();
        await expect(detail.locator("pre")).toContainText("#00FF00");
        await expect(detail.locator("pre")).toContainText(record.clientOperationId);
        expect(hash(await downloaded(fresh))).toBe(record.contentSha256);
        await fresh.screenshot({ path: info.outputPath("recolor-cloud-detail-desktop.png"), fullPage: true });
        await fresh.setViewportSize({ width: 390, height: 844 });
        await expect.poll(() => fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await fresh.screenshot({ path: info.outputPath("recolor-cloud-detail-mobile.png"), fullPage: true });
        expect(api.submissions).toHaveLength(0); expect(api.localProcessingRecords.size).toBe(1);
    } finally { await other.close(); }
});

test("without the secure-context UUID API a failed receipt retries the same image without a new AI task", async ({ page, api }, info) => {
    await page.addInitScript(() => Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined }));
    const writes: any[] = []; let failOnce = true;
    await page.route("**/api/assets/local-processing", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        writes.push(route.request().postDataJSON());
        if (failOnce) { failOnce = false; return route.fulfill({ status: 503, json: { message: "isolated final record save unavailable" } }); }
        return route.fallback();
    });
    await recolor(page);
    expect(await page.evaluate(() => ({ randomUUID: typeof crypto.randomUUID, randomValues: typeof crypto.getRandomValues }))).toEqual({ randomUUID: "undefined", randomValues: "function" });
    await expect(page.getByRole("button", { name: "仅重试保存最终成果", exact: true })).toBeVisible();
    await expect(page.getByText("方案 1 最终成果待保存", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "按原参数重试", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(0); expect(api.localProcessingRecords.size).toBe(0);
    await page.screenshot({ path: info.outputPath("final-save-failed-no-ai-retry.png"), fullPage: true });
    await page.getByRole("button", { name: "仅重试保存最终成果", exact: true }).click();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(api.localProcessingUploads.size).toBe(1); expect(api.localProcessingRecords.size).toBe(1);
    expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0);
    await expect(page.getByText("最终成果已保存到账号云端，没有重新生成或扣费。", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("http-final-save-recovered-once.png"), fullPage: true });
});

test("full local image cache plus a failed final receipt retries the retained bytes without AI", async ({ page, api }, info) => {
    const writes: any[] = []; let failOnce = true;
    await page.route("**/api/assets/local-processing", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        writes.push(route.request().postDataJSON());
        if (failOnce) { failOnce = false; return route.fulfill({ status: 503, json: { message: "isolated final record save unavailable" } }); }
        return route.fallback();
    });
    await recolor(page, () => page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
            if (this.name === "image_files") throw new DOMException("isolated image cache is full", "QuotaExceededError");
            return key === undefined ? put.call(this, value) : put.call(this, value, key);
        };
    }));
    await expect(page.getByRole("button", { name: "仅重试保存最终成果", exact: true })).toBeVisible();
    expect(api.localProcessingRecords.size).toBe(0);
    await page.getByRole("button", { name: "仅重试保存最终成果", exact: true }).click();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(api.localProcessingUploads.size).toBe(1); expect(api.localProcessingRecords.size).toBe(1);
    expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0);
    await expect(page.getByText("最终成果已保存到账号云端，没有重新生成或扣费。", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("cache-full-final-save-recovered.png"), fullPage: true });
});

test("recovering a successful original AI task archives the actual selected composite and does not resubmit", async ({ browser, page, api }, info) => {
    api.taskStatus = "paused";
    await page.goto("/local-restyle");
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "source.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("button", { name: "涂选修改区域", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
    await expect(modal.getByRole("button", { name: "保存选区", exact: true })).toBeEnabled();
    await expect(modal).not.toHaveClass(/\bant-zoom-(?:appear|enter)\b/);
    const canvas = modal.getByLabel("修改区域画布", { exact: true }); await canvas.hover();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * .35, box.y + box.height * .5); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height * .5, { steps: 8 }); await page.mouse.up();
    await modal.getByRole("button", { name: "保存选区", exact: true }).click(); await expect(modal).toHaveCount(0);
    await page.getByRole("textbox", { name: "要改成什么样", exact: true }).fill("修改选中部位，其余原图像素不变");
    await activeWorkbench(page).locator("button.cs-generate").click();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1); expect(api.localProcessingRecords.size).toBe(0);
    const task = [...api.tasks.values()][0]; task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`];
    await page.reload();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1); expect(api.localProcessingRecords.size).toBe(1);
    const record = [...api.localProcessingRecords.values()][0], bytes = api.assetBytes.get(record.outputAssetId)!;
    expect(record.sourceTaskId).toBe(task.id); expect(record.operation).toBe("selection-composite");
    expect(record.sourceAssetIds).toContain(task.id);
    expect(hash(bytes)).toBe(record.contentSha256);
    expect(hash(bytes)).not.toBe(hash(api.assetBytes.get(task.id)!));
    const facts = await page.evaluate(async input => {
        const read = async (data: number[]) => { const image = await createImageBitmap(new Blob([Uint8Array.from(data)], { type: "image/png" })); const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); image.close(); return context.getImageData(0, 0, canvas.width, canvas.height).data; };
        const [source, mask, final] = await Promise.all(input.map(read)); let outsideDifferences = 0, insideChanged = 0;
        for (let at = 0; at < source.length; at += 4) { const changed = [0, 1, 2, 3].some(channel => source[at + channel] !== final[at + channel]); if (!mask[at + 3] && changed) outsideDifferences++; else if (mask[at + 3] && changed) insideChanged++; }
        return { outsideDifferences, insideChanged };
    }, [[...IMAGE], [...api.assetBytes.get(record.parameters.selection.maskAssetId)!], [...bytes]]);
    expect(facts.outsideDifferences).toBe(0); expect(facts.insideChanged).toBeGreaterThan(100);
    await page.screenshot({ path: info.outputPath("recovered-composite-cloud-saved.png"), fullPage: true });
    const other = await browser.newContext({ baseURL: new URL(page.url()).origin }); await api.attach(other);
    try {
        const fresh = await other.newPage(); await fresh.goto("/local-restyle");
        await fresh.getByRole("button", { name: /^查看云端记录/ }).click();
        await expect(fresh.getByTestId("account-local-processing-detail")).toContainText("选区合成 · 最终成果已归档");
        expect(hash(await downloaded(fresh))).toBe(record.contentSha256);
        expect(api.submissions).toHaveLength(1);
    } finally { await other.close(); }
});

function historyRecord(index: number) {
    const id = `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    return { version: 1, id, outputAssetId: id, sourceOutputAssetId: id, ownerUserId: owner, clientOperationId: randomUUID(), board: "creative-pattern-colorway", operation: "recolor", prompt: `已保存换色-${index}`,
        parameters: { recolor: { rules: [{ from: "#000000", to: "#FFFFFF" }], tolerance: 0 } }, sourceAssetIds: ["50000000-0000-4000-8000-000000000001"], sourceTaskId: null,
        filename: "final.png", mimeType: "image/png", byteSize: IMAGE.length, contentSha256: hash(IMAGE), createdAt: new Date(Date.UTC(2026, 10, 19, 10, 0, index)).toISOString(),
        contentUrl: `/api/assets/${id}/content`, thumbnailUrl: `/api/assets/${id}/thumb?w=256`, previewUrl: `/api/assets/${id}/thumb?w=1024` };
}

test("task and processing cursors page independently and foreign processing records never render", async ({ page, api }) => {
    const reads: string[] = [];
    await page.route("**/api/tasks/history?**", route => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor"); reads.push(`task:${cursor}`);
        return route.fulfill({ json: { tasks: [{ id: cursor || "first", userId: owner, status: "success", prompt: cursor ? "原AI任务-旧" : "原AI任务-新", sourceUrls: [], resultUrls: [], createdAt: "2026-11-19T09:00:00Z", parameters: {} }], nextCursor: cursor ? null : "tasks-old", hasMore: !cursor } });
    });
    await page.route("**/api/assets/local-processing?**", route => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor"); reads.push(`local:${cursor}`);
        return route.fulfill({ json: { records: [historyRecord(cursor ? 1 : 2)], nextCursor: cursor ? null : "local-old", hasMore: !cursor } });
    });
    await page.goto("/creative/pattern-colorway");
    await expect(page.getByRole("button", { name: /^查看云端记录/ })).toHaveCount(2);
    await page.getByRole("button", { name: "加载更多云端记录", exact: true }).click();
    await expect(page.getByRole("button", { name: /^查看云端记录/ })).toHaveCount(4);
    expect(reads.filter(read => !read.endsWith(":null")).sort()).toEqual(["local:local-old", "task:tasks-old"]);
    expect(reads.filter(read => read === "local:null").length).toBeGreaterThan(0);
    expect(reads.filter(read => read === "local:null")).toHaveLength(reads.filter(read => read === "task:null").length);
    await page.route("**/api/assets/local-processing?**", route => route.fulfill({ json: { records: [{ ...historyRecord(4), ownerUserId: "another-owner", prompt: "其他账号的私密成果" }], nextCursor: null, hasMore: false } }));
    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("归属或分页信息异常");
    await expect(page.getByText("其他账号的私密成果")).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});
