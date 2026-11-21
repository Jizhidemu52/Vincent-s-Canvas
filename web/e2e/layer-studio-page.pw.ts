import { randomUUID } from "node:crypto";
import {readFile} from "node:fs/promises";
import {readPsd} from "ag-psd";
import { test as base, expect, type Page } from "@playwright/test";
import { MockCanvasApi, IMAGE } from "./fixtures";
import { moduleDefinitions } from "../../shared/feature-catalog";

type Studio = { api: MockCanvasApi; quote: boolean; status: string; uncertain: boolean; checkedDurable: boolean; recoveries: number };
const test = base.extend<{ studio: Studio }>({ studio: async ({ context, page }, use, testInfo) => {
    const api = new MockCanvasApi(testInfo.project.use.baseURL || "http://127.0.0.1:5325");
    await api.attach(context);
    const studio: Studio = { api, quote: true, status: "success", uncertain: false, checkedDurable: false, recoveries: 0 };
    await context.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        api.taskReads.push(`/api/tasks/by-request/${requestId}`);
        const task = [...api.tasks.values()].find(item => item.requestId === requestId);
        return route.fulfill(task ? { json: { task } } : { status: 404, json: { error: "NOT_FOUND" } });
    });
    await context.route("**/api/tasks/*/recover", route => {
        const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
        studio.recoveries++;
        const task = api.tasks.get(id)!;
        task.status = "success"; task.resultDocument.status = "ready";
        task.resultDocument.items = task.resultDocument.items.map((item: any) => ({ ...item, state: "saved", assetId: id, contentUrl: `/api/assets/${id}/content` }));
        return route.fulfill({ json: { task, recovered: true } });
    });
    await context.route("**/api/layer-studio/estimate", route => {
        const input = route.request().postDataJSON();
        return route.fulfill(studio.quote ? { json: { estimate: { currency: "CNY", estimatedPrecharge: 3.2, maximumOutputs: input.parameters.layer_decomposition ? input.parameters.layer_decomposition_options.max_images : 1, sourceCount: input.sourceCount, priceVersion: 1, employeeCredits: 0, providerCharge: "unverified" } } }
            : { status: 503, json: { error: "PRICE_NOT_CONFIGURED", message: "SECRET_PROVIDER_SHOULD_NOT_APPEAR" } });
    });
    await context.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON();
        studio.checkedDurable = await page.evaluate(async requestId => {
            const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
            let found = false;
            await createWorkspaceStorage("layer_studio_workspaces").iterate((value: any) => { if (value.jobs?.some((job: any) => job.requestId === requestId && job.phase === "submitting")) found = true; });
            return found;
        }, input.requestId);
        api.submissions.push(input);
        const id = randomUUID();
        const document = { version: 1, taskId: id, mode: input.parameters.layer_decomposition ? "decompose" : "generate", status: "ready", expectedOutputCount: 1,
            items: [{ index: 0, groupIndex: 0, urlIndex: 0, role: input.parameters.layer_decomposition ? "base" : "image", state: "saved", assetId: id, contentUrl: `/api/assets/${id}/content`, width: 256, height: 256, mimeType: "image/png" }] };
        const task = { ...input, id, userId: "00000000-0000-4000-8000-000000000099", upstreamTaskId: "private-upstream", status: studio.status, resultUrls: studio.status === "success" ? [`/api/assets/${id}/content`] : [], resultDocument: studio.status === "success" ? document : undefined, failureReason: null, createdAt: new Date().toISOString() };
        api.tasks.set(id, task);
        if (studio.uncertain) return route.abort("connectionreset");
        return route.fulfill({ status: 201, json: { task } });
    });
    await use(studio);
    expect(api.blocked).toEqual([]); expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
} });

const pane = (page: Page) => page.getByRole("region", { name: "创作工作区", exact: true });
const generate = (page: Page) => pane(page).getByRole("button", { name: "生成图片", exact: true });
async function generatedMode(page: Page) {
    await page.goto("/layer-studio");
    await pane(page).getByRole("button", { name: "图片生成 / 编辑", exact: true }).click();
    await pane(page).getByRole("textbox", { name: "图片描述", exact: true }).fill("保持原始形状与细节的产品图");
    await expect(generate(page)).toBeEnabled();
    await expect(pane(page)).not.toContainText(/预计预扣|费用|付费|扣费|结算|CNY|¥/);
}

test("generation uses anonymous one-shot contract and persists before POST; refresh reads original only", async ({ page, studio }) => {
    await generatedMode(page);
    await pane(page).getByRole("combobox", { name: "背景", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("透明", { exact: true }).click();
    await expect(pane(page).getByRole("combobox", { name: "输出格式", exact: true })).toBeDisabled();
    await generate(page).click();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    expect(studio.checkedDurable).toBe(true);
    expect(studio.api.submissions).toHaveLength(1);
    expect(studio.api.submissions[0]).toMatchObject({ toolKey: "layer-studio", operationType: "image_generation", parameters: { n: 1, background: "transparent", output_format: "png", optimize_prompt_options: { mode: "standard" } } });
    expect(studio.api.submissions[0]).not.toHaveProperty("modelConfigId");
    await page.reload();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    expect(studio.api.submissions).toHaveLength(1);
    await expect(page.locator("body")).not.toContainText(/seedream|apimart|E2E GPT Image/i);
    const position = pane(page).getByRole("spinbutton", { name: "X 位置", exact: true });
    await position.fill("24"); await position.press("Tab");
    await expect.poll(() => page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        let x: number | undefined;
        await createWorkspaceStorage("layer_studio_workspaces").iterate((value: any) => { x = value.jobs?.[0]?.edit?.layers?.[0]?.x; });
        return x;
    })).toBe(24);
    await page.reload();
    await expect(pane(page).getByRole("spinbutton", { name: "X 位置", exact: true })).toHaveValue("24");
    await page.screenshot({ path: "../output/seedream55-integration/page-desktop.png", fullPage: true });
});

test("decomposition saves original bytes, includes base in cap, omits background, and supports OCR", async ({ page, studio }) => {
    await page.goto("/layer-studio");
    await pane(page).getByLabel("上传参考图片", { exact: true }).setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await expect(pane(page).getByRole("button", { name: "开始拆分", exact: true })).toBeEnabled();
    await expect(pane(page)).not.toContainText(/预计预扣|费用|付费|扣费|结算|CNY|¥/);
    await pane(page).getByLabel("输出总数上限（含底图）", { exact: true }).fill("100");
    await pane(page).getByLabel("请求文字 OCR", { exact: true }).check();
    await pane(page).getByRole("combobox", { name: "底图格式", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("JPEG", { exact: true }).click();
    await pane(page).getByRole("button", { name: "开始拆分", exact: true }).click();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    const submitted = studio.api.submissions[0];
    expect(submitted.parameters).toMatchObject({ n: 1, size: "auto", layer_decomposition: true, layer_decomposition_options: { max_images: 100, text_recognition: true }, output_format: "jpeg" });
    expect(submitted.parameters).not.toHaveProperty("background"); expect(submitted.prompt).toBe("");
    expect([...studio.api.assetBytes.values()][0]).toEqual(IMAGE);
});

test("ambiguous POST and reload keep one request; queries never resubmit", async ({ page, studio }) => {
    studio.uncertain = true; studio.status = "processing";
    await generatedMode(page);
    await generate(page).click();
    await expect.poll(() => studio.api.submissions.length).toBe(1);
    await expect(generate(page)).toBeDisabled();
    await pane(page).getByRole("button", { name: "刷新结果", exact: true }).click();
    await page.reload();
    await expect(pane(page).getByLabel("生成状态")).toContainText("处理中");
    await expect(generate(page)).toBeDisabled();
    expect(studio.api.submissions).toHaveLength(1);
    expect(studio.api.taskReads.length).toBeGreaterThan(0);
});

test("continuing creation preserves independent drafts while the hidden original request keeps updating", async ({ page, studio }) => {
    studio.status = "processing";
    await generatedMode(page); await generate(page).click();
    await expect.poll(() => studio.api.submissions.length).toBe(1);
    await expect(generate(page)).toBeDisabled();
    await pane(page).getByRole("button", { name: "继续创作", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "任务列表", exact: true })).toHaveCount(0);
    await pane(page).getByRole("textbox", { name: "拆分说明", exact: true }).fill("第二个独立任务");
    const records = () => page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const values: any[] = [];
        await createWorkspaceStorage("layer_studio_workspaces").iterate(value => { values.push(value); });
        return values;
    });
    await expect.poll(async () => (await records()).some(value => value.form.prompt === "第二个独立任务")).toBe(true);
    expect((await records()).find(value => value.jobs.length)?.form.prompt).toBe("保持原始形状与细节的产品图");
    const task = [...studio.api.tasks.values()][0];
    task.status = "failed"; task.failureReason = "Fixture confirmed failure";
    await expect.poll(async () => (await records()).find(value => value.jobs.length)?.jobs[0].phase).toBe("failed");
    await expect(pane(page).getByRole("textbox", { name: "拆分说明", exact: true })).toHaveValue("第二个独立任务");
    await page.reload();
    await expect(pane(page).getByRole("textbox", { name: "拆分说明", exact: true })).toHaveValue("第二个独立任务");
    expect((await records()).find(value => value.jobs.length)?.jobs[0].requestId).toBe(task.requestId);
    expect(studio.api.submissions).toHaveLength(1);
});

test("missing configured price disables generation but saved result editor remains", async ({ page, studio }) => {
    studio.api.role = "super_admin";
    await generatedMode(page); await generate(page).click();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    studio.quote = false;
    await page.reload();
    await expect(pane(page).getByText("功能配置尚未就绪，暂不能创建新任务；已有结果仍可编辑和下载。", { exact: false })).toBeVisible();
    await expect(pane(page).getByRole("button", { name: "重新检查", exact: true })).toBeVisible();
    await expect(pane(page)).not.toContainText(/预计预扣|费用|付费|扣费|结算|CNY|¥/);
    await expect(generate(page)).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: /导出.*PNG/ })).toBeVisible();
    expect(studio.api.submissions).toHaveLength(1);
    await expect(page.locator("body")).not.toContainText(/SECRET_PROVIDER|seedream|apimart/i);
});

test("mobile layout and exact-size validation stay usable without a request", async ({ page, studio }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await generatedMode(page);
    await pane(page).getByRole("combobox", { name: "尺寸方式", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("精确像素", { exact: true }).click();
    await pane(page).getByLabel("宽度（像素）", { exact: true }).fill("1");
    await expect(generate(page)).toBeDisabled();
    await pane(page).getByLabel("宽度（像素）", { exact: true }).fill("2048");
    await pane(page).getByLabel("高度（像素）", { exact: true }).fill("1152");
    await expect(generate(page)).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(studio.api.submissions).toHaveLength(0);
    await page.screenshot({ path: "../output/seedream55-integration/page-mobile.png", fullPage: true });
});

test("partial saved results recover the accepted task only after an explicit action", async ({ page, studio }) => {
    await generatedMode(page); await generate(page).click();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    const task = [...studio.api.tasks.values()][0];
    task.status = "paused"; task.resultDocument.status = "partial";
    task.resultDocument.items[0].state = "pending";
    await page.evaluate(async requestId => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const store = createWorkspaceStorage("layer_studio_workspaces");
        const records: Array<[string, any]> = [];
        await store.iterate((value: any, key) => { if (value.jobs?.some((job: any) => job.requestId === requestId)) records.push([key, value]); });
        for (const [key, value] of records) { value.jobs[0].phase = "pending"; await store.setItem(key, value); }
    }, task.requestId);
    await page.reload();
    await expect(pane(page).getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
    expect(studio.recoveries).toBe(0); expect(studio.api.submissions).toHaveLength(1);
    await pane(page).getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    expect(studio.recoveries).toBe(1); expect(studio.api.submissions).toHaveLength(1);
});

test("storage failure before durable identity blocks the model POST", async ({ page, studio }) => {
    await generatedMode(page);
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
            if (this.name === "layer_studio_workspaces" && value?.jobs?.some((job: any) => job.phase === "submitting")) throw new DOMException("Simulated quota", "QuotaExceededError");
            return original.call(this, value, key!);
        };
    });
    await generate(page).click();
    await expect(pane(page).getByRole("alert")).toContainText("请求记录未能安全保存");
    expect(studio.api.submissions).toHaveLength(0);
    await expect(generate(page)).toBeDisabled();
});

test("missing layer recovery is actionable in the editor and preserves edits without another generation", async ({ page, studio }, testInfo) => {
    await page.goto("/layer-studio");
    await pane(page).getByLabel("上传参考图片", { exact: true }).setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await pane(page).getByRole("button", { name: "开始拆分", exact: true }).click();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    const position = pane(page).getByRole("spinbutton", { name: "X 位置", exact: true });
    await position.fill("24"); await position.press("Tab");
    const task = [...studio.api.tasks.values()][0];
    task.status = "paused"; task.resultDocument.status = "partial"; task.resultDocument.expectedOutputCount = 5;
    task.resultDocument.items.push(...[1, 2, 3, 4].map(index => ({ index, groupIndex: 0, urlIndex: index, role: "layer", state: "pending", width: 256, height: 256, name: `缺失图层 ${index}`, boundingBox: { absolute: [16 * index, 16, 16 * index + 32, 48] } })));
    await page.evaluate(async requestId => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const store = createWorkspaceStorage("layer_studio_workspaces");
        const records: Array<[string, any]> = [];
        await store.iterate((value: any, key) => { if (value.jobs?.some((job: any) => job.requestId === requestId)) records.push([key, value]); });
        for (const [key, value] of records) { value.jobs[0].phase = "pending"; await store.setItem(key, value); }
    }, task.requestId);
    await page.reload();
    const recovery = pane(page).getByLabel("图片保存状态", { exact: true });
    await expect(recovery).toContainText("部分图片保存失败（1/5）");
    await expect(recovery.getByRole("button", { name: "重新读取已保存原件", exact: true })).toHaveCount(0);
    await expect(pane(page).getByRole("button", { name: "导出合成 PNG", exact: true })).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: "导出 PSD", exact:true })).toBeDisabled();
    const reads = studio.api.taskReads.length;
    await page.reload();
    await expect(recovery).toContainText("部分图片保存失败（1/5）");
    await expect.poll(() => studio.api.taskReads.length).toBeGreaterThan(reads);
    expect(studio.recoveries).toBe(0); expect(studio.api.submissions).toHaveLength(1);
    await recovery.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("partial-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const resume = recovery.getByRole("button", { name: "重试保存", exact: true });
    await resume.scrollIntoViewIfNeeded();
    await expect(resume).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("partial-mobile.png") });
    await resume.dblclick();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    await expect(recovery).toHaveCount(0);
    await expect(pane(page).getByRole("button", { name: "导出合成 PNG", exact: true })).toBeEnabled();
    await expect(position).toHaveValue("24");
    expect(studio.recoveries).toBe(1); expect(studio.api.submissions).toHaveLength(1);
    await expect(pane(page).getByRole("list", { name: "图层列表，最上方在最前景" }).getByRole("listitem")).toHaveCount(5);
    const download=page.waitForEvent("download");
    await pane(page).getByRole("button",{name:"导出 PSD",exact:true}).click();
    const file=testInfo.outputPath("edited-layers.psd");await (await download).saveAs(file);
    const bytes=await readFile(file);expect(bytes.subarray(0,4).toString()).toBe("8BPS");
    const psd=readPsd(bytes,{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});
    expect(psd.children).toHaveLength(5);
    expect(psd.children?.some(l=>l.left===24)).toBe(true);
    expect(psd.children?.every(l=>Boolean(l.name))).toBe(true);
    expect(studio.api.submissions).toHaveLength(1);
});

test("missing original request stays recoverable after reload and never creates a replacement", async ({ page, context, studio }) => {
    studio.uncertain = true;
    await context.route("**/api/tasks/by-request/*", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
    await generatedMode(page); await generate(page).click();
    await expect.poll(() => studio.api.submissions.length).toBe(1);
    const requestId = studio.api.submissions[0].requestId;
    await expect(pane(page).getByText("暂时无法获取结果，系统会继续更新。", { exact: true })).toBeVisible();
    await page.reload();
    await expect(pane(page).getByLabel("生成状态")).toContainText("暂未完成");
    await expect(pane(page).getByText("待核查", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const identities: string[] = [];
        await createWorkspaceStorage("layer_studio_workspaces").iterate((value: any) => { identities.push(...value.jobs.map((job: any) => job.requestId)); });
        return identities;
    })).toEqual([requestId]);
    await pane(page).getByRole("button", { name: "刷新结果", exact: true }).click();
    await expect(generate(page)).toBeDisabled();
    expect(studio.api.submissions).toHaveLength(1);
});

test("disabled module hides navigation and new generation without removing saved editor", async ({ page, context, studio }) => {
    await generatedMode(page); await generate(page).click();
    await expect(pane(page).getByLabel("生成状态")).toContainText("生成成功");
    await context.route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: item.moduleKey !== "layer-studio" })) } }));
    await page.reload();
    await expect(pane(page).getByRole("heading", { name: "豆包生图", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "豆包生图", exact: true })).toHaveCount(0);
    await expect(generate(page)).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: "导出合成 PNG", exact: true })).toBeEnabled();
    expect(studio.api.submissions).toHaveLength(1);
});
