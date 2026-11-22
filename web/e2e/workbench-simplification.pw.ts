import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { MockCanvasApi, IMAGE } from "./fixtures";

const OWNER = "00000000-0000-4000-8000-000000000099";
const output = resolve(import.meta.dirname, "../../output/workbench-simplification");
type Fixture = { api: MockCanvasApi; partial: boolean; recoveries: string[]; historyBoards: string[] };
const test = base.extend<{ fixture: Fixture }>({ fixture: async ({ context }, use, info) => {
    const api = new MockCanvasApi(info.project.use.baseURL), fixture: Fixture = { api, partial: false, recoveries: [], historyBoards: [] };
    await api.attach(context);
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 4 } }));
    await context.route("**/api/layer-studio/estimate", route => {
        const input = route.request().postDataJSON();
        return route.fulfill({ json: { estimate: { currency: "CNY", estimatedPrecharge: 3.2, maximumOutputs: input.parameters.layer_decomposition ? input.parameters.layer_decomposition_options.max_images : 1, sourceCount: input.sourceCount, priceVersion: 1, employeeCredits: 0, providerCharge: "unverified" } } });
    });
    await context.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        api.taskReads.push(`/api/tasks/by-request/${requestId}`);
        const task = [...api.tasks.values()].find(item => item.requestId === requestId);
        return route.fulfill(task ? { json: { task } } : { status: 404, json: { error: "NOT_FOUND" } });
    });
    await context.route("**/api/tasks/history?*", route => {
        const board = new URL(route.request().url()).searchParams.get("board")!;
        fixture.historyBoards.push(board);
        const tasks = board === "image-edit" ? [{ id: "legacy-generation-cloud", requestId: "legacy-generation-cloud-request", userId: OWNER,
            toolKey: "image", operationType: "image_generation", status: "success", prompt: "原图像生成云端记录", modelName: "历史图片模型",
            parameters: { tool: "image-generation" }, sourceUrls: [], resultUrls: ["/api/assets/legacy-generation-cloud/content"], createdAt: "2026-11-18T01:00:00.000Z" }] : [];
        return route.fulfill({ json: { tasks, nextCursor: null, hasMore: false } });
    });
    await context.route("**/api/tasks/*/recover", async route => {
        const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
        fixture.recoveries.push(id);
        const task = api.tasks.get(id)!;
        task.status = "success"; task.resultDocument.status = "ready";
        task.resultDocument.items = task.resultDocument.items.map((item: any) => ({ ...item, state: "saved", assetId: `${id}-${item.index}`, contentUrl: `/api/assets/${id}-${item.index}/content` }));
        task.resultUrls = task.resultDocument.items.map((item: any) => item.contentUrl);
        return route.fulfill({ json: { task, recovered: true } });
    });
    await context.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON();
        if (input.toolKey !== "layer-studio") return route.fallback();
        api.submissions.push(input);
        const id = randomUUID(), decompose = Boolean(input.parameters.layer_decomposition);
        const first = { index: 0, groupIndex: 0, urlIndex: 0, role: decompose ? "base" : "image", state: "saved", assetId: `${id}-0`, contentUrl: `/api/assets/${id}-0/content`, width: 256, height: 256, mimeType: "image/png" };
        const document = { version: 1, taskId: id, mode: decompose ? "decompose" : "generate", status: fixture.partial ? "partial" : "ready", expectedOutputCount: fixture.partial ? 2 : 1,
            items: fixture.partial ? [first, { index: 1, groupIndex: 0, urlIndex: 1, role: "layer", state: "pending", name: "缺失图层", width: 256, height: 256, boundingBox: { absolute: [16, 16, 80, 80] } }] : [first] };
        const task = { ...input, id, userId: OWNER, upstreamTaskId: "private-upstream", status: fixture.partial ? "paused" : "success", resultUrls: [first.contentUrl], resultDocument: document, failureReason: null, createdAt: new Date().toISOString() };
        api.tasks.set(id, task);
        return route.fulfill({ status: 201, json: { task } });
    });
    await mkdir(output, { recursive: true });
    await use(fixture);
    expect(api.blocked).toEqual([]); expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
} });

const workspace = (page: Page) => page.getByRole("region", { name: "创作工作区", exact: true });
const resultArea = (page: Page) => workspace(page).getByRole("main", { name: "结果与图层编辑", exact: true });
async function noTopTaskStrip(page: Page) {
    await expect(page.getByRole("tablist", { name: "任务列表", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新建任务", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^关闭任务 \d+ 页签$/ })).toHaveCount(0);
    await expect(page.getByText("待核查", { exact: true })).toHaveCount(0);
}
async function narrowScreenshot(page: Page, filename: string) {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(output, filename), fullPage: true, animations: "disabled" });
}

test("home and desktop/mobile navigation retire image generation and use the Doubao name", async ({ page, fixture }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "主导航", exact: true });
    await expect(page.locator('a[href="/image"], a[href="/image?tool=image-generation"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: "图像生成", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "图片编辑", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "更多工具", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("link", { name: "豆包生图", exact: true })).toHaveAttribute("href", "/layer-studio");
    await expect(nav.getByRole("link", { name: "图层拆分与图片生成", exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(output, "navigation-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "功能模块", exact: true });
    const toggle = drawer.getByRole("button", { name: "更多工具", exact: true });
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect(drawer.getByRole("link", { name: "豆包生图", exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "图像生成", exact: true })).toHaveCount(0);
    await drawer.screenshot({ path: resolve(output, "navigation-mobile.png"), animations: "disabled" });
    await drawer.getByRole("link", { name: "豆包生图", exact: true }).click();
    await expect(page.getByRole("heading", { name: "豆包生图", exact: true })).toBeVisible();
    await noTopTaskStrip(page);
    expect(fixture.api.submissions).toHaveLength(0);
});

test("legacy image entry redirects preserve query, hash and a usable design handoff without submitting", async ({ page, fixture }) => {
    for (const tool of [null, "image-generation", "image"]) {
        const params = new URLSearchParams({ prompt: "保留旧链接设计要求", source: "legacy-link" });
        if (tool) params.set("tool", tool);
        await page.goto(`/image?${params}#draft`);
        await expect(page).toHaveURL(url => url.pathname === "/image" && url.searchParams.get("tool") === "image-edit" && url.searchParams.get("prompt") === "保留旧链接设计要求" && url.searchParams.get("source") === "legacy-link" && url.hash === "#draft");
        await expect(page.getByRole("heading", { name: "图片编辑", exact: true })).toBeVisible();
        await noTopTaskStrip(page);
    }
    const href = await page.evaluate(async base64 => {
        const { prepareDesignHandoff } = await import("/src/lib/design-handoff.ts");
        return prepareDesignHandoff("image-edit", { id: "redirect-reference", name: "重定向原图.png", type: "image/png", dataUrl: `data:image/png;base64,${base64}` }, { version: 1, sourceScene: "style-to-sketch", requirements: ["保留原图针织纹理", "只调整颜色"] });
    }, IMAGE.toString("base64"));
    const legacy = new URL(href, page.url()); legacy.searchParams.set("tool", "image-generation"); legacy.hash = "#handoff";
    const token = legacy.searchParams.get("designToken");
    await page.goto(legacy.href);
    await expect(page).toHaveURL(url => url.searchParams.get("tool") === "image-edit" && url.searchParams.get("designToken") === token && url.hash === "#handoff");
    await expect(page.getByRole("textbox", { name: "沿用设计要求", exact: true })).toHaveValue("保留原图针织纹理\n只调整颜色");
    await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: "重定向原图.png", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始编辑", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "沿用设计要求", exact: true })).toHaveValue("保留原图针织纹理\n只调整颜色");
    await page.screenshot({ path: resolve(output, "image-edit-redirect.png"), fullPage: true, animations: "disabled" });
    expect(fixture.api.submissions).toHaveLength(0);
});

test("image editing right-side history retains legacy local and cloud image-generation records", async ({ page, fixture }) => {
    await page.goto("/image?tool=image-edit");
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toBeVisible();
    const legacy = { id: "legacy-image-generation", ownerId: OWNER, tool: "image-generation", workspaceId: "default", createdAt: Date.now(), title: "原图像生成本机记录", prompt: "历史针织款式", model: "历史图片模型", references: [], imageCount: 1, successCount: 1,
        images: [{ id: "legacy-image", dataUrl: `data:image/png;base64,${IMAGE.toString("base64")}`, width: 256, height: 256, prompt: "历史针织款式" }] };
    await page.evaluate(async record => { const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts"); await createWorkspaceStorage("image_generation_logs").setItem(record.id, record); }, legacy);
    await page.reload();
    const views = workspace(page).getByRole("tablist", { name: "结果视图", exact: true });
    await expect(views.getByRole("tab", { name: "本次结果", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(fixture.historyBoards).toEqual([]);
    await views.getByRole("tab", { name: /^历史记录/ }).click();
    const history = workspace(page).locator(".image-history-panel");
    await expect(history.getByText("原图像生成本机记录", { exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: "查看云端记录：原图像生成云端记录", exact: true })).toBeVisible();
    expect(fixture.historyBoards).toEqual(["image-edit"]);
    const historyBox = await history.boundingBox(), editorBox = await page.getByRole("textbox", { name: "图像提示词", exact: true }).boundingBox();
    expect(historyBox && editorBox && historyBox.x > editorBox.x + editorBox.width).toBe(true);
    await page.screenshot({ path: resolve(output, "image-edit-history-desktop.png"), fullPage: true, animations: "disabled" });
    await narrowScreenshot(page, "image-edit-history-mobile.png");
    await history.locator("button.image-history-card").filter({ hasText: "原图像生成本机记录" }).click();
    await expect(workspace(page).getByRole("heading", { name: "历史预览", exact: true })).toBeVisible();
    await expect(workspace(page).getByRole("button", { name: "恢复为草稿继续改", exact: true })).toHaveCount(0);
    await workspace(page).locator(".image-results-panel > div").filter({ has: page.getByRole("heading", { name: "历史预览", exact: true }) }).getByRole("button", { name: "复用提示词", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("历史针织款式");
    await history.getByRole("button", { name: "查看云端记录：原图像生成云端记录", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "云端任务详情", exact: true });
    await expect(detail.getByRole("img", { name: "账号历史原件", exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Close", exact: true }).click();
    await views.getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(history).not.toBeVisible();
    expect(await page.evaluate(async id => { const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts"); return createWorkspaceStorage("image_generation_logs").getItem(id); }, legacy.id)).toEqual(legacy);
    await noTopTaskStrip(page);
    expect(fixture.api.submissions).toHaveLength(0);
});

test("Doubao partial 1-of-2 results show one save warning, block export and recover the original task only", async ({ page, fixture }) => {
    fixture.partial = true;
    await page.goto("/layer-studio");
    await expect(page.getByRole("heading", { name: "豆包生图", exact: true })).toBeVisible();
    await workspace(page).getByLabel("上传参考图片", { exact: true }).setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await workspace(page).getByRole("button", { name: "开始拆分", exact: true }).click();
    const results = resultArea(page), warning = results.getByLabel("图片保存状态", { exact: true });
    await expect(warning).toContainText("部分图片保存失败（1/2）");
    await expect(results.getByText("部分图片保存失败（1/2）", { exact: true })).toHaveCount(1);
    await expect(results.getByRole("button", { name: "导出合成 PNG", exact: true })).toBeDisabled();
    await expect(results.getByLabel("原任务状态", { exact: true })).toHaveCount(0);
    await expect(results.getByLabel("图层原件恢复", { exact: true })).toHaveCount(0);
    await noTopTaskStrip(page);
    const task = [...fixture.api.tasks.values()][0], requestId = fixture.api.submissions[0].requestId;
    expect(fixture.api.submissions).toHaveLength(1); expect(fixture.recoveries).toEqual([]);
    const position = results.getByRole("spinbutton", { name: "X 位置", exact: true });
    await position.fill("24"); await position.press("Tab");
    const tabs = results.getByRole("tablist", { name: "结果与历史", exact: true });
    await tabs.getByRole("tab", { name: "历史记录", exact: true }).click();
    await expect(results.getByRole("region", { name: "账号云端历史", exact: true })).toBeVisible();
    await expect(results.getByRole("combobox", { name: "本机历史记录", exact: true })).toBeVisible();
    await expect(warning).not.toBeVisible();
    expect(fixture.historyBoards).toEqual(["layer-studio"]);
    await tabs.getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(warning).toBeVisible();
    await warning.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, "doubao-partial-desktop.png"), fullPage: true, animations: "disabled" });
    await page.reload();
    await expect(warning).toContainText("部分图片保存失败（1/2）");
    await expect(position).toHaveValue("24");
    expect(fixture.api.submissions).toHaveLength(1); expect(fixture.recoveries).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    const recover = warning.getByRole("button", { name: "重试保存", exact: true });
    await recover.scrollIntoViewIfNeeded(); await expect(recover).toBeInViewport();
    await narrowScreenshot(page, "doubao-partial-mobile.png");
    await recover.dblclick();
    await expect(results.getByLabel("生成状态", { exact: true })).toContainText("生成成功");
    await expect(warning).toHaveCount(0);
    await expect(results.getByRole("button", { name: "导出合成 PNG", exact: true })).toBeEnabled();
    await expect(position).toHaveValue("24");
    await expect(results.getByRole("list", { name: "图层列表，最上方在最前景", exact: true }).getByRole("listitem")).toHaveCount(2);
    expect(fixture.recoveries).toEqual([task.id]); expect(fixture.api.submissions.map(input => input.requestId)).toEqual([requestId]);
    await page.reload();
    await expect(results.getByLabel("生成状态", { exact: true })).toContainText("生成成功");
    expect(fixture.recoveries).toEqual([task.id]); expect(fixture.api.submissions).toHaveLength(1);
    await narrowScreenshot(page, "doubao-recovered-mobile.png");
});
