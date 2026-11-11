import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, IMAGE, fixturePng, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const active = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
async function expectActiveTabVisible(page: Page) {
    await expect.poll(async () => {
        const strip = await page.getByRole("tablist", { name: "任务列表", exact: true }).boundingBox();
        const selected = await tabs(page).filter({ has: page.locator(":scope[aria-selected=true]") }).boundingBox();
        return Boolean(strip && selected && selected.x >= strip.x - 1 && selected.x + selected.width <= strip.x + strip.width + 1);
    }).toBe(true);
}
async function openNext(page: Page, count: number) {
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(tabs(page)).toHaveCount(count);
    await expect(tabs(page).nth(count - 1)).toHaveAttribute("aria-selected", "true");
}
async function upload(page: Page, name: string, buffer = IMAGE) {
    const chooser = page.waitForEvent("filechooser");
    await active(page).getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: "image/png", buffer });
    await expect(active(page).getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name, exact: true })).toBeVisible();
}
function finish(api: MockCanvasApi, index: number, failed = false) {
    const task = [...api.tasks.values()][index];
    task.status = failed ? "failed" : "success";
    task.resultUrls = failed ? [] : [`/api/assets/${task.id}/content`];
    task.failureReason = failed ? "隔离测试：已确认失败，不自动重试" : null;
}
async function originalDigest(page: Page) {
    const image = active(page).getByRole("img", { name: "生成结果 1", exact: true });
    await expect(image).toBeVisible();
    // The displayed thumbnail is not the original. The preview opens the source
    // URL; the task's stored result bytes are verified independently below.
    return page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const entries: any[] = [];
        await createWorkspaceStorage("image_generation_logs").iterate(value => { entries.push(value); });
        return entries.map(log => ({ workspaceId: log.workspaceId, prompt: log.prompt, sourceTaskId: log.images[0]?.sourceTaskId, referenceNames: log.references.map((item: any) => item.name) }));
    });
}

for (const route of [
    { path: "/image", button: "开始生成", prompt: true, reference: false },
    { path: "/image?tool=image-edit", button: "开始编辑", prompt: true, reference: true },
    { path: "/item-extract", button: "提取产品图", prompt: false, reference: true },
    { path: "/hd-upscale", button: "高清放大", prompt: false, reference: true },
    { path: "/remove-background", button: "一键去背景", prompt: false, reference: true },
]) {
    test(`${route.path} submits six independent tasks before any completion and restores out-of-order results`, async ({ page, api }, testInfo) => {
        api.taskStatus = "processing";
        await page.goto(route.path);
        for (let index = 0; index < 6; index++) {
            if (index) await openNext(page, index + 1);
            if (route.prompt) {
                const input = active(page).getByRole("textbox", { name: "图像提示词", exact: true });
                await expect(input).toHaveValue("");
                await input.fill(`MULTI_${index}_独立款式，不改变其他任务`);
            }
            if (route.reference) await upload(page, `source-${index}.png`);
            if (route.prompt && route.reference) {
                const references = active(page).getByRole("region", { name: "参考图", exact: true });
                await expect(references.getByRole("combobox", { name: "图片1用途", exact: true })).toBeVisible();
                await expect(references.getByText("以此图作为编辑原图。", { exact: true })).toBeVisible();
            }
            const submit = active(page).getByRole("button", { name: route.button, exact: true });
            await expect(submit).toBeEnabled(); await submit.click();
            await expect.poll(() => api.submissions.length).toBe(index + 1);
            await expect(tabs(page).nth(index)).toContainText("处理中");
            expect([...api.tasks.values()].every(task => task.status === "processing")).toBe(true);
        }
        expect(new Set(api.submissions.map(item => item.requestId)).size).toBe(6);
        for (let index = 0; index < 6; index++) {
            const request = api.submissions[index];
            if (route.prompt) expect(request.prompt).toBe(`${route.reference ? "参考图片编号：图片1。请按这些编号理解提示词中的图片引用。\n图片1：以此图作为编辑原图。\n\n" : ""}MULTI_${index}_独立款式，不改变其他任务`);
            else { expect(request).not.toHaveProperty("prompt"); expect(request).not.toHaveProperty("modelConfigId"); }
            if (route.reference) {
                const assetId = request.sourceUrls[0].split("/")[3];
                expect(createHash("sha256").update(api.assetBytes.get(assetId)!).digest("hex")).toBe(createHash("sha256").update(IMAGE).digest("hex"));
            }
        }
        // Finish the newest task first, with another task failing. Neither may
        // replace a different tab's pending card or edit its frozen input.
        finish(api, 5); finish(api, 2, true);
        await expect(tabs(page).nth(5)).toContainText("已完成");
        await expect(tabs(page).nth(2)).toContainText("已失败");
        await tabs(page).nth(0).click();
        await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);
        if (route.prompt) await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("MULTI_0_独立款式，不改变其他任务");
        for (const index of [4, 1, 3, 0]) finish(api, index);
        await expect(tabs(page).nth(0)).toContainText("已完成");
        const logs = await originalDigest(page);
        const record = logs.find(log => log.sourceTaskId === [...api.tasks.keys()][0]);
        expect(record).toBeTruthy();
        if (route.reference) expect(record!.referenceNames).toEqual(["source-0.png"]);
        if (route.prompt) expect(record!.prompt).toBe(api.submissions[0].prompt);
        await page.reload();
        await expect(tabs(page)).toHaveCount(6);
        await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
        await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength(6);
        await tabs(page).nth(5).click();
        await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
        if (route.prompt) await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("MULTI_5_独立款式，不改变其他任务");
        await page.setViewportSize({ width: 390, height: 844 });
        await expectActiveTabVisible(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${route.button}-multi-mobile.png`), fullPage: true });
    });
}

for (const completion of ["before switching", "after switching"] as const) {
    test(`item-extract bag completion ${completion} restores to task two after ordinary reload without resubmission`, async ({ page, api }) => {
        api.taskStatus = "processing";
        const sources = [fixturePng(47), fixturePng(173)];
        await page.goto("/item-extract");
        await upload(page, "knit.png", sources[0]);
        await active(page).getByRole("button", { name: "提取产品图", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        finish(api, 0);
        await expect(tabs(page).nth(0)).toContainText("已完成");

        await openNext(page, 2);
        await upload(page, "bag.png", sources[1]);
        await active(page).getByRole("button", { name: "提取产品图", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(2);
        await expect(tabs(page).nth(1)).toContainText("处理中");
        const taskIds = [...api.tasks.keys()];
        const requestIds = api.submissions.map(input => input.requestId);
        expect(new Set(requestIds).size).toBe(2);
        if (completion === "before switching") {
            finish(api, 1);
            await expect(tabs(page).nth(1)).toContainText("已完成");
        }
        await openNext(page, 3);
        if (completion === "after switching") finish(api, 1);
        await expect(tabs(page).nth(1)).toContainText("已完成");
        await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);

        const readCompleted = () => page.evaluate(async () => {
            const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
            const records: any[] = [];
            await createWorkspaceStorage("image_generation_logs").iterate(value => { records.push(value); });
            return records.map(log => ({ id: log.id, workspaceId: log.workspaceId, sourceTaskId: log.images[0]?.sourceTaskId, references: log.references }));
        });
        const storedBefore = await readCompleted();
        expect(storedBefore).toHaveLength(2);
        expect(storedBefore.find(log => log.sourceTaskId === taskIds[1])?.workspaceId).toMatch(/^item-extract:task:/);

        await page.reload();
        await expect(tabs(page)).toHaveCount(3);
        await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
        await expect(tabs(page).nth(0)).toContainText("已完成");
        await expect(tabs(page).nth(1)).toContainText("已完成");
        await expect(tabs(page).nth(2)).toContainText("草稿");
        await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);
        for (const index of [1, 0]) {
            await tabs(page).nth(index).click();
            await expect(active(page).getByRole("img", { name: index ? "bag.png" : "knit.png", exact: true })).toBeVisible();
            await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
            const downloadPromise = page.waitForEvent("download");
            await active(page).getByRole("button", { name: "下载", exact: true }).click();
            const download = await downloadPromise;
            const downloadPath = await download.path();
            expect(downloadPath).toBeTruthy();
            expect((await readFile(downloadPath!)).equals(api.assetBytes.get(taskIds[index])!)).toBe(true);
            const sourceId = api.submissions[index].sourceUrls[0].split("/")[3];
            expect(api.assetBytes.get(sourceId)?.equals(sources[index])).toBe(true);
        }
        expect(await readCompleted()).toEqual(storedBefore);
        expect(api.submissions.map(input => input.requestId)).toEqual(requestIds);
        expect([...api.tasks.keys()]).toEqual(taskIds);
        expect(api.submissions).toHaveLength(2);
    });
}

test("refresh during two live tasks only queries the original IDs and cross-board work is not locked", async ({ page, api }) => {
    api.taskStatus = "processing";
    await page.goto("/image");
    await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill("restore-A");
    await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await openNext(page, 2);
    await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill("restore-B");
    await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    const ids = [...api.tasks.keys()];
    await page.reload();
    await expect(tabs(page)).toHaveCount(2);
    await expect.poll(() => ids.every(id => api.taskReads.includes(`/api/tasks/${id}`))).toBe(true);
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("restore-B");
    expect(api.submissions).toHaveLength(2);
    await page.goto("/image?tool=image-edit");
    await upload(page, "other-board.png");
    await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill("edit-C");
    await active(page).getByRole("button", { name: "开始编辑", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(3);
    for (const index of [2, 1, 0]) finish(api, index);
    await expect(tabs(page).nth(0)).toContainText("已完成");
    await page.goto("/image");
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toContainText("已完成");
    expect(api.submissions).toHaveLength(3);
});

const scenes = ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "pattern-craft", "accessory-design", "virtual-try-on", "sketch-to-photo"];

for (const [route, button] of [["/item-extract", "提取产品图"], ["/remove-background", "一键去背景"], ["/hd-upscale", "高清放大"]]) {
    test(`${route} original pending reads fail closed and retry never submits a duplicate`, async ({ page, api }) => {
        api.taskStatus = "processing";
        await page.goto(route);
        await openNext(page, 2);
        await upload(page, "pending-original.png");
        await active(page).getByRole("button", { name: button, exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        const originalTask = [...api.tasks.keys()][0];
        await expect(tabs(page).nth(1)).toContainText("处理中");
        await page.addInitScript(() => {
            const original = IDBObjectStore.prototype.openCursor;
            const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")!;
            const callbacks: Array<() => void> = [];
            let mode = sessionStorage.getItem("isolated-pending-read-mode");
            const gate = (window as any).__pendingReadGate = { count: 0, release() {
                mode = null;
                IDBObjectStore.prototype.openCursor = original;
                for (const callback of callbacks.splice(0)) callback();
            } };
            IDBObjectStore.prototype.openCursor = function (...args) {
                if (this.name === "image_pending_tasks" && mode === "fail") throw new Error("isolated-pending-store-unavailable");
                const request = original.apply(this, args);
                if (this.name !== "image_pending_tasks") return request;
                Object.defineProperty(request, "onsuccess", { set(handler) {
                    success.set!.call(request, (event: Event) => {
                        // Keep each real cursor moving while its transaction is
                        // active; only hold the final read completion signal.
                        if (mode !== "hold" || request.result !== null) return handler.call(request, event);
                        gate.count += 1;
                        callbacks.push(() => handler.call(request, event));
                    });
                } });
                return request;
            };
        });
        await page.evaluate(() => sessionStorage.setItem("isolated-pending-read-mode", "hold"));
        await page.reload();
        await expect.poll(() => page.evaluate(() => (window as any).__pendingReadGate.count)).toBeGreaterThan(0);
        // A held native transaction also delays later store initialization on
        // the shared database barrier. Verify preserved media after release,
        // while checking that neither close nor submit can bypass the read.
        await expect(active(page).getByText("正在核对原任务记录…", { exact: true })).toBeVisible();
        await expect(active(page).getByRole("button", { name: button, exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "关闭任务 2 页签", exact: true })).toBeDisabled();
        expect(api.submissions).toHaveLength(1);
        await page.evaluate(() => (window as any).__pendingReadGate.release());
        // Restored tasks are observed, not newly running submissions. The tab
        // stays pending while its original task is checked without another POST.
        await expect(tabs(page).nth(1)).toContainText("待核查");
        await expect(active(page).getByText("原任务仍在处理中，完成后会自动取回结果；也可刷新状态。", { exact: true })).toBeVisible();
        await expect(active(page).getByRole("img", { name: "pending-original.png", exact: true })).toBeVisible();
        await expect.poll(() => api.taskReads.includes(`/api/tasks/${originalTask}`)).toBe(true);
        await page.evaluate(() => sessionStorage.setItem("isolated-pending-read-mode", "fail"));
        await page.reload();
        const readError = active(page).getByRole("alert").filter({ hasText: "isolated-pending-store-unavailable" });
        await expect(readError).toBeVisible();
        await expect(active(page).getByRole("img", { name: "pending-original.png", exact: true })).toBeVisible();
        await expect(active(page).getByRole("button", { name: button, exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "关闭任务 2 页签", exact: true })).toBeDisabled();
        expect(api.submissions).toHaveLength(1);
        await page.evaluate(() => (window as any).__pendingReadGate.release());
        await active(page).getByRole("button", { name: "重试读取原任务", exact: true }).click();
        await expect(readError).toHaveCount(0);
        await expect(active(page).getByRole("button", { name: "重试读取原任务", exact: true })).toHaveCount(0);
        await expect(tabs(page).nth(1)).toContainText("待核查");
        await expect(active(page).getByText("原任务仍在处理中，完成后会自动取回结果；也可刷新状态。", { exact: true })).toBeVisible();
        finish(api, 0);
        // The API fixture has no SSE event stream. Refocusing is a real,
        // read-only reconciliation trigger, not a new submission or recovery.
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(tabs(page).nth(1)).toContainText("已完成");
        await expect(page.getByRole("button", { name: "关闭任务 2 页签", exact: true })).toBeEnabled();
        expect(api.submissions).toHaveLength(1);
        expect([...api.tasks.keys()]).toEqual([originalTask]);
        const sourceAssetId = api.submissions[0].sourceUrls[0].split("/")[3];
        expect(api.assetBytes.get(sourceAssetId)?.equals(IMAGE)).toBe(true);
    });
}

async function fillScene(page: Page, scene: string, index: number) {
    const pane = active(page);
    const description = `SCENE_${scene}_${index}_仅本任务`;
    if (scene !== "text-to-style") {
        const label = scene === "accessory-design" ? "辅料图" : scene === "back-design" ? "服装正面图" : scene.startsWith("pattern-") ? "图案参考图" : scene === "virtual-try-on" ? "产品图" : scene === "sketch-to-photo" ? "线稿图" : "服装参考图";
        await pane.getByLabel(`上传${label}`, { exact: true }).setInputFiles({ name: `scene-source-${index}.png`, mimeType: "image/png", buffer: IMAGE });
        if (scene === "accessory-design") await pane.getByLabel("上传图案图", { exact: true }).setInputFiles({ name: `pattern-${index}.png`, mimeType: "image/png", buffer: IMAGE });
    }
    if (!["text-to-style", "virtual-try-on"].includes(scene)) await pane.getByText("补充说明（可选）", { exact: true }).click();
    await pane.locator(`textarea[id^="cs-${scene}-description-"]`).fill(description);
    if (scene === "local-restyle") await pane.getByRole("textbox", { name: "要改成什么样", exact: true }).fill(`任务${index}圆领改V领`);
    if (scene === "sketch-to-photo") {
        await pane.getByRole("textbox", { name: "材质方向", exact: true }).fill(`任务${index}棉针织`);
        await pane.getByRole("textbox", { name: "颜色方向", exact: true }).fill(`任务${index}海军蓝`);
    }
    return description;
}

for (const scene of scenes) {
    test(`creative ${scene} owns three live tasks, keeps fields and restores each completed result`, async ({ page, api }) => {
        api.taskStatus = "processing";
        await page.goto(`/creative/${scene}`);
        for (let index = 0; index < 3; index++) {
            if (index) await openNext(page, index + 1);
            await fillScene(page, scene, index);
            await active(page).locator(".cs-generate").click();
            await expect.poll(() => api.submissions.length).toBe(index + 1);
            await expect(tabs(page).nth(index)).toContainText("处理中");
            expect(api.submissions[index].promptInput.fields.description).toBe(`SCENE_${scene}_${index}_仅本任务`);
        }
        expect(new Set(api.submissions.map(item => item.requestId)).size).toBe(3);
        finish(api, 2);
        await expect(tabs(page).nth(2)).toContainText("已完成");
        await tabs(page).nth(0).click();
        await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toHaveCount(0);
        finish(api, 0); finish(api, 1);
        await expect(tabs(page).nth(0)).toContainText("已完成");
        await page.reload();
        await expect(tabs(page)).toHaveCount(3);
        await expect(tabs(page).nth(0)).toContainText("已完成");
        await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
        await expect(active(page).locator(`textarea[id^="cs-${scene}-description-"]`)).toHaveValue(`SCENE_${scene}_0_仅本任务`);
        await tabs(page).nth(2).click();
        await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
        await expect(active(page).locator(`textarea[id^="cs-${scene}-description-"]`)).toHaveValue(`SCENE_${scene}_2_仅本任务`);
        expect(api.submissions).toHaveLength(3);
    });
}

test("MJ blend owns three pairs of references without a prompt or cross-task upload", async ({ page, context, api }) => {
    const model = { id: "10000000-0000-4000-8000-000000000009", name: "Fixture MJ Blend", modelId: "midjourney-blend", imageParameterProfile: "midjourney-blend", protocol: "apimart", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
    await context.route("**/api/models", route => route.fulfill({ json: { models: [model], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })) } }));
    api.taskStatus = "processing";
    await page.goto("/image?tool=midjourney-blend");
    for (let index = 0; index < 3; index++) {
        if (index) await openNext(page, index + 1);
        await upload(page, `pair-${index}-first.png`, fixturePng(20 + index * 30));
        await expect(active(page).getByRole("button", { name: "开始融合", exact: true })).toBeDisabled();
        await upload(page, `pair-${index}-second.png`, fixturePng(30 + index * 30));
        await active(page).getByRole("button", { name: "开始融合", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(index + 1);
        expect(api.submissions[index].sourceUrls).toHaveLength(2);
        expect(api.submissions[index].modelConfigId).toBe(model.id);
        await expect(tabs(page).nth(index)).toContainText("处理中");
    }
    expect(new Set(api.submissions.flatMap(item => item.sourceUrls)).size).toBe(6);
    for (const index of [2, 0, 1]) finish(api, index);
    await expect(tabs(page).nth(2)).toContainText("已完成");
    await page.reload(); await expect(tabs(page)).toHaveCount(3);
    await expect(active(page).getByRole("img", { name: "pair-2-first.png", exact: true })).toBeVisible();
    await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(3);
});

test("a failed tab-registry write preserves the current draft and does not create an untracked task", async ({ page, api }) => {
    await page.addInitScript(() => {
        const original = IDBObjectStore.prototype.put;
        let failures = 1;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.name === "generation_workbench_tasks" && failures-- > 0) throw new DOMException("隔离测试存储已满", "QuotaExceededError");
            return original.apply(this, args as any);
        };
    });
    await page.goto("/image");
    await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill("保存失败不能清掉的草稿");
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("隔离测试存储已满");
    await expect(tabs(page)).toHaveCount(1);
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("保存失败不能清掉的草稿");
    await openNext(page, 2);
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("");
    await tabs(page).nth(0).click();
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("保存失败不能清掉的草稿");
    expect(api.submissions).toHaveLength(0);
});

test("corrupt tab identity fails closed and retry never overwrites the unresolved registry", async ({ page, api }) => {
    await page.goto("/image"); await openNext(page, 2);
    const receipt = await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const storage = createWorkspaceStorage("generation_workbench_tasks");
        let key = ""; await storage.iterate((_value, entryKey) => { key = entryKey; });
        const corrupt = { version: 1, tasks: [{ id: "unresolved-receipt", number: 2, createdAt: 1 }], activeId: "missing", nextNumber: 3 };
        await storage.setItem(key, corrupt); return { key, corrupt };
    });
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("原任务和草稿未被覆盖");
    await expect(page.getByRole("button", { name: "新建任务", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "图像提示词" })).toHaveCount(0);
    await page.getByRole("button", { name: "重试读取", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("原任务和草稿未被覆盖");
    expect(await page.evaluate(async key => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return createWorkspaceStorage("generation_workbench_tasks").getItem(key);
    }, receipt.key)).toEqual(receipt.corrupt);
    expect(api.submissions).toHaveLength(0);
});

test("employee change hides every original task and never writes the old drafts into the new owner", async ({ page, context, api }) => {
    await page.goto("/image");
    await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill("员工甲第一任务保留");
    await openNext(page, 2);
    await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill("员工甲第二任务保留");
    let changed = true;
    await context.route("**/api/auth/session", route => changed ? route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }) : route.fallback());
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "图像提示词" })).toHaveCount(0);
    await page.reload();
    await expect(tabs(page)).toHaveCount(1);
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("");
    changed = false; await page.reload();
    await expect(tabs(page)).toHaveCount(2);
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("员工甲第二任务保留");
    await tabs(page).nth(0).click();
    await expect(active(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("员工甲第一任务保留");
    expect(api.submissions).toHaveLength(0);
});

for (const route of ["/image", "/creative/text-to-style"]) {
    test(`${route} twenty-four long drafts survive reverse switching, closing and reload without generation`, async ({ page, api }, info) => {
        await page.goto(route);
        const prompt = () => active(page).getByRole("textbox", { name: route === "/image" ? "图像提示词" : "款式描述", exact: true });
        for (let index = 0; index < 24; index++) {
            if (index) await openNext(page, index + 1);
            await prompt().fill(`DRAFT_${index}_` + "保持原款纹理与比例。".repeat(120));
        }
        for (let index = 23; index >= 0; index--) {
            await tabs(page).nth(index).click();
            await expect(prompt()).toHaveValue(`DRAFT_${index}_` + "保持原款纹理与比例。".repeat(120));
        }
        await page.getByRole("button", { name: "关闭任务 24 页签", exact: true }).click();
        await expect(tabs(page)).toHaveCount(23);
        await page.reload(); await expect(tabs(page)).toHaveCount(23);
        await expect(prompt()).toHaveValue("DRAFT_0_" + "保持原款纹理与比例。".repeat(120));
        await page.setViewportSize({ width: 390, height: 844 });
        await tabs(page).nth(22).click();
        await expectActiveTabVisible(page);
        await expect(prompt()).toHaveValue("DRAFT_22_" + "保持原款纹理与比例。".repeat(120));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath("twenty-four-drafts-mobile.png"), fullPage: true });
        expect(api.submissions).toHaveLength(0);
    });
}
