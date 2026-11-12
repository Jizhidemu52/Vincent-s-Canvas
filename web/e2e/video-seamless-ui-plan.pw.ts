import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { test, expect, fixturePng, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const videoBytes = readFileSync(new URL("./media/video.mp4", import.meta.url));
const otherVideoBytes = readFileSync(new URL("./media/video-control.mp4", import.meta.url));
const videoModel = { id: "10000000-0000-4000-8000-000000000003", name: "测试视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const active = (page: Page) => page.getByRole("tabpanel");
const taskTabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");

async function mockVideo(context: BrowserContext, api: MockCanvasApi) {
    await context.route("**/api/models", route => route.fulfill({ json: { models: [videoModel], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: videoModel.id, configurationVersion: 1 })) } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/assets/*/content", route => {
        const task = api.tasks.get(new URL(route.request().url()).pathname.split("/")[3]);
        return task ? route.fulfill({ contentType: "video/mp4", body: task.prompt?.includes("CURRENT_VIDEO_B") ? otherVideoBytes : videoBytes }) : route.fallback();
    });
    await context.route("**/api/assets/*/playback", route => {
        const task = api.tasks.get(new URL(route.request().url()).pathname.split("/")[3]);
        return route.fulfill({ contentType: "video/mp4", body: task?.prompt?.includes("CURRENT_VIDEO_B") ? otherVideoBytes : videoBytes });
    });
}

async function assertOnScreen(locator: Locator, page: Page) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    test(`video and seamless keep primary actions in view with two columns at ${viewport.width}`, async ({ page, context, api }, testInfo) => {
        await page.setViewportSize(viewport);
        await mockVideo(context, api);
        await page.goto("/video");
        await assertOnScreen(active(page).getByRole("button", { name: "生成视频", exact: true }), page);
        await assertOnScreen(active(page).getByRole("button", { name: "新建任务，继续创作", exact: true }), page);
        await expect(active(page).getByRole("tab", { name: "历史记录", exact: true })).toBeVisible();
        const videoColumns = await active(page).locator(".video-workbench-layout").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" "));
        expect(videoColumns).toHaveLength(2);
        expect(Number.parseFloat(videoColumns[0])).toBeLessThanOrEqual(440);
        await expect(active(page).getByText(/图片支持 JPEG\/PNG/)).toBeHidden();
        await page.screenshot({ path: testInfo.outputPath(`video-${viewport.width}.png`) });
        await active(page).getByRole("button", { name: "调整", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "参数", exact: true });
        await expect(settings.getByRole("combobox", { name: "视频生成方式" })).toBeVisible();
        await expect(settings.getByRole("combobox", { name: "视频时长" })).toBeVisible();
        const ratios = settings.getByTestId("video-ratio-options");
        await expect(ratios).toBeVisible();
        expect((await ratios.evaluate(element => getComputedStyle(element).gridTemplateColumns)).split(" ")).toHaveLength(5);
        await expect(settings).not.toContainText(/积分|预扣|费用|计费/);
        await context.unroute("**/api/models");
        await page.goto("/image?tool=seamless-stitch");
        await assertOnScreen(active(page).getByRole("button", { name: "开始无缝拼接", exact: true }), page);
        await assertOnScreen(active(page).getByRole("button", { name: "新建任务，继续创作", exact: true }), page);
        expect((await active(page).locator(".stitch-workbench-layout").evaluate(element => getComputedStyle(element).gridTemplateColumns)).split(" ")).toHaveLength(2);
        await expect(active(page)).not.toContainText(/积分|预扣|费用|计费/);
        await page.screenshot({ path: testInfo.outputPath(`seamless-${viewport.width}.png`) });
        await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
        await expect(page.getByRole("button", { name: "切换到浅色主题", exact: true })).toBeVisible();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
        await page.screenshot({ path: testInfo.outputPath(`seamless-dark-${viewport.width}.png`) });
        expect(api.submissions).toHaveLength(0);
    });
}

test("video history browsing stays separate while the current submitted task completes", async ({ page, context, api }) => {
    await mockVideo(context, api);
    api.taskStatus = "success";
    await page.goto("/video");
    const prompt = active(page).getByRole("textbox", { name: "视频提示词", exact: true });
    await prompt.fill("旧视频 HISTORY_VIDEO_A");
    await active(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect(active(page).locator("video")).toHaveCount(1);
    api.taskStatus = "processing";
    await prompt.fill("当前视频 CURRENT_VIDEO_B");
    await active(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    const currentId = [...api.tasks.keys()][1];
    await active(page).getByRole("tab", { name: "历史记录", exact: true }).click();
    await active(page).locator(".video-history-panel").getByRole("button", { name: /^旧视频 HISTORY_/ }).click();
    await expect(active(page).locator("video")).toHaveAttribute("src", /^blob:/);
    const oldPreview = await active(page).locator("video").getAttribute("src");
    expect(await active(page).locator("video").evaluate(async video => (await (await fetch(video.src)).arrayBuffer()).byteLength)).toBe(videoBytes.length);
    await expect(prompt).toHaveValue("当前视频 CURRENT_VIDEO_B");
    const task = api.tasks.get(currentId)!;
    task.status = "success"; task.resultUrls = [`/api/assets/${currentId}/content`];
    await expect(taskTabs(page).first()).toContainText("已完成");
    await expect(active(page).locator("video")).toHaveCount(1);
    await expect(active(page).locator("video")).toHaveAttribute("src", oldPreview!);
    await active(page).getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(active(page).locator("video")).toHaveCount(2);
    await expect.poll(async () => (await active(page).locator("video").evaluateAll(async videos => Promise.all(videos.map(async video => video.src ? (await (await fetch(video.src)).arrayBuffer()).byteLength : 0)))).sort((a, b) => a - b)).toEqual([videoBytes.length, otherVideoBytes.length].sort((a, b) => a - b));
    expect(api.submissions).toHaveLength(2);
});

test("seamless can browse history and create a second real workspace while A runs", async ({ page, api }) => {
    const oldId = "70000000-0000-4000-8000-000000000001";
    api.tasks.set(oldId, { id: oldId, requestId: "seamless-history", operationType: "seamless_stitch", status: "success", resultUrls: [`/api/assets/${oldId}/content`], createdAt: new Date().toISOString() });
    await page.goto("/image?tool=seamless-stitch");
    const upload = async (name: string, blue: number) => active(page).locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: fixturePng(blue) });
    await upload("source-A.png", 40);
    api.taskStatus = "processing";
    await active(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(active(page).getByRole("button", { name: "开始无缝拼接", exact: true })).toHaveText("正在处理无缝拼接");
    const aId = [...api.tasks.keys()].find(id => id !== oldId)!;
    await active(page).getByRole("tab", { name: "历史记录", exact: true }).click();
    await active(page).getByRole("button", { name: "查看处理结果", exact: true }).click();
    await expect(active(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toHaveAttribute("src", new RegExp(oldId));
    await expect(active(page).getByRole("button", { name: "上传", exact: true })).toBeEnabled();
    await active(page).getByRole("button", { name: "新建任务，继续创作", exact: true }).click();
    await expect(taskTabs(page)).toHaveCount(2);
    await expect(active(page).getByRole("img", { name: "source-A.png", exact: true })).toHaveCount(0);
    await upload("source-B.png", 210);
    await active(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await taskTabs(page).first().click();
    const a = api.tasks.get(aId)!;
    a.status = "success"; a.resultUrls = [`/api/assets/${aId}/content`];
    await expect(taskTabs(page).first()).toContainText("已完成");
    await expect(active(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toHaveAttribute("src", new RegExp(oldId));
    await active(page).getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(active(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    await expect(active(page).getByRole("img", { name: "source-A.png", exact: true })).toBeVisible();
    expect(new Set(api.submissions.map(item => item.requestId)).size).toBe(2);
    await taskTabs(page).nth(1).click();
    await expect(active(page).getByRole("img", { name: "source-B.png", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(2);
});

test("late history restoration preserves a newer uploaded video draft and the archived preview", async ({ page, context, api }) => {
    await mockVideo(context, api);
    api.taskStatus = "success";
    await page.goto("/video");
    const prompt = active(page).getByRole("textbox", { name: "视频提示词", exact: true });
    const upload = async (name: string, color: number) => {
        await active(page).locator('input[type="file"][accept^="image/"]').setInputFiles({ name, mimeType: "image/png", buffer: fixturePng(color) });
        await expect(active(page).getByRole("img", { name, exact: true })).toBeVisible();
    };
    await upload("archived-source.png", 31);
    await prompt.fill("历史恢复_原始视频");
    await active(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect(active(page).locator("video")).toHaveCount(1);
    const taskId = [...api.tasks.keys()][0];
    await active(page).getByRole("tab", { name: "历史记录", exact: true }).click();
    await active(page).locator(".video-history-panel").getByRole("button", { name: /^历史恢复_/ }).click();
    const restore = active(page).getByRole("button", { name: "恢复为草稿继续改", exact: true });
    await expect(restore).toBeEnabled();
    let release!: () => void;
    let pending = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await context.route(`**/api/tasks/${taskId}`, async route => {
        if (route.request().method() === "GET") { pending = true; await gate; }
        await route.fallback();
    });
    try {
        await restore.click();
        await page.getByRole("dialog", { name: "恢复为草稿？", exact: true }).getByRole("button", { name: "确认恢复", exact: true }).click();
        await expect.poll(() => pending).toBe(true);
        await expect(active(page).getByRole("img", { name: "archived-source.png", exact: true })).toHaveCount(0);
        await upload("new-draft-source.png", 213);
        await prompt.fill("新草稿保留，不被历史覆盖");
        release();
        await expect(restore).toBeEnabled();
        await expect(active(page).getByRole("img", { name: "new-draft-source.png", exact: true })).toBeVisible();
        await expect(active(page).getByRole("img", { name: "archived-source.png", exact: true })).toHaveCount(0);
        await expect(prompt).toHaveValue("新草稿保留，不被历史覆盖");
        await expect(active(page).locator("video")).toHaveCount(1);
        expect(await active(page).locator("video").evaluate(async video => (await (await fetch(video.src)).arrayBuffer()).byteLength)).toBe(videoBytes.length);
        expect(api.submissions).toHaveLength(1);
        const draft = await page.evaluate(async () => {
            const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
            const entries: unknown[] = [];
            await createWorkspaceStorage("video_generation_logs").iterate(value => { entries.push(value); });
            return entries;
        });
        expect(draft).toMatchObject([{ references: [{ name: "archived-source.png" }] }]);
    } finally { release(); }
});

test("wrapped tooltips remain available on disabled motion options and preserve theme and task actions", async ({ page, context, api }) => {
    await mockVideo(context, api);
    await page.goto("/video");
    const newTask = page.getByRole("region", { name: "多任务工作区", exact: true }).getByRole("button", { name: "新建任务", exact: true });
    await newTask.hover();
    await expect(page.getByRole("tooltip", { name: "开始独立任务，当前任务继续处理", exact: true })).toBeVisible();
    await expect(newTask).not.toHaveAttribute("title");
    await newTask.click();
    await expect(taskTabs(page)).toHaveCount(2);
    const motions = active(page).getByTestId("video-motion-panel");
    await motions.locator("summary").click();
    const actions = motions.getByRole("group", { name: "主体动作 · 最多选 2 项", exact: true });
    for (const selected of await actions.getByRole("button", { pressed: true }).all()) await selected.click();
    await actions.getByRole("button", { name: "自然微动", exact: true }).click();
    await actions.getByRole("button", { name: "转身展示", exact: true }).click();
    const disabled = actions.getByRole("button", { name: "走向镜头", exact: true });
    await expect(disabled).toBeDisabled();
    await expect(disabled).not.toHaveAttribute("title");
    await disabled.locator("..").hover();
    await expect(page.getByRole("tooltip", { name: "向镜头方向移动", exact: true })).toBeVisible();
    const theme = page.getByRole("button", { name: "切换到深色主题", exact: true });
    await theme.hover();
    await expect(page.getByRole("tooltip", { name: "切换到深色主题", exact: true })).toBeVisible();
    await theme.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("button", { name: "切换到浅色主题", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});
