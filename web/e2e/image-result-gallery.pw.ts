import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, fixturePng, type MockCanvasApi } from "./fixtures";

const owner = "00000000-0000-4000-8000-000000000099";
const active = (page: Page) => page.getByRole("tabpanel");
const thumbs = (page: Page) => active(page).getByRole("group", { name: "结果缩略图", exact: true }).getByRole("button");
const visibleSlot = (page: Page) => active(page).locator(".image-result-slot:visible");

async function historyBounds(page: Page, width: number, output: string) {
    const cards = active(page).locator(".image-history-card");
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) {
        expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const bounds = await card.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        await expect(card.locator(".image-history-card-meta > div").last()).toContainText("北京时间");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, `history-cards-${width}.png`) });
}

async function seedHistory(page: Page, count: number) {
    await page.goto("/image");
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toBeEnabled();
    await page.evaluate(async ({ owner, images }) => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { defaultConfig } = await import("/src/stores/use-config-store.ts");
        const logs = createWorkspaceStorage("image_generation_logs"), media = createWorkspaceStorage("image_files");
        for (const [order, id] of ["older", "latest"].entries()) {
            const storedImages = [];
            for (const [index, url] of images.entries()) {
                const blob = await (await fetch(url)).blob(), storageKey = `${id}-${index}`;
                await media.setItem(storageKey, blob);
                storedImages.push({ id: storageKey, storageKey, dataUrl: "", width: 256, height: 256, bytes: blob.size, durationMs: 1 });
            }
            await logs.setItem(id, { id, ownerId: owner, workspaceId: "default", tool: "image-generation", title: `图库历史 ${id}`, prompt: `历史提示词 ${id}`, createdAt: 1700000000000 + order,
                config: { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2" }, model: "gpt-image-2", status: "成功", successCount: storedImages.length, imageCount: storedImages.length, failCount: 0, references: [], durationMs: 1, images: storedImages });
        }
    }, { owner, images: Array.from({ length: count }, (_, index) => `data:image/png;base64,${fixturePng(35 + index * 25).toString("base64")}`) });
    await page.reload();
    await expect(thumbs(page)).toHaveCount(count);
}

test("gallery selects original images and retains independent task and history selections", async ({ page, api }, testInfo) => {
    const output = testInfo.outputPath("screenshots");
    await page.setViewportSize({ width: 1366, height: 768 });
    await seedHistory(page, 3);
    await thumbs(page).nth(2).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "latest-2");
    await expect(visibleSlot(page).getByRole("img", { name: "生成结果 3", exact: true })).toBeVisible();
    await expect(active(page).getByRole("button", { name: "下载", exact: true })).toHaveCount(1);
    const downloadPromise = page.waitForEvent("download");
    await visibleSlot(page).getByRole("button", { name: "下载", exact: true }).click();
    const download = await downloadPromise, chunks: Buffer[] = [];
    for await (const chunk of (await download.createReadStream())!) chunks.push(Buffer.from(chunk));
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    expect(hash(Buffer.concat(chunks))).toBe(hash(fixturePng(85)));
    await active(page).getByRole("tab", { name: /^历史记录/ }).click();
    await historyBounds(page, 1366, output);
    await active(page).locator(".image-history-panel button").filter({ hasText: "图库历史 older" }).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "older-0");
    await thumbs(page).nth(1).click();
    await active(page).getByRole("button", { name: "返回当前任务", exact: true }).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "latest-2");
    await active(page).getByRole("tab", { name: /^历史记录/ }).click();
    await active(page).locator(".image-history-panel button").filter({ hasText: "图库历史 older" }).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "older-1");
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(visibleSlot(page)).toHaveCount(0);
    await active(page).getByRole("tab", { name: /^历史记录/ }).click();
    await active(page).locator(".image-history-panel button").filter({ hasText: "图库历史 older" }).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "older-0");
    await page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab").first().click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "older-1");
    expect(api.submissions).toEqual([]);
    await mkdir(output, { recursive: true });
    await active(page).getByRole("button", { name: "返回当前任务", exact: true }).click();
    await visibleSlot(page).getByRole("img", { name: "生成结果 3", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, "gallery-1366-preview.png") });
    await active(page).getByRole("group", { name: "结果缩略图", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, "gallery-1366-controls.png") });
});

async function seedPending(page: Page, api: MockCanvasApi) {
    await page.goto("/image");
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toBeEnabled();
    const ids = ["gallery-first", "gallery-second", "gallery-third"];
    for (const [index, id] of ids.entries()) {
        api.tasks.set(id, { id, userId: owner, requestId: `${id}-request:0`, operationType: "image_generation", tool: "image-generation", status: "processing", prompt: `原槽 ${index + 1}`, resultUrls: [], failureReason: null });
        api.assetBytes.set(id, fixturePng(60 + index * 60));
    }
    await page.evaluate(async ({ ids, owner }) => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { defaultConfig } = await import("/src/stores/use-config-store.ts");
        const pending = createWorkspaceStorage("image_pending_tasks");
        for (const [index, id] of ids.entries()) await pending.setItem(id, { id, ownerId: owner, workspaceId: "default", tool: "image-generation", createdAt: 1700000000000 + index, requestId: `${id}-request`, taskId: id,
            snapshot: { text: `原槽 ${index + 1}`, config: { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", count: "1" }, references: [] } });
    }, { ids, owner });
    await page.reload();
    await expect(thumbs(page)).toHaveCount(3);
    return ids;
}

test("reverse completion never steals selection and retry addresses the original failed slot", async ({ page, api }) => {
    const ids = await seedPending(page, api);
    await thumbs(page).nth(1).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", ids[1]);
    for (const index of [2, 0]) {
        const task = api.tasks.get(ids[index])!; task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`];
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(thumbs(page).nth(index)).toContainText("已完成");
        await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", ids[1]);
    }
    api.tasks.get(ids[1])!.status = "failed";
    api.tasks.get(ids[1])!.failureReason = "原槽2模拟失败";
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(thumbs(page).nth(1)).toContainText("失败");
    await expect(visibleSlot(page).getByRole("button", { name: "按原参数重试", exact: true })).toBeEnabled();
    await visibleSlot(page).getByRole("button", { name: "按原参数重试", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].prompt).toContain("原槽 2");
    await expect(thumbs(page).nth(1)).toContainText("已完成");
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", ids[1]);
    await expect(visibleSlot(page)).toHaveAttribute("data-result-index", "1");
    await expect(thumbs(page)).toHaveCount(3);
    for (const index of [0, 2]) {
        await thumbs(page).nth(index).click();
        await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", ids[index]);
        await expect(visibleSlot(page).getByRole("img", { name: `生成结果 ${index + 1}`, exact: true })).toBeVisible();
    }
    const persisted = await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const values: unknown[] = []; await createWorkspaceStorage("image_generation_logs").iterate(value => { values.push(value); });
        return JSON.stringify(values);
    });
    expect(persisted).not.toContain("displayId");
    expect(JSON.stringify(api.submissions)).not.toContain("displayId");
});

test("390px thumbnail strip scrolls without viewport overflow and single results have no strip", async ({ page, api }, testInfo) => {
    const output = testInfo.outputPath("screenshots");
    await page.setViewportSize({ width: 390, height: 844 });
    await seedHistory(page, 8);
    await thumbs(page).nth(7).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "latest-7");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const image = visibleSlot(page).getByRole("img", { name: "生成结果 8", exact: true });
    expect(await image.evaluate(element => getComputedStyle(element).objectFit)).toBe("contain");
    expect(await active(page).locator(".image-result-thumbnails").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await image.scrollIntoViewIfNeeded();
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, "gallery-390.png") });
    await active(page).getByRole("tab", { name: /^历史记录/ }).click();
    await historyBounds(page, 390, output);
    await active(page).getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(visibleSlot(page)).toHaveAttribute("data-result-slot", "latest-7");
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill("单图不需要缩略图条");
    await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(visibleSlot(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    await expect(active(page).getByRole("group", { name: "结果缩略图", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(1);
});
