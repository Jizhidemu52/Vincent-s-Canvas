import { test, expect, IMAGE } from "./fixtures";
import type { Page } from "@playwright/test";
import { toolDefinitions } from "../../shared/feature-catalog";

const owner = "00000000-0000-4000-8000-000000000099";
const imageId = "79000000-0000-4000-8000-000000000001";

async function persistPreviousPageAsset(page: Page) {
    await page.goto("/image?tool=image-edit");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).first().click();
    await (await chooser).setFiles({ name: "initialize-storage.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "initialize-storage.png", exact: true })).toBeVisible();
    // Seed a persisted asset from a previous page, not a live React/Zustand state.
    await page.evaluate(async ({ owner, bytes }) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const previousUrl = URL.createObjectURL(blob);
        const asset = { id: "persisted-local-original", ownerId: owner, kind: "image", title: "刷新前保存的素材", coverUrl: previousUrl, tags: [],
            createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", metadata: { serverAssetId: "persisted-library-reference", designerId: owner },
            data: { dataUrl: previousUrl, storageKey: "image:persisted-picker-original", width: 256, height: 256, bytes: blob.size, mimeType: "image/png" } };
        await new Promise<void>((resolve, reject) => {
            const opening = indexedDB.open(`wireless-canvas:oa:user:${owner}`);
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
                const db = opening.result;
                const transaction = db.transaction(["app_state", "image_files"], "readwrite");
                transaction.objectStore("image_files").put(blob, asset.data.storageKey);
                transaction.objectStore("app_state").put(JSON.stringify({ state: { assets: [asset] }, version: 0 }), "wireless-canvas:asset_store");
                transaction.oncomplete = () => { db.close(); resolve(); };
                transaction.onerror = () => reject(transaction.error);
            };
        });
    }, { owner, bytes: [...IMAGE] });
    await page.reload();
}

test("previous-page library blob is restored before image-edit insertion", async ({ page, api }) => {
    await persistPreviousPageAsset(page);
    await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
    const thumbnail = dialog.getByRole("img", { name: "刷新前保存的素材", exact: true });
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(256);
    await dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "刷新前保存的素材", exact: true }) }).click();
    await dialog.getByRole("button", { name: /加入1.*张参考图/ }).click();
    await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "刷新前保存的素材", exact: true })).toBeVisible();
    await expect(page.getByText("已加入参考图", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

const serverImage = (id: string, title: string) => ({ id, ownerUserId: owner, ownerName: "隔离员工", departmentId: null, departmentName: null, projectId: null, projectName: null, taskId: null,
    filename: `${title}.png`, mimeType: "image/png", byteSize: IMAGE.length, kind: "image", source: "upload", status: "ready", visibilityScope: "private",
    metadata: { title, width: 256, height: 256 }, createdAt: "2026-11-01T00:00:00Z", contentUrl: `/api/assets/${id}/content`, thumbnailUrl: `/api/assets/${id}/thumb?w=256`,
    resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0 });

for (const path of ["/image", "/image?tool=image-edit", "/image?tool=midjourney-blend", "/remove-background", "/hd-upscale", "/item-extract"]) {
    test(`shared image board accepts library originals: ${path}`, async ({ page, context, api }) => {
        const asset = serverImage(imageId, "跨板块原图"); api.assets.set(imageId, asset); api.assetBytes.set(imageId, IMAGE);
        await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets: [asset], hasMore: false } }));
        await page.goto(path);
        await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
        await dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "跨板块原图", exact: true }) }).click();
        await dialog.getByRole("button", { name: /加入1.*张参考图/ }).click();
        await expect(dialog).not.toBeVisible();
        await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "跨板块原图", exact: true })).toBeVisible();
        await expect(page.getByText("已加入参考图", { exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength(0);
    });
}

for (const entry of [
    { path: "/video", button: "我的素材", success: "已加入参考图" },
    { path: "/image?tool=seamless-stitch", button: "素材库", success: "已加入参考图" },
    { path: "/creative/pattern-placement", button: "从素材库选择底图", success: "素材库底图已加入；工程保留图片副本，原素材不变。" },
    { path: "/creative/pattern-repeat", button: "从素材库添加元素", success: "元素已加入。文件原有透明度保留，不自动去背景。" },
]) {
    test(`single-image board accepts library originals: ${entry.path}`, async ({ page, context, api }) => {
        const asset = serverImage(imageId, "单图板块原图"); api.assets.set(imageId, asset); api.assetBytes.set(imageId, IMAGE);
        await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets: [asset], hasMore: false } }));
        if (entry.path === "/video") {
            const model = { id: "10000000-0000-4000-8000-000000000003", name: "隔离视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
            await context.route("**/api/models", route => route.fulfill({ json: { models: [model], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })), prices: [] } }));
        }
        await page.goto(entry.path);
        await page.getByRole("button", { name: entry.button, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
        await dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "单图板块原图", exact: true }) }).click();
        await expect(dialog).not.toBeVisible();
        await expect(page.getByText(entry.success, { exact: true }).first()).toBeVisible();
        expect(api.submissions).toHaveLength(0);
    });
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    test(`selection footer stays visible after lower-card selection at ${viewport.width}px`, async ({ page, context, api }, testInfo) => {
        await page.setViewportSize(viewport);
        const assets = Array.from({ length: 24 }, (_, index) => serverImage(`footer-${index}`, `原图${index + 1}`));
        for (const asset of assets) { api.assets.set(asset.id, asset); api.assetBytes.set(asset.id, IMAGE); }
        await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets, hasMore: false, nextCursor: null } }));
        await page.goto("/image?tool=image-edit");
        await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
        const lower = dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "原图24", exact: true }) });
        await lower.scrollIntoViewIfNeeded(); await lower.click();
        await expect(lower).toHaveAttribute("aria-pressed", "true");
        await expect(lower.getByText("已选中", { exact: true })).toBeVisible();
        await expect(dialog.getByText("已选中 1 张图片", { exact: true })).toBeVisible();
        const confirm = dialog.getByRole("button", { name: /加入1.*张参考图/ });
        await expect(confirm).toBeEnabled();
        const box = await confirm.boundingBox();
        expect(box).not.toBeNull(); expect(box!.y).toBeGreaterThan(0); expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`selected-footer-${viewport.width}.png`), animations: "disabled" });
        await confirm.click();
        await expect(dialog).not.toBeVisible();
        const reference = page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "原图24", exact: true });
        await expect(reference).toBeVisible();
        expect(Buffer.from(await reference.evaluate(async (element: HTMLImageElement) => [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())]))).toEqual(IMAGE);
        await expect(page.getByText("已加入参考图", { exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength(0);
    });
}

test("view-my-assets single insertion shows the original input and completion feedback", async ({ page, context, api }) => {
    const asset = serverImage(imageId, "单图素材原件"); api.assets.set(imageId, asset); api.assetBytes.set(imageId, IMAGE);
    await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets: [asset], hasMore: false } }));
    await page.goto("/image?tool=image-edit");
    await page.getByRole("button", { name: "查看我的素材", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
    await dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "单图素材原件", exact: true }) }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "单图素材原件", exact: true })).toBeVisible();
    await expect(page.getByText("已加入参考图", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

test("failed server original keeps the selected picker open and never claims success", async ({ page, context, api }) => {
    const asset = serverImage(imageId, "缺失原图"); api.assets.set(imageId, asset); api.assetBytes.set(imageId, IMAGE);
    await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets: [asset], hasMore: false } }));
    await context.route(url => url.pathname === `/api/assets/${imageId}/content`, route => route.fulfill({ status: 503, body: "temporarily unavailable" }));
    await page.goto("/image?tool=image-edit");
    await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
    const card = dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "缺失原图", exact: true }) });
    await card.click(); await dialog.getByRole("button", { name: /加入1.*张参考图/ }).click();
    await expect(page.getByText("图片读取失败（503），请重新添加图片", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible(); await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("已加入参考图", { exact: true })).not.toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

for (const multiple of [false, true]) {
    for (const boundary of ["task", "owner"] as const) {
        test(`delayed ${multiple ? "multiple" : "single"} library read respects ${boundary} isolation`, async ({ page, context, api }) => {
            const asset = serverImage(imageId, "延迟素材原件"); api.assets.set(imageId, asset); api.assetBytes.set(imageId, IMAGE);
            await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets: [asset], hasMore: false } }));
            let release!: () => void, entered!: () => void;
            const readStarted = new Promise<void>(resolve => { entered = resolve; });
            const readGate = new Promise<void>(resolve => { release = resolve; });
            await context.route(url => url.pathname === `/api/assets/${imageId}/content`, async route => { entered(); await readGate; await route.fulfill({ contentType: "image/png", body: IMAGE }); });
            await page.goto("/image?tool=image-edit");
            await page.getByRole("button", { name: multiple ? "从素材库选择" : "查看我的素材", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
            await dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "延迟素材原件", exact: true }) }).click();
            if (multiple) await dialog.getByRole("button", { name: /加入1.*张参考图/ }).click();
            await readStarted;
            if (boundary === "task") {
                await dialog.getByRole("button", { name: "Close", exact: true }).click();
                await page.getByRole("button", { name: "新建任务", exact: true }).click();
                const active = page.getByRole("tabpanel");
                await expect(page.getByRole("tab", { name: /^任务 2/ })).toHaveAttribute("aria-selected", "true");
                release();
                await expect(page.getByRole("tab", { name: /^任务 1/ })).not.toContainText("处理中");
                await expect(active.getByRole("region", { name: "参考图", exact: true }).getByRole("img")).toHaveCount(0);
                await page.getByRole("tab", { name: /^任务 1/ }).click();
                await expect(active.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "延迟素材原件", exact: true })).toBeVisible();
            } else {
                await context.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }));
                await page.evaluate(() => window.dispatchEvent(new Event("focus")));
                await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
                release();
                await page.reload();
                await expect(page.getByRole("button", { name: "从素材库选择", exact: true })).toBeVisible();
                await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img")).toHaveCount(0);
                await expect(page.getByText("已加入参考图", { exact: true })).not.toBeVisible();
            }
            expect(api.submissions).toHaveLength(0);
        });
    }
}
test("asset picker image selection reaches the real image-edit input", async ({ page, context, api }) => {
    const asset = { id: imageId, ownerUserId: owner, ownerName: "隔离员工", departmentId: null, departmentName: null, projectId: null, projectName: null, taskId: null,
        filename: "picker-original.png", mimeType: "image/png", byteSize: IMAGE.length, kind: "image", source: "upload", status: "ready", visibilityScope: "private",
        metadata: { title: "素材库原图", width: 256, height: 256 }, createdAt: "2026-11-01T00:00:00Z", contentUrl: `/api/assets/${imageId}/content`, thumbnailUrl: `/api/assets/${imageId}/thumb?w=256`,
        resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0 };
    api.assets.set(imageId, asset); api.assetBytes.set(imageId, IMAGE);
    await context.route(url => url.pathname === "/api/assets", route => route.fulfill({ json: { assets: [asset], hasMore: false, nextCursor: null } }));
    await page.goto("/image?tool=image-edit");
    await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
    const card = dialog.getByRole("button").filter({ has: page.getByRole("img", { name: "素材库原图", exact: true }) });
    await expect(card).toBeVisible();
    await card.click();
    const confirm = dialog.getByRole("button", { name: /加入1.*张参考图/ });
    await expect(confirm).toBeEnabled(); await confirm.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "素材库原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});
