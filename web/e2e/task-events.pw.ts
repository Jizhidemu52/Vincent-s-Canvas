import { createServer, type ServerResponse } from "node:http";
import { test, expect } from "./fixtures";

test("共享原生任务通知减少轮询，完成推送更新图片且不重新生成", async ({ page, context, api }) => {
    const streams = new Set<ServerResponse>();
    let connections = 0;
    const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        if (url.pathname !== "/api/tasks/events") { response.writeHead(404).end(); return; }
        connections++;
        streams.add(response);
        response.once("close", () => streams.delete(response));
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        response.write(`event: tasks-changed\ndata: ${JSON.stringify({ ids: url.searchParams.get("ids")!.split(",") })}\n\n`);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(59999, "127.0.0.1", resolve);
    });
    try {
        // Vite's dedicated test proxy points to this disposable local server.
        // All remaining requests stay in MockCanvasApi; no external network.
        await context.route("**/api/tasks/events?**", route => route.continue());
        api.taskStatus = "processing";
        await page.goto("/image");
        await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("任务实时通知浏览器回归");
        await page.getByRole("button", { name: "开始生成", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        await expect.poll(() => streams.size).toBe(1);
        await expect.poll(() => api.taskReads.length).toBeGreaterThan(0);
        // Allow the initial stream snapshot to settle, then cross two legacy
        // 2.5-second poll intervals. Healthy streams should issue no GET here.
        await page.waitForTimeout(500);
        const reads = api.taskReads.length;
        await page.waitForTimeout(5_500);
        expect(api.taskReads).toHaveLength(reads);
        expect(connections).toBe(1);
        const original = [...api.tasks.values()][0]!;
        original.status = "success";
        original.resultUrls = [`/api/assets/${original.id}/content`];
        for (const stream of streams) stream.write(`event: tasks-changed\ndata: ${JSON.stringify({ ids: [original.id] })}\n\n`);
        await expect(page.getByRole("button", { name: "停止本页查询（不取消服务端任务）", exact: true })).toHaveCount(0, { timeout: 3_000 });
        await expect(page.getByRole("button", { name: /下载/ }).first()).toBeVisible();
        expect(api.submissions).toHaveLength(1);
        await expect.poll(() => streams.size).toBe(0);
    } finally {
        for (const stream of streams) stream.destroy();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
