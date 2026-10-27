import { createServer, type ServerResponse } from "node:http";
import { test, expect, newCanvas } from "./fixtures";
import type { Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    // Never request a real permission in regression tests. Any accidental
    // request is counted and refused, so it cannot interrupt company devices.
    await page.addInitScript(() => {
        const state = window as unknown as { notificationPermissionRequests: number };
        state.notificationPermissionRequests = 0;
        if (typeof Notification !== "undefined") Object.defineProperty(Notification, "requestPermission", {
            configurable: true,
            value: () => { state.notificationPermissionRequests++; return Promise.resolve("denied"); },
        });
    });
});
test.afterEach(async ({ page }) => {
    expect(await page.evaluate(() => (window as unknown as { notificationPermissionRequests: number }).notificationPermissionRequests)).toBe(0);
});

async function startImage(page: Page) {
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill("生成反馈隔离回归图片");
    await panel.locator("button.cw-generate-button").click();
}

test("生成标题在成功后恢复，结果可定位且本页提交耗时有样本", async ({ page, api }) => {
    api.taskStatus = "processing";
    await newCanvas(page);
    const originalTitle = await page.title();
    await startImage(page);
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(page).toHaveTitle(`(0/1) ${originalTitle}`);
    const task = [...api.tasks.values()][0]!;
    task.status = "success";
    task.resultUrls = [`/api/assets/${task.id}/content`];
    await expect(page).toHaveTitle(originalTitle);
    const feedback = page.getByTestId("canvas-task-feedback");
    await expect(feedback).toContainText("1 个成功");
    await feedback.getByRole("button", { name: "定位到结果", exact: true }).click();
    await feedback.getByLabel("本页体验数据").click();
    await expect(feedback).toContainText("（1 次）");
    expect(api.submissions).toHaveLength(1);
});

test("切换画布清理旧标题与完成反馈，旧任务不能串入新画布", async ({ page, api }) => {
    api.taskStatus = "processing";
    const first = await newCanvas(page);
    const originalTitle = await page.title();
    await startImage(page);
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(page).toHaveTitle(`(0/1) ${originalTitle}`);
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建画布", exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/canvas/${first}$`));
    await expect(page).toHaveTitle(originalTitle);
    const old = [...api.tasks.values()][0]!;
    old.status = "success";
    old.resultUrls = [`/api/assets/${old.id}/content`];
    const feedback = page.getByTestId("canvas-task-feedback");
    await expect(feedback.getByRole("button", { name: "定位到结果", exact: true })).toHaveCount(0);
    await expect(feedback).not.toContainText("1 个成功");
    expect(api.submissions).toHaveLength(1);
});

test("模拟后台可见性时唯一SSE及时更新标题，不申请系统通知", async ({ page, context, api }) => {
    const streams = new Set<ServerResponse>();
    let connections = 0;
    const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        if (url.pathname !== "/api/tasks/events") { response.writeHead(404).end(); return; }
        connections++;
        streams.add(response);
        response.once("close", () => streams.delete(response));
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        response.write(`event: tasks-changed\ndata: ${JSON.stringify({ ids: url.searchParams.get("ids")!.split(",") })}\n\n`);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(59999, "127.0.0.1", resolve); });
    try {
        await context.route("**/api/tasks/events?**", route => route.continue());
        api.taskStatus = "processing";
        await newCanvas(page);
        const originalTitle = await page.title();
        const feedback = page.getByTestId("canvas-task-feedback");
        await startImage(page);
        await expect.poll(() => streams.size).toBe(1);
        await expect(page).toHaveTitle(`(0/1) ${originalTitle}`);
        // Test the application's visibility policy deterministically. This is
        // not a claim that a frozen/minimized OS browser will run within 3s.
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        const task = [...api.tasks.values()][0]!;
        task.status = "success";
        task.resultUrls = [`/api/assets/${task.id}/content`];
        for (const stream of streams) stream.write(`event: tasks-changed\ndata: ${JSON.stringify({ ids: [task.id] })}\n\n`);
        await expect(page).toHaveTitle(originalTitle, { timeout: 3000 });
        await expect(feedback).toContainText("1 个成功");
        expect(api.submissions).toHaveLength(1);
        expect(connections).toBe(1);
        await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event("visibilitychange")); });
        await expect(feedback.getByRole("button", { name: "定位到结果", exact: true })).toBeVisible();
    } finally {
        for (const stream of streams) stream.destroy();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test("本机演示式无SSE后台沿用原查询回退并更新标题，不重复提交", async ({ page, api }) => {
    // MockCanvasApi intentionally returns 404 for /api/tasks/events, just as
    // the demo service lacks the formal server's SSE endpoint.
    api.taskStatus = "processing";
    await newCanvas(page);
    const originalTitle = await page.title();
    await startImage(page);
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(page).toHaveTitle(`(0/1) ${originalTitle}`);
    await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    const task = [...api.tasks.values()][0]!;
    task.status = "success";
    task.resultUrls = [`/api/assets/${task.id}/content`];
    await expect(page).toHaveTitle(originalTitle, { timeout: 4000 });
    await expect(page.getByTestId("canvas-task-feedback")).toContainText("1 个成功");
    expect(api.submissions).toHaveLength(1);
    await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event("visibilitychange")); });
});
