import { test, expect, IMAGE } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import type { Locator, Page } from "@playwright/test";
import { createSceneForm } from "../src/pages/creative/scene-form-model";

async function inViewport(locator: Locator, height: number) {
    await expect(locator).toBeVisible();
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
}

async function pasteReference(page: Page, label: string) {
    await page.getByRole("textbox", { name: label, exact: true }).evaluate((element, bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([Uint8Array.from(bytes)], "粘贴原图.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...IMAGE]);
}

test("desktop: persistent tool-scoped drafts and references with a visible submit footer", async ({ page, api }, info) => {
    await page.goto("/image");
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await expect(prompt).toBeVisible();
    await expect(page.getByText("还差：填写提示词", { exact: true })).toBeVisible();
    await inViewport(page.getByRole("button", { name: "开始生成", exact: true }), 900);
    await prompt.fill("图像生成独立草稿");
    await pasteReference(page, "图像提示词");
    await expect(page.getByRole("img", { name: "粘贴原图.png", exact: true })).toBeVisible();
    await page.locator(".generation-form").evaluate((element, bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([Uint8Array.from(bytes)], "拖入原图.png", { type: "image/png" }));
        element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    }, [...IMAGE]);
    await expect(page.getByRole("img", { name: "拖入原图.png", exact: true })).toBeVisible();
    await page.reload();
    await expect(prompt).toHaveValue("图像生成独立草稿");
    await expect(page.getByRole("img", { name: "粘贴原图.png", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "拖入原图.png", exact: true })).toBeVisible();
    await page.goto("/image?tool=angle-control");
    await expect(prompt).toHaveValue("");
    await prompt.fill("角度控制独立草稿");
    await page.goto("/image");
    await expect(prompt).toHaveValue("图像生成独立草稿");
    await page.screenshot({ path: info.outputPath("image-desktop.png") });
    expect(api.submissions).toHaveLength(0);
});

test("desktop: viewing generated image preserves the draft, explicit reuse confirms, canvas receives original bytes", async ({ page, api }, info) => {
    await page.goto("/image");
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await prompt.fill("原任务服装设计");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    await prompt.fill("下一条正在编辑的草稿");
    await page.locator(".ant-image").last().click();
    await expect(prompt).toHaveValue("下一条正在编辑的草稿");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "复用提示词", exact: true }).last().click();
    await expect(page.getByRole("dialog")).toContainText("替换当前草稿");
    await page.getByRole("button", { name: "保留草稿", exact: true }).click();
    await expect(prompt).toHaveValue("下一条正在编辑的草稿");
    expect(api.submissions).toHaveLength(1);
    await page.getByRole("button", { name: "放入画布", exact: true }).click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    expect(api.document(id)!.nodes[0].metadata.prompt).toBe("原任务服装设计");
    expect(api.assetBytes.size).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: info.outputPath("image-result-canvas.png") });
    expect(api.submissions).toHaveLength(1);
});

test("mobile: image and video primary actions remain visible and video draft survives reload", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().route("**/api/models", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [
        { id: "image-model", name: "隔离图像模型", modelId: "gpt-image-2", capabilities: ["generate", "edit"], protocol: "openai", providerName: "隔离测试" },
        { id: "video-model", name: "隔离视频模型", modelId: "MiniMax-H3", capabilities: ["video"], protocol: "apimart", providerName: "隔离测试" },
    ], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: tool.toolKey.includes("video") ? "video-model" : "image-model", configurationVersion: 1 })) }) }));
    await page.goto("/image");
    await inViewport(page.getByRole("button", { name: "开始生成", exact: true }), 844);
    await expect(page.getByText("还差：填写提示词", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("image-mobile.png") });
    await page.goto("/video");
    await inViewport(page.getByRole("button", { name: "生成视频", exact: true }), 844);
    await expect(page.getByText("还差：填写提示词", { exact: true })).toBeVisible();
    const prompt = page.getByRole("textbox", { name: "视频提示词", exact: true });
    await prompt.fill("移动端视频草稿");
    await pasteReference(page, "视频提示词");
    await expect(page.getByRole("button", { name: "移除参考图", exact: true })).toBeVisible();
    await page.reload();
    await expect(prompt).toHaveValue("移动端视频草稿");
    await expect(page.getByRole("button", { name: "移除参考图", exact: true })).toBeVisible();
    await inViewport(page.getByRole("button", { name: "生成视频", exact: true }), 844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("video-mobile.png") });
    expect(api.submissions).toHaveLength(0);
});

test("queued cancellation is explicit, calls the original task once and verifies its final state", async ({ page, api }) => {
    api.taskStatus = "waiting";
    const cancellations: string[] = [];
    await page.context().route("**/api/tasks/**", async route => {
        const path = new URL(route.request().url()).pathname;
        const id = path.split("/")[3]!;
        const task = api.tasks.get(id);
        if (!task) return route.fallback();
        if (path.endsWith("/cancel")) {
            cancellations.push(id); task.status = "cancelled";
            return route.fulfill({ status: 204, body: "" });
        }
        if (path === `/api/tasks/${id}`) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task: { ...task, attempts: 0, upstreamTaskId: null, submissionStartedAt: null } }) });
        return route.fallback();
    });
    await page.goto("/image");
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("只取消尚未发往上游的原任务");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    const cancel = page.getByRole("button", { name: "取消任务", exact: true });
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(page.getByRole("dialog")).toContainText("尚未提交上游");
    await page.getByRole("button", { name: "保留任务", exact: true }).click();
    expect(cancellations).toEqual([]);
    await cancel.click();
    await page.getByRole("button", { name: "确认取消任务", exact: true }).click();
    await expect.poll(() => cancellations.length).toBe(1);
    expect(api.tasks.get(cancellations[0]!)?.status).toBe("cancelled");
    await expect(page.getByText("任务已取消；额度以账户记录为准。", { exact: true }).first()).toBeVisible();
    expect(api.submissions).toHaveLength(1);
});

test("creative history removal confirms and cannot remove an unresolved tracking record", async ({ page, api }) => {
    await page.goto("/creative/text-to-style");
    await expect(page.getByRole("button", { name: /最近任务/ })).toBeVisible();
    await expect(page.getByText("正在恢复场景草稿…", { exact: true })).toHaveCount(0);
    const ownerId = "00000000-0000-4000-8000-000000000099", sceneId = "text-to-style";
    const base = { ownerId, sceneId, createdAt: 100, prompt: "保留原始设计", form: createSceneForm(sceneId), config: { model: "gpt-image-2", imageModel: "gpt-image-2", count: "1", size: "1024x1024", quality: "auto" }, referenceImages: {}, images: [], durationMs: 1 };
    const records = [
        { ...base, id: "finished", results: [{ id: "finished-result", status: "success" }], successCount: 1, failCount: 0 },
        { ...base, id: "unresolved", results: [{ id: "unresolved-result", status: "pending", requestId: "unresolved:0" }], successCount: 0, failCount: 0 },
    ];
    // Historical input fixture, written to the same public IndexedDB partition used by the page.
    await page.evaluate(async ({ ownerId, sceneId, records }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(`wireless-canvas:oa:user:${ownerId}`); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction("creative_scene_workspaces", "readwrite");
            const store = transaction.objectStore("creative_scene_workspaces");
            for (const record of records) store.put(record, `history-record:${ownerId}:${sceneId}:${record.id}`);
            store.put({ version: 1, entries: records.map(record => ({ id: record.id, ownerId, sceneId, createdAt: record.createdAt, successCount: record.successCount, failCount: record.failCount, hasSelection: false, unresolvedCount: record.id === "unresolved" ? 1 : 0 })) }, `history-index:${ownerId}:${sceneId}`);
            transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
        }); db.close();
    }, { ownerId, sceneId, records });
    await page.reload();
    await page.getByRole("button", { name: /最近任务/ }).click();
    const deletions = page.getByRole("button", { name: "删除", exact: true });
    await expect(deletions).toHaveCount(2);
    await expect(deletions.nth(1)).toBeDisabled();
    await deletions.first().click();
    await expect(page.getByRole("dialog")).toContainText("原图与服务端任务仍保留");
    await page.getByRole("button", { name: "保留记录", exact: true }).click();
    await expect(deletions).toHaveCount(2);
    await deletions.first().click();
    await page.getByRole("button", { name: "删除记录", exact: true }).click();
    await expect(deletions).toHaveCount(1);
    await expect(deletions).toBeDisabled();
    expect(api.submissions).toHaveLength(0);
});
