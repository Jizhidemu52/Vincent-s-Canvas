import { test, expect, newCanvas, uploadImage, IMAGE, type MockCanvasApi } from "./fixtures";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

const PRIVATE_RECIPE = "后台私有配方：只提取主体并保留细节";
async function managedQuickTask(page: Page, api: MockCanvasApi) {
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON();
        if (!input.parameters?.quickImageAction) return route.fallback();
        const id = randomUUID();
        const task = { ...input, id, userId: "00000000-0000-4000-8000-000000000099", status: api.taskStatus, prompt: PRIVATE_RECIPE,
            resultUrls: api.taskStatus === "success" ? [`/api/assets/${id}/content`] : [], failureReason: null, createdAt: new Date().toISOString() };
        api.submissions.push(input); api.tasks.set(id, task); api.assetBytes.set(id, IMAGE);
        api.assets.set(id, { id, ownerUserId: task.userId, status: "ready", mimeType: "image/png", contentUrl: `/api/assets/${id}/content` });
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ task }) });
    });
}

async function expectStandaloneActionOnly(page: Page) {
    await expect(page.getByRole("textbox", { name: "图像提示词" })).toHaveCount(0);
    // The shared reference tray owns a purpose selector, not a model control.
    // Every visible combobox must be that exact single-image tray control.
    const referencePurpose = page.getByRole("region", { name: "参考图", exact: true }).getByRole("combobox", { name: "图片1用途", exact: true });
    await expect.poll(async () => (await page.getByRole("combobox").count()) - (await referencePurpose.count())).toBe(0);
    await expect(page.getByRole("button", { name: /^(切换生成图片模型|调整|复用提示词|存为提示词|恢复为草稿继续改)$/ })).toHaveCount(0);
    await expect(page.getByText(/后台私有配方|内置配方|Nano 2\.1|MAI|4K|还差：选择模型/)).toHaveCount(0);
}

async function uploadStandaloneImage(page: Page) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "原图.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("region", { name: "参考图", exact: true })).toContainText("1 张");
}

test("remove-background exports the same transparent master as PNG or white-backed JPG without generating again", async ({ page, api }, testInfo) => {
    await page.goto("/remove-background");
    const source = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48;
        const context = canvas.getContext("2d")!; context.fillStyle = "#ff0000"; context.fillRect(16, 12, 32, 24);
        return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    await page.route("**/api/assets/*/content", async route => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        if (api.tasks.has(id)) api.assetBytes.set(id, source);
        await route.fallback();
    });
    await uploadStandaloneImage(page);
    await page.getByRole("button", { name: "一键去背景", exact: true }).click();
    await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    const taskId = [...api.tasks.keys()][0];
    for (const format of ["png", "jpg"] as const) {
        if (format === "jpg") await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "下载", exact: true }).click();
        const option = page.getByRole("menuitem", { name: format === "png" ? "透明 PNG" : "普通图片 JPG（白底）", exact: true });
        await expect(option).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`export-menu-${format}.png`), fullPage: true });
        const downloaded = page.waitForEvent("download"); await option.click();
        const file = await downloaded, path = testInfo.outputPath(`remove-background.${format}`);
        expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`)); await file.saveAs(path);
        const bytes = await readFile(path);
        if (format === "png") expect(bytes.equals(source)).toBe(true);
        else expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
        const pixels = await page.evaluate(async ({ base64, type }) => {
            const data = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([data], { type }));
            const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0); bitmap.close();
            return { width: canvas.width, height: canvas.height, corner: [...context.getImageData(0, 0, 1, 1).data] };
        }, { base64: bytes.toString("base64"), type: format === "png" ? "image/png" : "image/jpeg" });
        expect(pixels).toEqual({ width: 64, height: 48, corner: format === "png" ? [0, 0, 0, 0] : [255, 255, 255, 255] });
    }
    expect(api.submissions).toHaveLength(1);
    expect(api.assetBytes.get(taskId)?.equals(source)).toBe(true);
});

for (const action of ["remove-background", "hd-upscale", "item-extract"] as const) {
    test(`${action} standalone uses a managed server recipe with no prompt or model input`, async ({ page, api }, testInfo) => {
        const title = action === "remove-background" ? "一键去背景" : action === "item-extract" ? "提取产品图" : "高清放大";
        await managedQuickTask(page, api);
        // A designer need not see or select the privately managed processing model.
        await page.route("**/api/models", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [], prices: [], tools: [] }) }));
        await page.goto(`/${action}`);
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
        await expectStandaloneActionOnly(page);
        const submit = page.getByRole("button", { name: title, exact: true });
        await expect(submit).toBeDisabled();
        await uploadStandaloneImage(page);
        await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("combobox", { name: "图片1用途", exact: true })).toBeVisible();
        await expectStandaloneActionOnly(page);
        await expect(submit).toBeEnabled();
        expect(api.submissions).toHaveLength(0);
        await submit.click();
        await expect.poll(() => api.submissions.length).toBe(1);
        expect(api.submissions[0]).toMatchObject({ toolKey: action === "hd-upscale" ? "detail-enhance" : "image-edit", operationType: action === "hd-upscale" ? "upscale" : "inpaint", parameters: { quickImageAction: action } });
        expect(api.submissions[0]).not.toHaveProperty("prompt"); expect(api.submissions[0]).not.toHaveProperty("modelConfigId");
        expect(api.submissions[0].parameters).toEqual({ quickImageAction: action });
        await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
        await expectStandaloneActionOnly(page);
        await expect(page.getByRole("checkbox", { name: `选择记录：${title}`, exact: true })).toBeVisible();
        await expect.poll(() => page.getByRole("img", { name: "生成结果 1", exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
        await page.screenshot({ path: testInfo.outputPath(`${action}-desktop.png`), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "记录", exact: true }).click();
        await expect(page.getByRole("dialog").getByRole("checkbox", { name: `选择记录：${title}`, exact: true })).toBeVisible();
        await expectStandaloneActionOnly(page);
        await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${action}-390.png`), fullPage: true });
        await page.reload();
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
        await expectStandaloneActionOnly(page);
        expect(api.submissions).toHaveLength(1);
    });
}

test("an unresolved standalone request only refreshes its original task and cannot resubmit", async ({ page, api }) => {
    api.taskStatus = "paused";
    await page.goto("/remove-background");
    await uploadStandaloneImage(page);
    await page.getByRole("button", { name: "一键去背景", exact: true }).click();
    // A paused task without an upstream id needs investigation, not a new
    // submission. The visible wording is intentionally not "generation failed".
    await expect(page.getByText("需要管理员协助", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "一键去背景", exact: true })).toBeDisabled();
    expect(api.submissions).toHaveLength(1);
    const original = [...api.tasks.values()][0]!;
    const taskPath = `/api/tasks/${original.id}`;
    const readsBeforeRefresh = api.taskReads.filter(path => path === taskPath).length;
    await page.getByRole("button", { name: "刷新进度", exact: true }).click();
    await expect.poll(() => api.taskReads.filter(path => path === taskPath).length).toBeGreaterThan(readsBeforeRefresh);
    await expect(page.getByText("需要管理员协助", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    // On reload, the original result is adopted automatically. Do not race
    // that observer by clicking a recovery card which may already be gone.
    original.status = "success";
    original.resultUrls = [`/api/assets/${original.id}/content`];
    await page.reload();
    await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
    expect([...api.tasks.keys()]).toEqual([original.id]);
    expect(api.submissions).toHaveLength(1);
});

test("placing a processed result keeps its media but does not export the managed recipe or prevent ordinary editing", async ({ page, api }) => {
    // Hold real draft reads to exercise the same early-upload window as a slow browser store.
    await page.addInitScript(() => {
        const callbacks: Array<() => void> = [];
        const originalGet = IDBObjectStore.prototype.get;
        let holding = true;
        const gate = (window as any).__quickDraftReadGate = { pending: 0, release: () => {
            holding = false; IDBObjectStore.prototype.get = originalGet;
            for (const callback of callbacks.splice(0)) callback();
        } };
        IDBObjectStore.prototype.get = function (key) {
            const request = originalGet.call(this, key);
            if (this.name !== "generation_drafts") return request;
            const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")!;
            Object.defineProperty(request, "onsuccess", {
                set(handler) {
                    success.set!.call(request, (event: Event) => {
                        if (!holding) return handler.call(request, event);
                        gate.pending += 1; callbacks.push(() => handler.call(request, event));
                    });
                },
            });
            return request;
        };
    });
    await managedQuickTask(page, api);
    await page.goto("/remove-background");
    await expect.poll(() => page.evaluate(() => (window as any).__quickDraftReadGate.pending)).toBeGreaterThan(0);
    await expect(page.getByText("正在恢复草稿…", { exact: true })).toBeVisible();
    const upload = page.getByRole("button", { name: "上传图片", exact: true });
    await expect(upload).toBeDisabled();
    await expect(page.locator('input[type="file"]')).toBeDisabled();
    await page.evaluate(() => (window as any).__quickDraftReadGate.release());
    await expect(upload).toBeEnabled();
    await uploadStandaloneImage(page);
    await page.getByRole("button", { name: "一键去背景", exact: true }).click();
    await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    await page.getByRole("button", { name: "放入画布", exact: true }).click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const node = api.document(id)!.nodes[0];
    expect(node.metadata.prompt).toBeUndefined(); expect(node.metadata.model).toBeUndefined(); expect(node.metadata.sourceTaskId).toBeUndefined();
    const copied = [...api.assets.values()].find(asset => asset.clientReferenceId?.startsWith("result-canvas:"));
    expect(copied).toBeTruthy(); expect(copied!.metadata.prompt).toBeUndefined(); expect(copied!.metadata.model).toBeUndefined();
    expect(api.assetBytes.get(copied!.id)?.equals(IMAGE)).toBe(true);
    await page.locator(`[data-node-id="${node.id}"]`).click({ position: { x: 40, y: 60 } });
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const input = page.getByRole("textbox", { name: "描述图像", exact: true });
    await expect(input).toHaveValue(""); await input.fill("设计师自行填写的后续编辑要求");
    await page.locator(".cw-create-panel .cw-generate-button").click();
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.submissions[1].prompt).toContain("设计师自行填写的后续编辑要求");
    expect(api.submissions[1].prompt).not.toContain(PRIVATE_RECIPE);
    expect(api.submissions[1].parameters.quickImageAction).toBeUndefined();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(api.document(id)!.nodes[1].metadata.quickImageAction).toBeUndefined();
    expect([...api.tasks.values()][0].prompt).toBe(PRIVATE_RECIPE);
    await expect(page.getByText(/后台私有配方/)).toHaveCount(0);
});

test("selected canvas images show right-side actions, preserve the original and produce recoverable new nodes", async ({ page, api }, testInfo) => {
    await managedQuickTask(page, api);
    const id = await newCanvas(page); await uploadImage(page, "保留原图.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    const panel = page.getByTestId("canvas-image-quick-actions");
    await expect(panel).toBeVisible();
    await expect(panel.locator("input, textarea, select")).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveCount(2);
    await expect(panel.getByText(/内置配方|Nano 2\.1|MAI|4K/)).toHaveCount(0);
    const bounds = (await panel.boundingBox())!; expect(bounds.x).toBeGreaterThan(1000);
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(23, 23, 23)");
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-light.png") });
    await panel.getByRole("button", { name: "一键去背景", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(() => api.document(id)?.nodes[1]?.metadata?.status).toBe("success");
    expect(api.document(id)!.nodes[0]).toEqual(original);
    expect(api.submissions[0]).toMatchObject({ toolKey: "canvas-edit", operationType: "inpaint", parameters: { quickImageAction: "remove-background" } });
    expect(api.document(id)!.nodes[1].metadata.generationRecord.sourceNodeId).toBe(original.id);
    const quickResult = api.document(id)!.nodes[1];
    expect(quickResult.metadata.quickImageAction).toBe("remove-background");
    expect(quickResult.metadata.generationRecord.prompt).toBe(PRIVATE_RECIPE);
    expect(quickResult.metadata.generationRecord.parameters).toMatchObject({ model: "", quality: "" });
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await expect(page.getByTestId("canvas-generation-record")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "描述图像", exact: true })).toHaveValue("");
    await expect(page.getByText(/后台私有配方/)).toHaveCount(0);
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(242, 242, 242)");
    await page.mouse.move(800, 700);
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-dark.png") });
    await panel.getByRole("button", { name: "高清放大", exact: true }).hover();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("background-color", "rgb(48, 48, 48)");
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-dark-hover.png") });
    api.taskStatus = "paused";
    await panel.getByRole("button", { name: "高清放大", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(163, 163, 163)");
    await page.mouse.move(800, 700);
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-dark-disabled.png") });
    await page.getByRole("button", { name: "切换到浅色主题", exact: true }).click();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(104, 104, 104)");
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-light-disabled.png") });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible(); const small = (await panel.boundingBox())!;
    expect(small.x).toBeGreaterThanOrEqual(0); expect(small.x + small.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-390.png") });
});
