import { randomUUID } from "node:crypto";
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

const pane = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
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
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
    expect(studio.checkedDurable).toBe(true);
    expect(studio.api.submissions).toHaveLength(1);
    expect(studio.api.submissions[0]).toMatchObject({ toolKey: "layer-studio", operationType: "image_generation", parameters: { n: 1, background: "transparent", output_format: "png", optimize_prompt_options: { mode: "standard" } } });
    expect(studio.api.submissions[0]).not.toHaveProperty("modelConfigId");
    await page.reload();
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
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
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
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
    await pane(page).getByRole("button", { name: "查询原任务", exact: true }).click();
    await page.reload();
    await expect(pane(page).getByLabel("原任务状态")).toContainText("处理中");
    await expect(generate(page)).toBeDisabled();
    expect(studio.api.submissions).toHaveLength(1);
    expect(studio.api.taskReads.length).toBeGreaterThan(0);
});

test("two task panes preserve independent drafts and keep pending pane locked", async ({ page, studio }) => {
    studio.status = "processing";
    await generatedMode(page); await generate(page).click();
    await expect.poll(() => studio.api.submissions.length).toBe(1);
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await pane(page).getByRole("textbox", { name: "拆分说明", exact: true }).fill("第二个独立任务");
    await tabs(page).nth(0).click();
    await expect(pane(page).getByRole("textbox", { name: "图片描述", exact: true })).toHaveValue("保持原始形状与细节的产品图");
    await expect(generate(page)).toBeDisabled();
    await tabs(page).nth(1).click();
    await page.reload();
    await expect(pane(page).getByRole("textbox", { name: "拆分说明", exact: true })).toHaveValue("第二个独立任务");
    expect(studio.api.submissions).toHaveLength(1);
});

test("missing configured price disables generation but saved result editor remains", async ({ page, studio }) => {
    studio.api.role = "super_admin";
    await generatedMode(page); await generate(page).click();
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
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
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
    const task = [...studio.api.tasks.values()][0];
    task.status = "paused"; task.resultDocument.status = "partial";
    await page.evaluate(async requestId => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const store = createWorkspaceStorage("layer_studio_workspaces");
        const records: Array<[string, any]> = [];
        await store.iterate((value: any, key) => { if (value.jobs?.some((job: any) => job.requestId === requestId)) records.push([key, value]); });
        for (const [key, value] of records) { value.jobs[0].phase = "pending"; await store.setItem(key, value); }
    }, task.requestId);
    await page.reload();
    await expect(pane(page).getByRole("button", { name: "恢复原任务查询 / 保存", exact: true })).toBeVisible();
    expect(studio.recoveries).toBe(0); expect(studio.api.submissions).toHaveLength(1);
    await pane(page).getByRole("button", { name: "恢复原任务查询 / 保存", exact: true }).click();
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
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

test("missing original request stays recoverable after reload and never creates a replacement", async ({ page, context, studio }) => {
    studio.uncertain = true;
    await context.route("**/api/tasks/by-request/*", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
    await generatedMode(page); await generate(page).click();
    await expect.poll(() => studio.api.submissions.length).toBe(1);
    const requestId = studio.api.submissions[0].requestId;
    await expect(pane(page).getByText(/暂未查到原请求/)).toBeVisible();
    await page.reload();
    await expect(pane(page).getByLabel("原任务状态")).toContainText(requestId);
    await pane(page).getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect(generate(page)).toBeDisabled();
    expect(studio.api.submissions).toHaveLength(1);
});

test("disabled module hides navigation and new generation without removing saved editor", async ({ page, context, studio }) => {
    await generatedMode(page); await generate(page).click();
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
    await context.route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: item.moduleKey !== "layer-studio" })) } }));
    await page.reload();
    await expect(pane(page).getByRole("heading", { name: "图层拆分与图片生成", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "图层拆分与图片生成", exact: true })).toHaveCount(0);
    await expect(generate(page)).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: "导出合成 PNG", exact: true })).toBeEnabled();
    expect(studio.api.submissions).toHaveLength(1);
});
