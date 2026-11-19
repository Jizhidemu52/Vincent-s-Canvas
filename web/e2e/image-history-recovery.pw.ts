import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";
import { activeWorkbench, readWorkspaceRecords } from "./headless-workbench";

async function uploadSource(page: Page) {
    const chooser = page.waitForEvent("filechooser");
    await activeWorkbench(page).getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "original-source.png", mimeType: "image/png", buffer: IMAGE });
    await expect(activeWorkbench(page).getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "original-source.png", exact: true })).toBeVisible();
}

async function downloadOriginal(page: Page, originalBytes: Buffer) {
    const event = page.waitForEvent("download");
    await activeWorkbench(page).getByRole("button", { name: "下载", exact: true }).click();
    const download = await event, chunks: Buffer[] = [];
    for await (const chunk of (await download.createReadStream())!) chunks.push(Buffer.from(chunk));
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    expect(digest(Buffer.concat(chunks))).toBe(digest(originalBytes));
}

for (const failure of ["history", "pending-cleanup", "image-cache"]) test(`image result remains visible through ${failure} failure without duplicate generation`, async ({ page, context, api }, info) => {
    const recoveries: string[] = [];
    await context.route("**/api/tasks/*/recover", route => { recoveries.push(route.request().url()); return route.abort(); });
    api.taskStatus = "paused";
    await page.goto("/image");
    await uploadSource(page);
    const pane = activeWorkbench(page);
    await pane.getByRole("textbox", { name: "图像提示词", exact: true }).fill(`Storage-safe original ${failure}`);
    await pane.getByRole("button", { name: "开始编辑", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(pane.getByRole("button", { name: "刷新进度", exact: true })).toBeVisible();
    const task = [...api.tasks.values()][0]!;
    const requestId = task.requestId;
    const originalBytes = api.assetBytes.get(task.id)!;
    let originalUrl = `/api/assets/${task.id}/content`;
    if (failure === "image-cache") {
        const assetDirectory = resolve(import.meta.dirname, "../../output/image-history-recovery/download-assets");
        await mkdir(assetDirectory, { recursive: true });
        const assetPath = resolve(assetDirectory, `${task.id}.png`);
        await writeFile(assetPath, originalBytes);
        originalUrl = `/@fs/${assetPath.replaceAll("\\", "/")}`;
    }
    await page.evaluate(mode => {
        const put = IDBObjectStore.prototype.put;
        const remove = IDBObjectStore.prototype.delete;
        (window as any).restoreImageStorageWrites = () => { IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.delete = remove; };
        IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
            if ((mode === "history" && this.name === "image_generation_logs" && value.successCount === 1) || (mode === "image-cache" && this.name === "image_files")) throw new DOMException(`isolated ${mode} failure`, "QuotaExceededError");
            return put.call(this, value, key);
        };
        IDBObjectStore.prototype.delete = function(key: IDBValidKey | IDBKeyRange) {
            if (mode === "pending-cleanup" && this.name === "image_pending_tasks") throw new DOMException("isolated pending cleanup failure", "QuotaExceededError");
            return remove.call(this, key);
        };
    }, failure);
    task.status = "success";
    task.resultUrls = [originalUrl];
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const warning = failure === "image-cache" ? /本地图片缓存保存失败/ : /本地记录保存失败/;
    await expect(pane.getByText(warning)).toBeVisible();
    const image = pane.getByRole("img", { name: "生成结果 1", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(256);
    await expect(pane.getByRole("button", { name: "刷新进度", exact: true })).toHaveCount(0);
    await downloadOriginal(page, originalBytes);
    await page.screenshot({ path: info.outputPath("original-with-storage-warning-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("original-with-storage-warning-mobile.png"), fullPage: true });
    const reads = api.taskReads.length;
    if (failure !== "image-cache") {
        await expect(pane.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
        await expect.poll(async () => (await readWorkspaceRecords(page, "image_pending_tasks")).length).toBe(1);
        if (failure === "history") {
            await pane.getByRole("button", { name: "停止自动刷新", exact: true }).click();
            await page.evaluate(() => { (window as any).restoreImageStorageWrites(); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
            await expect(pane.getByText(warning)).toBeVisible();
            expect(await readWorkspaceRecords(page, "image_generation_logs")).toHaveLength(0);
            expect((await readWorkspaceRecords<any>(page, "image_pending_tasks"))[0]!.value.stopped).toBe(true);
            await pane.getByRole("button", { name: "重试保存", exact: true }).click();
        } else await page.evaluate(() => { (window as any).restoreImageStorageWrites(); window.dispatchEvent(new Event("focus")); });
        await expect(pane.getByText(warning)).toHaveCount(0);
        await expect.poll(async () => (await readWorkspaceRecords(page, "image_pending_tasks")).length).toBe(0);
    } else await page.evaluate(() => (window as any).restoreImageStorageWrites());
    expect(api.taskReads).toHaveLength(reads);
    const logs = await readWorkspaceRecords<any>(page, "image_generation_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.value).toMatchObject({ tool: "image-edit", successCount: 1, images: [{ sourceTaskId: task.id }] });
    if (failure === "image-cache") expect(logs[0]!.value.images[0].dataUrl).toBe(originalUrl);
    expect(api.submissions).toHaveLength(1);
    expect(recoveries).toEqual([]);
    await page.reload();
    await expect(activeWorkbench(page).getByRole("button", { name: "下载", exact: true })).toBeVisible();
    await downloadOriginal(page, originalBytes);
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]!.requestId).toBe(requestId);
    expect(recoveries).toEqual([]);
    await page.screenshot({ path: info.outputPath("original-restored-after-reload-mobile.png"), fullPage: true });
});
