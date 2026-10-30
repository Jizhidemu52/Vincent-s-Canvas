import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { probeMediaBytes } from "../../server/src/media-probe";
import { preflightVideoTask } from "../../server/src/video-task-preflight";
import { runApiMartVideoTask } from "../../server/src/media-runtime";
import type { SupportedVideoModelId, ProviderVideoSource } from "../../server/src/video-models";

const model = { id: "10000000-0000-4000-8000-000000000003", name: "测试视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const video = readFileSync(new URL("./media/video.mp4", import.meta.url));
const reference = readFileSync(new URL("./media/reference.png", import.meta.url));

test("视频可并行提交且刷新恢复各自结果，手动入库不重复上传", async ({ page, context, api }) => {
    api.taskStatus = "queued";
    let failAcknowledgement = false;
    let lookupCount = 0;
    await context.route("**/api/models", route => route.fulfill({ json: { models: [model], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })), prices: [] } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/tasks/by-request/*", route => {
        lookupCount++;
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return route.fulfill({ json: { task: [...api.tasks.values()].find(task => task.requestId === requestId) } });
    });
    await context.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST" || !failAcknowledgement) return route.fallback();
        const input = route.request().postDataJSON();
        api.submissions.push(input);
        const id = "80000000-0000-4000-8000-000000000003";
        api.tasks.set(id, { ...input, id, status: "queued", resultUrls: [], createdAt: new Date().toISOString() });
        failAcknowledgement = false;
        await route.abort("connectionreset");
    });
    await context.route("**/api/assets/*/content", route => route.fulfill({ contentType: "video/mp4", body: video }));
    await page.goto("/video");
    const prompt = page.getByRole("textbox", { name: "视频提示词" });
    await prompt.fill("第一条视频：产品旋转");
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(page.getByRole("button", { name: "继续生成新视频", exact: true })).toBeEnabled();
    await prompt.fill("第二条视频：镜头拉近");
    await page.getByRole("button", { name: "继续生成新视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect(page.getByRole("status", { name: "视频生成中" })).toHaveCount(2);
    // The server accepted a third POST, but its HTTP acknowledgement was lost.
    failAcknowledgement = true;
    await prompt.fill("第三条视频：提交响应中断");
    await page.getByRole("button", { name: "继续生成新视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(3);
    await expect(page.getByText("原任务查询暂停", { exact: true })).toBeVisible();
    for (const task of api.tasks.values()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await page.reload();
    await expect(page.locator("video")).toHaveCount(3);
    await expect.poll(() => lookupCount).toBeGreaterThan(0);
    expect(api.submissions).toHaveLength(3);
    await page.getByRole("button", { name: "保存到素材库", exact: true }).first().click();
    await expect(page.getByText("该视频已在我的素材中，无需重复添加")).toBeVisible();
    // Only generated server assets exist; no upload-request was issued for a result.
    expect(api.assets.size).toBe(2);
    expect(api.submissions.map(item => item.prompt)).toEqual(["第一条视频：产品旋转", "第二条视频：镜头拉近", "第三条视频：提交响应中断"]);
});

test("视频模型不可用时明确提示且不静默切换 HappyHorse", async ({ page, context, api }) => {
    const horse = { ...model, modelId: "happyhorse-1.1" };
    await context.route("**/api/models", route => route.fulfill({ json: { models: [horse], tools: [], prices: [] } }));
    await page.goto("/video?model=removed-model");
    await expect(page.getByText("当前所选视频模型不可用，请重新选择；不会自动更换渠道。")).toBeVisible();
    await page.getByRole("textbox", { name: "视频提示词" }).fill("不允许自动替换");
    await expect(page.getByRole("button", { name: "生成视频", exact: true })).toBeDisabled();
    expect(api.submissions).toHaveLength(0);
});

for (const parameterModelId of ["happyhorse-1.1", "wan2.7", "MiniMax-H3", "doubao-seedance-2.5"] as SupportedVideoModelId[]) {
    test(`图生视频真实页面→预检→协议适配：${parameterModelId}`, async ({ page, context, api }) => {
        const aliasModel = { ...model, modelId: model.id, parameterModelId };
        const resultId = "80000000-0000-4000-8000-000000000099";
        const providerBodies: Record<string, unknown>[] = [];
        let uploads = 0;
        let preflights = 0;
        await context.route("**/api/models", route => route.fulfill({ json: { models: [aliasModel], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })), prices: [] } }));
        const resolveSources = async (input: any): Promise<ProviderVideoSource[]> => Promise.all(input.sourceUrls.map(async (url: string) => {
            const id = url.split("/")[3];
            const bytes = api.assetBytes.get(id)!;
            expect(bytes).toEqual(reference);
            return { bytes, byteSize: bytes.length, mimeType: "image/png", publicUrl: "asset://pending-image-upload", ...await probeMediaBytes(bytes, "image/png") };
        }));
        await context.route("**/api/tasks/preflight", async route => {
            preflights++;
            const input = route.request().postDataJSON();
            const result = preflightVideoTask({ model: parameterModelId, prompt: input.prompt, parameters: input.parameters, sources: await resolveSources(input) });
            await route.fulfill({ json: { ok: true, normalized: result.normalized } });
        });
        await context.route("**/api/tasks", async route => {
            if (route.request().method() !== "POST") return route.fallback();
            const input = route.request().postDataJSON();
            api.submissions.push(input);
            await runApiMartVideoTask({ baseUrl: "https://isolated-provider.invalid/v1", apiKey: "fixture-only", modelId: parameterModelId, prompt: input.prompt, parameters: input.parameters, sources: await resolveSources(input), beforeSubmit: async () => true, onSubmitted: async () => undefined }, {
                sleep: async () => undefined,
                fetch: async (url, init) => {
                    if (url.endsWith("/uploads/images")) {
                        uploads++;
                        const file = (init?.body as FormData).get("file") as File;
                        expect(Buffer.from(await file.arrayBuffer())).toEqual(reference);
                        return Response.json({ url: "https://fixture-cdn.invalid/original.png" });
                    }
                    if (init?.method === "POST") { providerBodies.push(JSON.parse(String(init.body))); return Response.json({ data: [{ task_id: "fixture-upstream" }] }); }
                    return Response.json({ data: { status: "completed", result: { videos: ["https://fixture-cdn.invalid/result.mp4"] } } });
                },
            });
            const task = { ...input, id: resultId, status: "success", resultUrls: [`/api/assets/${resultId}/content`], createdAt: new Date().toISOString() };
            api.tasks.set(resultId, task);
            return route.fulfill({ status: 201, json: { task } });
        });
        await context.route(`**/api/assets/${resultId}/content`, route => route.fulfill({ contentType: "video/mp4", body: video }));
        await page.goto("/video");
        await page.getByRole("textbox", { name: "视频提示词" }).fill("保留产品结构，缓慢移动镜头");
        await page.getByRole("button", { name: /^调\s*整$/ }).click();
        const settings = page.getByRole("dialog", { name: "参数", exact: true });
        const mode = settings.getByRole("combobox", { name: "视频生成方式", exact: true });
        await mode.click();
        await page.locator(".ant-select-dropdown:visible").getByText("首帧", { exact: true }).click();
        await expect(mode).toHaveAttribute("aria-expanded", "false");
        await settings.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(settings).toBeHidden();
        await page.locator("summary").filter({ hasText: "参考素材" }).click();
        const choose = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "上传", exact: true }).first().click();
        await (await choose).setFiles({ name: "reference.png", mimeType: "image/png", buffer: reference });
        await expect(page.getByRole("img", { name: "reference.png" })).toBeVisible();
        await page.getByRole("button", { name: "生成视频", exact: true }).click();
        await expect(page.locator("video")).toHaveCount(1);
        await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
        expect(preflights).toBe(1);
        expect(uploads).toBe(1);
        expect(providerBodies).toHaveLength(1);
        expect(providerBodies[0]).toMatchObject(["happyhorse-1.1", "MiniMax-H3"].includes(parameterModelId)
            ? { first_frame_image: "https://fixture-cdn.invalid/original.png" }
            : parameterModelId === "doubao-seedance-2.5" ? { image_with_roles: [{ url: "https://fixture-cdn.invalid/original.png", role: "first_frame" }] } : { image_urls: ["https://fixture-cdn.invalid/original.png"] });
        expect(JSON.stringify(providerBodies)).not.toMatch(/\/api\/assets|base64/);
    });
}
