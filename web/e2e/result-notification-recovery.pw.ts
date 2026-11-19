import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { test, expect, IMAGE, fixturePng } from "./fixtures";
import { activeWorkbench } from "./headless-workbench";

for (const scene of ["image-edit", "garment-colorway", "local-restyle", "text-to-style"] as const) {
    test(`${scene} recovers a lost success push through the original task without refreshing or resubmitting`, async ({ page, context, api }, info) => {
        const streams = new Set<ServerResponse>();
        const connections: string[] = [];
        const mutations: string[] = [];
        const server = createServer((request, response) => {
            const url = new URL(request.url!, "http://fixture");
            if (url.pathname !== "/api/tasks/events") { response.writeHead(404).end(); return; }
            connections.push(url.searchParams.get("ownerId")!);
            streams.add(response);
            response.once("close", () => streams.delete(response));
            response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": new URL(info.project.use.baseURL!).origin, "Access-Control-Allow-Credentials": "true" });
            response.write(`event: tasks-changed\ndata: ${JSON.stringify({ ids: [...api.tasks.keys()] })}\n\n`);
        });
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(59997, "127.0.0.1", resolve); });
        try {
            await context.route("**/api/tasks/events?**", route => {
                const target = new URL(route.request().url()); target.port = "59997";
                return route.continue({ url: target.href });
            });
            page.on("request", request => {
                const url = new URL(request.url());
                if (request.method() === "POST" && /^\/api\/(?:tasks|prompt-compilations)(?:\/|$)/.test(url.pathname)) mutations.push(url.pathname);
            });
            api.taskStatus = "processing";
            await page.goto(scene === "image-edit" ? "/image?tool=image-edit" : `/creative/${scene}`);
            const pane = activeWorkbench(page);
            if (scene === "image-edit") {
                const chooser = page.waitForEvent("filechooser");
                await pane.getByRole("button", { name: "上传图片", exact: true }).click();
                await (await chooser).setFiles({ name: "source.png", mimeType: "image/png", buffer: IMAGE });
                await pane.getByRole("textbox", { name: "图像提示词", exact: true }).fill("仅修改颜色，保留结构");
                await pane.getByRole("button", { name: "开始编辑", exact: true }).click();
            } else {
                if (scene !== "text-to-style") await pane.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "source.png", mimeType: "image/png", buffer: IMAGE });
                if (scene === "text-to-style") await pane.getByRole("textbox", { name: "款式描述", exact: true }).fill("蓝色圆领针织衫");
                if (scene === "local-restyle") await pane.getByRole("textbox", { name: "要改成什么样", exact: true }).fill("圆领改为V领，其他不变");
                await pane.locator("button.cs-generate").click();
            }
            await expect.poll(() => api.submissions.length).toBe(1);
            await expect.poll(() => streams.size).toBe(1);
            await expect.poll(() => api.taskReads.length).toBeGreaterThan(0);
            await page.waitForTimeout(1_000);
            const original = [...api.tasks.values()][0]!;
            const reads = api.taskReads.length;
            const before = mutations.slice();
            const bytes = fixturePng(29);
            api.assetBytes.set(original.id, bytes);
            original.status = "success";
            original.resultUrls = [`/api/assets/${original.id}/content`];
            const completedAt = Date.now();
            const result = scene === "image-edit" ? pane.getByRole("img", { name: "生成结果 1", exact: true }) : pane.locator(".cs-result-card img").first();
            await expect(result).toBeVisible({ timeout: 18_000 });
            await expect.poll(() => result.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
            const elapsed = Date.now() - completedAt;
            const downloading = page.waitForEvent("download");
            await pane.getByRole("button", { name: scene === "image-edit" ? "下载" : "下载原图", exact: true }).click();
            const downloaded = await downloading;
            expect(await downloaded.failure()).toBeNull();
            const digest = createHash("sha256").update(await readFile((await downloaded.path())!)).digest("hex");
            expect(digest).toBe(createHash("sha256").update(bytes).digest("hex"));
            expect(api.taskReads.length).toBeGreaterThan(reads);
            expect(connections).toEqual([original.userId]);
            expect(api.submissions).toHaveLength(1);
            expect(mutations).toEqual(before);
            await page.screenshot({ path: info.outputPath(`${scene}-automatic-original-result.png`), fullPage: true });
            await info.attach("recovery-evidence", { contentType: "application/json", body: Buffer.from(JSON.stringify({ scene, taskId: original.id, requestId: original.requestId, elapsedMs: elapsed, readsBefore: reads, readsAfter: api.taskReads.length, streamConnections: connections.length, completionPushes: 0, submissions: api.submissions.length, mutations, sha256: digest }, null, 2)) });
            await page.reload();
            await expect(result).toBeVisible();
            expect(api.submissions).toHaveLength(1);
        } finally {
            for (const stream of streams) stream.destroy();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
}
