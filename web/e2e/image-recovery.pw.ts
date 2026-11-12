import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";

async function captureRecoveryWrites(context: BrowserContext, api: MockCanvasApi) {
    const requests: string[] = [];
    await context.route("**/api/tasks/*/recover", async route => {
        requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task: api.tasks.get(id), recovered: true }) });
    });
    return requests;
}

async function submitImage(page: Page, api: MockCanvasApi, prompt: string) {
    const before = api.submissions.length;
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill(prompt);
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(before + 1);
    return [...api.tasks.values()].at(-1)!;
}

async function unknownCard(page: Page) {
    await expect(page.getByText("需要管理员协助", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "暂时无法获取结果，需要管理员协助。可先刷新进度，不会重新生成。" })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "复制诊断信息", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "继续获取结果", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "取消任务", exact: true })).toHaveCount(0);
}

test("停止观察会跨刷新保留，认证恢复和前台事件不自动重启；明确刷新只查原任务", async ({ page, context, api }, testInfo) => {
    const recoveries = await captureRecoveryWrites(context, api);
    api.taskStatus = "processing";
    await page.goto("/image");
    const original = await submitImage(page, api, "认证恢复与停止观察回归");
    await expect.poll(() => api.taskReads.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "停止本页查询（不取消服务端任务）", exact: true }).click();
    await expect(page.getByText("暂时无法获取进度", { exact: true })).toBeVisible();
    const reads = api.taskReads.length;
    api.holdSession = true;
    await page.reload();
    await expect.poll(() => api.pendingSessions()).toBeGreaterThan(0);
    await expect(page.getByRole("status")).toContainText("正在准备工作区");
    expect(api.taskReads).toHaveLength(reads);
    expect(api.submissions).toHaveLength(1);
    original.status = "success"; original.resultUrls = [`/api/assets/${original.id}/content`];
    await api.releaseSessions();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeEnabled();
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    await page.waitForTimeout(700);
    expect(api.taskReads).toHaveLength(reads);
    await expect(page.getByRole("button", { name: "下载", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("stopped-reload.png"), fullPage: true });
    await page.getByRole("button", { name: "刷新进度", exact: true }).click();
    await expect.poll(() => api.taskReads.length).toBeGreaterThan(reads);
    await expect(page.getByRole("button", { name: "停止本页查询（不取消服务端任务）", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /下载/ }).first()).toBeVisible();
    expect(api.taskReads.slice(reads).every(path => path.endsWith(original.id))).toBe(true);
    expect(api.submissions).toHaveLength(1);
    expect(recoveries).toEqual([]);
});

for (const wake of ["focus", "online"]) {
    test(`无上游ID仅只读刷新，晚到成功经${wake}自动回填且草稿不变`, async ({ page, context, api }, testInfo) => {
        const recoveries = await captureRecoveryWrites(context, api);
        api.taskStatus = "paused";
        await page.goto("/image");
        const original = await submitImage(page, api, `提交未知等待-${wake}`);
        await unknownCard(page);
        const reads = api.taskReads.length;
        await page.getByRole("button", { name: "刷新进度", exact: true }).click();
        await unknownCard(page);
        await expect.poll(() => api.taskReads.length).toBeGreaterThan(reads);
        expect(recoveries).toEqual([]);
        if (wake === "focus") {
            await page.setViewportSize({ width: 390, height: 844 });
            const refresh = page.getByRole("button", { name: "刷新进度", exact: true });
            await refresh.scrollIntoViewIfNeeded();
            await refresh.click({ trial: true, timeout: 3_000 });
            await page.getByRole("button", { name: "复制诊断信息", exact: true }).click({ trial: true, timeout: 3_000 });
            const bounds = await refresh.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            await page.screenshot({ path: testInfo.outputPath("unknown-390.png"), fullPage: true });
            await page.setViewportSize({ width: 1800, height: 1200 });
        }
        const draft = `这是未提交的新草稿-${wake}`;
        await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill(draft);
        original.status = "success";
        original.resultUrls = [`/api/assets/${original.id}/content`];
        await page.evaluate(event => window.dispatchEvent(new Event(event)), wake);
        await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible({ timeout: 8_000 });
        await expect(page.getByText("需要管理员协助", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue(draft);
        expect(api.submissions).toHaveLength(1);
        expect(recoveries).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`late-success-${wake}.png`), fullPage: true });
    });
}

test("后台晚到成功只更新生成记录，不替换已选历史预览或未提交草稿", async ({ page, context, api }, testInfo) => {
    const recoveries = await captureRecoveryWrites(context, api);
    await page.goto("/image");
    await submitImage(page, api, "历史预览保留A");
    await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
    const historical = page.getByRole("button", { name: /历史预览保留A/ });
    await page.getByRole("tab", { name: /^历史记录/ }).click();
    await expect(historical).toBeVisible();
    await page.getByRole("tab", { name: "本次结果", exact: true }).click();
    api.taskStatus = "paused";
    const pending = await submitImage(page, api, "晚到结果B");
    await unknownCard(page);
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("草稿C不能被A或B替换");
    await page.getByRole("tab", { name: /^历史记录/ }).click();
    await historical.click();
    const image = page.getByRole("img", { name: "生成结果 1", exact: true });
    await expect(image).toBeVisible();
    const originalSource = await image.getAttribute("src");
    pending.status = "success";
    pending.resultUrls = [`/api/assets/${pending.id}/content`];
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByRole("button", { name: /晚到结果B/ })).toBeVisible({ timeout: 8_000 });
    await expect(image).toHaveAttribute("src", originalSource!);
    await expect(historical).toHaveClass(/border-foreground bg-muted/);
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("草稿C不能被A或B替换");
    expect(api.submissions).toHaveLength(2);
    expect(recoveries).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("history-view-preserved.png"), fullPage: true });
});

test("新建空白结果视图后，原任务成功只进历史不占据新草稿", async ({ page, context, api }) => {
    const recoveries = await captureRecoveryWrites(context, api);
    api.taskStatus = "paused";
    await page.goto("/image");
    const original = await submitImage(page, api, "旧任务后台收尾");
    await unknownCard(page);
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("新的独立草稿");
    await expect(page.getByRole("img", { name: /^生成结果/ })).toHaveCount(0);
    original.status = "success";
    original.resultUrls = [`/api/assets/${original.id}/content`];
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("tab", { name: /^历史记录/ }).click();
    await expect(page.getByRole("button", { name: /旧任务后台收尾/ })).toBeVisible({ timeout: 8_000 });
    await page.getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(page.getByRole("img", { name: /^生成结果/ })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("新的独立草稿");
    expect(api.submissions).toHaveLength(1);
    expect(recoveries).toEqual([]);
});
