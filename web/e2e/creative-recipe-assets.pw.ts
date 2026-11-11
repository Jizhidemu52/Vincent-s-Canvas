import { test, expect, IMAGE, fixturePng, type MockCanvasApi } from "./fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { createHash } from "node:crypto";

const owner = "00000000-0000-4000-8000-000000000099";
const primaryId = "79100000-0000-4000-8000-000000000001";
const secondaryId = "79100000-0000-4000-8000-000000000002";

async function library(context: BrowserContext, api: MockCanvasApi) {
    const assets = [primaryId, secondaryId].map((id, index) => ({ id, ownerUserId: owner, ownerName: "隔离员工", departmentId: null, departmentName: null, projectId: null, projectName: null, taskId: null,
        filename: index ? "pattern-original.png" : "primary-original.png", mimeType: "image/png", byteSize: IMAGE.length, kind: "image", source: "upload", status: "ready", visibilityScope: "private",
        metadata: { title: index ? "图案素材" : "底图素材", originalFileName: index ? "pattern-original.png" : "primary-original.png", imageName: index ? "原图案" : "原底图", imageVersion: 2, width: 256, height: 256 },
        createdAt: "2026-11-01T00:00:00Z", contentUrl: `/api/assets/${id}/content`, thumbnailUrl: `/api/assets/${id}/thumb?w=256`, resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0 }));
    assets.forEach((asset, index) => { api.assets.set(asset.id, asset); api.assetBytes.set(asset.id, index ? fixturePng(40) : IMAGE); });
    await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets, hasMore: false, nextCursor: null } }));
}

async function choose(page: Page, entry: Locator, title = "底图素材") {
    await expect(entry).toBeEnabled(); await entry.click();
    const modal = page.getByRole("dialog", { name: "选择素材", exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole("button").filter({ has: page.getByRole("img", { name: title, exact: true }) }).click();
    await expect(modal).not.toBeVisible();
}

async function bytes(image: Locator) {
    return Buffer.from(await image.evaluate(async element => [...new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())]));
}

async function stored(page: Page, store: string, key: string) {
    return page.evaluate(({ owner, store, key }) => new Promise<any>((resolve, reject) => {
        const opening = indexedDB.open(`wireless-canvas:oa:user:${owner}`);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const db = opening.result, read = db.transaction(store, "readonly").objectStore(store).get(key);
            read.onsuccess = () => { db.close(); resolve(read.result); }; read.onerror = () => reject(read.error);
        };
    }), { owner, store, key });
}

for (const scene of ["style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft", "virtual-try-on", "sketch-to-photo"]) {
    test(`${scene}: library original fills its primary role without generating`, async ({ page, context, api }) => {
        await library(context, api); await page.goto(`/creative/${scene}`);
        await choose(page, page.getByRole("button", { name: /^从素材库选择/ }).first());
        const preview = page.locator(".cs-upload-preview").first();
        await expect(preview).toBeVisible(); expect(await bytes(preview)).toEqual(IMAGE);
        await expect(page.getByText("已从素材库加入底图素材；原素材保持不变。", { exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength(0);
    });
}

test("creative two-role assets keep independent originals, metadata and previews through refresh", async ({ page, context, api }, info) => {
    await library(context, api); await page.goto("/creative/accessory-design");
    await choose(page, page.getByRole("button", { name: "从素材库选择辅料图", exact: true }));
    await choose(page, page.getByRole("button", { name: "从素材库选择图案图", exact: true }), "图案素材");
    expect(await bytes(page.getByRole("img", { name: "primary-original.png", exact: true }))).toEqual(IMAGE);
    expect(await bytes(page.getByRole("img", { name: "pattern-original.png", exact: true }))).toEqual(fixturePng(40));
    await expect.poll(async () => (await stored(page, "creative_scene_workspaces", `draft:${owner}:accessory-design`))?.images.secondary?.sourceAssetId).toBe(secondaryId);
    const draft = await stored(page, "creative_scene_workspaces", `draft:${owner}:accessory-design`);
    expect(draft.images.primary).toMatchObject({ storageKey: expect.stringMatching(/^image:/), originalFileName: "primary-original.png", imageName: "原底图", imageVersion: 2, sourceAssetId: primaryId });
    await page.reload(); await expect(page.getByRole("img", { name: "pattern-original.png", exact: true })).toBeVisible();
    expect(await bytes(page.getByRole("img", { name: "primary-original.png", exact: true }))).toEqual(IMAGE);
    await page.screenshot({ path: info.outputPath("creative-two-roles.png"), fullPage: true });
    await page.setViewportSize({ width: 760, height: 1000 });
    await expect(page.getByRole("button", { name: "从素材库选择辅料图", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("creative-two-roles-narrow.png"), fullPage: true });
    expect(api.submissions).toHaveLength(0);
});

test("creative library inputs preserve both originals and stay task-scoped", async ({ page, context, api }, info) => {
    await library(context, api); await page.goto("/creative/accessory-design");
    const primary = page.getByRole("button", { name: "从素材库选择辅料图", exact: true });
    const secondary = page.getByRole("button", { name: "从素材库选择图案图", exact: true });
    await expect(secondary).toBeEnabled(); await choose(page, primary); await choose(page, secondary, "图案素材");
    expect(await bytes(page.getByRole("img", { name: "primary-original.png", exact: true }))).toEqual(IMAGE);
    expect(await bytes(page.getByRole("img", { name: "pattern-original.png", exact: true }))).toEqual(fixturePng(40));
    await expect.poll(async () => (await stored(page, "creative_scene_workspaces", `draft:${owner}:accessory-design`))?.images?.secondary?.sourceAssetId).toBe(secondaryId);
    await page.screenshot({ path: info.outputPath("creative-task-two-roles.png"), fullPage: true });
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(page.getByRole("img", { name: "primary-original.png", exact: true })).toHaveCount(0);
    await choose(page, page.getByRole("button", { name: "从素材库选择辅料图", exact: true }), "图案素材");
    expect(await bytes(page.getByRole("img", { name: "pattern-original.png", exact: true }))).toEqual(fixturePng(40));
    const firstTask = page.getByRole("tab", { name: /^任务 1/ });
    await firstTask.click();
    // Activation commits its IndexedDB registry before changing the visible pane.
    // Do not capture an image handle from task 2 while that write is pending.
    await expect(firstTask).toHaveAttribute("aria-selected", "true");
    const restoredPrimary = await bytes(page.getByRole("img", { name: "primary-original.png", exact: true }));
    const digest = (value: Buffer) => ({ bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") });
    expect(restoredPrimary.equals(IMAGE), JSON.stringify({ expected: digest(IMAGE), received: digest(restoredPrimary) })).toBe(true);
    await page.reload(); await expect(page.getByRole("img", { name: "pattern-original.png", exact: true })).toBeVisible();
    expect(await bytes(page.getByRole("img", { name: "pattern-original.png", exact: true }))).toEqual(fixturePng(40));
    expect(api.submissions).toHaveLength(0);
});

test("creative shows source read failure inside the picker and leaves its original untouched", async ({ page, context, api }) => {
    await library(context, api); await page.goto("/creative/accessory-design");
    const entry = page.getByRole("button", { name: "从素材库选择辅料图", exact: true });
    await choose(page, entry); await context.route(`**/api/assets/${secondaryId}/content`, route => route.fulfill({ status: 500, body: "fixture image read failed" }));
    await entry.click(); const modal = page.getByRole("dialog", { name: "选择素材", exact: true });
    await modal.getByRole("button").filter({ has: page.getByRole("img", { name: "图案素材", exact: true }) }).click();
    await expect(modal.getByRole("alert")).toContainText("素材读取失败，请重试");
    await expect(modal.getByRole("alert")).toContainText("图片读取失败（500）");
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    expect(await bytes(page.getByRole("img", { name: "primary-original.png", exact: true }))).toEqual(IMAGE);
    expect(api.submissions).toHaveLength(0);
});

test("creative picks a previous-page local blob using its persisted key and preserves original metadata", async ({ page, context, api }) => {
    await library(context, api); await page.goto("/creative/style-to-sketch");
    await page.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "initialize.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("img", { name: "initialize.png", exact: true })).toBeVisible();
    await page.goto("/creative/accessory-design");
    await page.evaluate(async ({ owner, bytes }) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" }), previousUrl = URL.createObjectURL(blob);
        const asset = { id: "persisted-local-recipe", ownerId: owner, kind: "image", title: "刷新前原素材", coverUrl: previousUrl, tags: [], createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
            metadata: { serverAssetId: "local-original", designerId: owner, originalFileName: "local-original.png", imageName: "原底图", imageVersion: 4 },
            data: { dataUrl: previousUrl, storageKey: "image:persisted-recipe-original", width: 256, height: 256, bytes: blob.size, mimeType: "image/png" } };
        await new Promise<void>((resolve, reject) => {
            const opening = indexedDB.open(`wireless-canvas:oa:user:${owner}`); opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => { try { const db = opening.result, transaction = db.transaction(["app_state", "image_files"], "readwrite");
                transaction.objectStore("image_files").put(blob, asset.data.storageKey);
                transaction.objectStore("app_state").put(JSON.stringify({ state: { assets: [asset] }, version: 0 }), "wireless-canvas:asset_store");
                transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onerror = () => reject(transaction.error); } catch (error) { reject(error); } };
        });
    }, { owner, bytes: [...fixturePng(60)] });
    await page.reload(); await choose(page, page.getByRole("button", { name: "从素材库选择辅料图", exact: true }), "刷新前原素材");
    expect(await bytes(page.getByRole("img", { name: "local-original.png", exact: true }))).toEqual(fixturePng(60));
    await expect.poll(async () => (await stored(page, "creative_scene_workspaces", `draft:${owner}:accessory-design`))?.images?.primary?.storageKey).toBe("image:persisted-recipe-original");
    expect((await stored(page, "creative_scene_workspaces", `draft:${owner}:accessory-design`)).images.primary).toMatchObject({ originalFileName: "local-original.png", imageName: "原底图", imageVersion: 4, sourceAssetId: "local-original" });
    await page.reload(); await expect(page.getByRole("img", { name: "local-original.png", exact: true })).toBeVisible();
    expect(await bytes(page.getByRole("img", { name: "local-original.png", exact: true }))).toEqual(fixturePng(60));
    await expect.poll(async () => (await stored(page, "creative_scene_workspaces", `draft:${owner}:accessory-design`))?.images?.primary?.storageKey).toBe("image:persisted-recipe-original");
    expect((await stored(page, "creative_scene_workspaces", `draft:${owner}:accessory-design`)).images.primary).toMatchObject({ originalFileName: "local-original.png", imageName: "原底图", imageVersion: 4, sourceAssetId: "local-original" });
    expect(api.submissions).toHaveLength(0);
});
