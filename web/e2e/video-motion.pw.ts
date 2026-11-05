import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const model = { id: "10000000-0000-4000-8000-000000000003", name: "隔离视频模型", modelId: "doubao-seedance-2.5", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const reference = readFileSync(new URL("./media/reference.png", import.meta.url));
const video = readFileSync(new URL("./media/video.mp4", import.meta.url));
const summary = "保留服装款式与颜色，自然转身并缓慢推近。";
const original = "请保留我输入的原始描述，不要替换成后台长提示词。";
const compiledPrompt = "这是服务端规划的长提示词，只能用于视频生成，不得覆盖用户原始草稿。";

async function motionFixture(context: BrowserContext, api: MockCanvasApi) {
    const preflights: any[] = [];
    const flags = { allowRawPrompt: false };
    await context.route("**/api/models", route => route.fulfill({ json: { models: [model], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1, allowRawPrompt: tool.toolKey === "video" && flags.allowRawPrompt })), prices: [] } }));
    await context.route("**/api/tasks/preflight", route => {
        preflights.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true, normalized: {} } });
    });
    await context.route("**/api/tasks/by-request/*", route => {
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return route.fulfill({ json: { task: [...api.tasks.values()].find(task => task.requestId === id) } });
    });
    await context.route("**/api/tasks/*/progress", route => route.fulfill({ json: { progress: { status: "queued", phase: "waiting", runtime: "worker", queuePosition: 1, estimatedWaitSeconds: null, estimatedRemainingSeconds: null } } }));
    await context.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON();
        api.submissions.push(input);
        const task = { ...input, id: randomUUID(), prompt: compiledPrompt, summaryZh: summary, status: "queued", resultUrls: [], failureReason: null, createdAt: new Date().toISOString() };
        api.tasks.set(task.id, task);
        return route.fulfill({ status: 201, json: { task } });
    });
    await context.route("**/api/assets/*/content", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        if (!api.tasks.has(id)) return route.fallback();
        return route.fulfill({ contentType: "video/mp4", body: video });
    });
    await context.route("**/api/assets/*/playback", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        if (!api.tasks.has(id)) return route.fallback();
        return route.fulfill({ status: 200, contentType: "video/mp4", body: video });
    });
    return { preflights, flags };
}

async function uploadReferences(page: Page, count: number) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片 · 首帧 / 尾帧", exact: true }).click();
    await (await chooser).setFiles(Array.from({ length: count }, (_, index) => ({ name: `reference-${index + 1}.png`, mimeType: "image/png", buffer: reference })));
    for (let index = 0; index < count; index++) await expect(page.getByRole("img", { name: `reference-${index + 1}.png`, exact: true })).toBeVisible();
}

async function openMotion(page: Page) {
    const panel = page.getByTestId("video-motion-panel");
    if (await panel.getAttribute("open") === null) await panel.locator("summary").click();
    return panel;
}

for (const count of [1, 2]) test(`${count} reference image(s) select frame mode automatically, preserve draft and show pending/result summary`, async ({ page, context, api }, info) => {
    const f = await motionFixture(context, api);
    await page.goto("/video");
    const prompt = page.getByRole("textbox", { name: "视频提示词", exact: true });
    await expect(page.getByTestId("video-motion-panel")).not.toHaveAttribute("open", "");
    await expect(page.getByRole("checkbox", { name: "不经 AI 整理，直接发送", exact: true })).toHaveCount(0);
    await uploadReferences(page, count);
    const panel = await openMotion(page);
    await panel.getByRole("button", { name: "转身展示", exact: true }).click();
    await panel.getByRole("button", { name: "走向镜头", exact: true }).click();
    await expect(panel.getByRole("button", { name: "抚摸面料", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "缓慢推近", exact: true }).click();
    await panel.getByRole("button", { name: "仅环境音", exact: true }).click();
    await panel.getByRole("button", { name: /^无\s*声$/ }).click();
    if (count === 2) {
        await prompt.fill(original);
        await expect.poll(() => page.evaluate(async () => {
            const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
            return createWorkspaceStorage("generation_drafts").getItem("video:prompt");
        })).toBe(original);
        await page.reload();
        await expect(prompt).toHaveValue(original);
        await expect(page.getByRole("img", { name: "reference-2.png", exact: true })).toBeVisible();
        await openMotion(page);
        await expect(panel.getByRole("button", { name: "转身展示", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(panel.getByRole("button", { name: "缓慢推近", exact: true })).toHaveAttribute("aria-pressed", "true");
    } else await expect(prompt).toHaveValue("");
    await expect(page.getByRole("button", { name: "生成视频", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(page.getByRole("status", { name: "视频生成中", exact: true })).toBeVisible();
    await expect(page.getByText(summary, { exact: true })).toBeVisible();
    const input = api.submissions[0];
    expect(f.preflights).toHaveLength(1);
    expect(f.preflights[0].promptInput).toEqual(input.promptInput);
    expect(input).toMatchObject({ operationType: "video_generation", toolKey: "video", prompt: count === 1 ? "" : original,
        parameters: { videoMode: count === 1 ? "first-frame" : "first-last-frame", seconds: 5, size: "adaptive", resolution: "720p", generateAudio: false },
        promptInput: { scene: "video-motion", mode: "video", outputLanguage: "zh", userText: count === 1 ? "" : original,
            referenceRoles: count === 1 ? ["首帧"] : ["首帧", "尾帧"], fields: { subject_action: ["turn", "walk"], camera: "push", audio: "none", generate_audio: false, video_mode: count === 1 ? "first-frame" : "first-last-frame" } } });
    expect(input.sourceUrls).toHaveLength(count);
    expect([...api.assetBytes.values()].every(bytes => bytes.equals(reference))).toBe(true);
    await page.getByRole("status", { name: "视频生成中", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`pending-${count}-frames.png`), fullPage: true });
    for (const task of api.tasks.values()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await expect(page.locator("video")).toHaveCount(1);
    await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await expect(page.getByText(summary, { exact: true })).toBeVisible();
    await expect(prompt).toHaveValue(count === 1 ? "" : original);
    await page.reload();
    await expect(page.locator("video")).toHaveCount(1);
    await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await expect(prompt).toHaveValue(count === 1 ? "" : original);
    await expect(page.getByText(summary, { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await openMotion(page);
    await expect(panel.getByRole("button", { name: "缓慢推近", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByRole("button", { name: "转身展示", exact: true })).toHaveAttribute("aria-pressed", "true");
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator(".generation-workbench main").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`motion-${count}-frames-390.png`), fullPage: true });
    await page.getByText(summary, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`result-${count}-frames-390.png`), fullPage: true });
});

test("revoked raw-prompt permission hides its saved toggle and keeps planning enabled", async ({ page, context, api }) => {
    const f = await motionFixture(context, api);
    f.flags.allowRawPrompt = true;
    await page.goto("/video");
    const direct = page.getByRole("checkbox", { name: "不经 AI 整理，直接发送", exact: true });
    await direct.check();
    await expect(page.getByTestId("video-motion-panel")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "生成视频", exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return createWorkspaceStorage("generation_drafts").getItem("video:raw-prompt");
    })).toBe(true);
    f.flags.allowRawPrompt = false;
    await page.reload();
    await expect(direct).toHaveCount(0);
    await expect(page.getByTestId("video-motion-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "生成视频", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].promptInput).toMatchObject({ scene: "video-motion", mode: "video", userText: "", fields: { video_mode: "text", generate_audio: false } });
});
