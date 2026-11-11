import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, newCanvas, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const omni = { id: "10000000-0000-4000-8000-000000000011", name: "Omni 视频", modelId: "gemini-omni-1.2-flash", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const seedance = { ...omni, id: "10000000-0000-4000-8000-000000000012", name: "Seedance 视频", modelId: "doubao-seedance-2.5" };
const reference = readFileSync(new URL("./media/reference.png", import.meta.url));
const sourceVideo = readFileSync(new URL("./media/video.mp4", import.meta.url));

async function fixture(context: BrowserContext, api: MockCanvasApi) {
    const state = { model: omni };
    const preflights: any[] = [];
    await context.route("**/api/models", route => route.fulfill({ json: { models: [omni, seedance], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: state.model.id, configurationVersion: 1 })), prices: [] } }));
    await context.route("**/api/tasks/preflight", route => {
        preflights.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true, normalized: {} } });
    });
    api.taskStatus = "queued";
    return { state, preflights };
}

async function openSettings(page: Page) {
    await page.getByRole("button", { name: "调整", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "参数", exact: true });
    await expect(drawer).toBeVisible();
    return drawer;
}

async function selectMode(page: Page, name: string) {
    await page.getByRole("combobox", { name: "视频生成方式", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText(name, { exact: true }).click();
}

async function uploadImages(page: Page, count: number) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片 · 首帧 / 尾帧", exact: true }).click();
    await (await chooser).setFiles(Array.from({ length: count }, (_, index) => ({ name: `omni-${index + 1}.png`, mimeType: "image/png", buffer: reference })));
    await expect(page.getByRole("img", { name: `omni-${count}.png`, exact: true })).toBeVisible();
}

test("Omni default settings and motion audio are usable at desktop and 390px without Seedance-only controls", async ({ page, context, api }, info) => {
    await fixture(context, api);
    await page.goto("/video");
    await expect(page.getByRole("button", { name: "生成视频", exact: true })).toBeEnabled();
    await expect(page.locator(".generation-submit")).toContainText("10s");
    const panel = page.getByTestId("video-motion-panel");
    await panel.locator("summary").click();
    await expect(panel.getByRole("button", { name: /^无\s*声$/ })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "仅环境音", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel).toContainText("不是静音开关");
    const drawer = await openSettings(page);
    for (const label of ["生成声音", "添加水印", "视频随机种子", "视频输出格式"]) await expect(drawer.getByLabel(label, { exact: true })).toHaveCount(0);
    await expect(drawer).toContainText("1080p 与 4K 为上采样输出");
    await expect(drawer.getByRole("combobox", { name: "视频时长", exact: true }).locator("..")).toContainText("10 秒");
    await selectMode(page, "首尾帧");
    await drawer.getByRole("combobox", { name: "视频时长", exact: true }).click();
    const durations = page.locator(".ant-select-dropdown:visible");
    await expect(durations.getByText("10 秒", { exact: true })).toBeVisible();
    await expect(durations.getByText("11 秒", { exact: true })).toHaveCount(0);
    await durations.getByText("8 秒", { exact: true }).click();
    await expect(durations).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("omni-settings-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(drawer.getByRole("combobox", { name: "视频时长", exact: true })).toBeVisible();
    expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("omni-settings-390.png") });
    expect(api.submissions).toHaveLength(0);
});

test("Omni automatic multi-image reference and explicit frame modes preserve extra reference roles in submission", async ({ page, context, api }) => {
    const { preflights } = await fixture(context, api);
    await page.goto("/video");
    await uploadImages(page, 3);
    const drawer = await openSettings(page);
    await selectMode(page, "首尾帧");
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("img", { name: "omni-3.png", exact: true }).locator("..")).toContainText("图片3");
    await page.getByRole("textbox", { name: "视频提示词", exact: true }).fill("从首帧平稳过渡到尾帧，保留参考人物。");
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(preflights).toHaveLength(1);
    const submission = api.submissions[0];
    expect(submission.parameters).toEqual({ tool: "video", videoMode: "first-last-frame", seconds: 10, size: "16:9", resolution: "720p" });
    expect(submission.promptInput).toMatchObject({ referenceRoles: ["首帧", "尾帧", "参考图片3"], fields: { audio: "ambient", generate_audio: true, duration: 10, video_mode: "first-last-frame" } });
    expect(submission.sourceUrls).toHaveLength(3);
    expect(preflights[0].parameters).toEqual(submission.parameters);
    expect([...api.assetBytes.values()].slice(0, 3).every(bytes => bytes.equals(reference))).toBe(true);
});

test("Omni source video automatically selects source-length editing and explicit extension labels additional seconds", async ({ page, context, api }) => {
    const { preflights } = await fixture(context, api);
    await page.goto("/video");
    await page.locator("summary").filter({ hasText: "参考素材" }).click();
    await expect(page.getByRole("button", { name: "上传音频", exact: true })).toHaveCount(0);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传视频", exact: true }).click();
    await (await chooser).setFiles({ name: "omni-source.mp4", mimeType: "video/mp4", buffer: sourceVideo });
    await expect(page.getByRole("button", { name: "移除参考视频", exact: true })).toBeVisible();
    await expect(page.locator(".generation-submit")).toContainText("跟随源片");
    const drawer = await openSettings(page);
    await expect(drawer.getByRole("combobox", { name: "视频时长", exact: true })).toBeDisabled();
    await expect(drawer).toContainText("编辑结果时长跟随源视频。");
    await selectMode(page, "视频延长 / 续写");
    await expect(drawer).toContainText("新增时长");
    await expect(drawer.getByRole("combobox", { name: "视频时长", exact: true })).toBeEnabled();
    await selectMode(page, "自动判断");
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("textbox", { name: "视频提示词", exact: true }).fill("只修改背景为浅灰，其他保持不变。");
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(preflights).toHaveLength(1);
    expect(api.submissions[0].parameters).toEqual({ tool: "video", videoMode: "auto", size: "16:9", resolution: "720p" });
    expect(api.submissions[0].promptInput.fields).not.toHaveProperty("duration");
    expect(api.submissions[0].promptInput.fields.video_mode).toBe("edit");
    expect(preflights[0].parameters).toEqual(api.submissions[0].parameters);
});

test("administrator binding switches back to retained Seedance controls without changing the saved description", async ({ page, context, api }) => {
    const { state } = await fixture(context, api);
    await page.goto("/video");
    const prompt = page.getByRole("textbox", { name: "视频提示词", exact: true });
    await prompt.fill("保留这个草稿");
    let drawer = await openSettings(page);
    await expect(drawer.getByRole("switch", { name: "生成声音", exact: true })).toHaveCount(0);
    state.model = seedance;
    await page.reload();
    await expect(prompt).toHaveValue("保留这个草稿");
    drawer = await openSettings(page);
    await expect(drawer.getByRole("switch", { name: "生成声音", exact: true })).toBeVisible();
    await expect(drawer.getByRole("switch", { name: "添加水印", exact: true })).toBeVisible();
    await expect(drawer.getByRole("textbox", { name: "视频随机种子", exact: true })).toBeVisible();
    await drawer.getByRole("combobox", { name: "视频时长", exact: true }).click();
    const durations = page.locator(".ant-select-dropdown:visible");
    await expect(durations.getByText("智能时长", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

test("new canvas Omni video uses ten seconds and retains an explicitly saved duration on reload", async ({ page, context, api }, info) => {
    await fixture(context, api);
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "视频节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await expect(node.getByRole("button", { name: /720p.*10s/ })).toBeVisible();
    expect(api.document(id)?.nodes[0].metadata?.seconds).toBeUndefined();
    await node.getByRole("button", { name: /720p.*10s/ }).click();
    const settings = page.locator(".canvas-image-settings-popover");
    await expect(settings).toContainText("视频设置");
    await expect(settings.getByRole("switch")).toHaveCount(0);
    await settings.getByRole("combobox", { name: "视频时长", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("8 秒", { exact: true }).click();
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    await expect.poll(() => api.document(id)?.nodes[0].metadata?.seconds).toBe("8");
    expect(await settings.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight && element.scrollHeight > element.clientHeight;
    })).toBe(true);
    await settings.hover();
    await page.mouse.wheel(0, -1000);
    await expect(settings.getByRole("combobox", { name: "视频生成方式", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("canvas-omni-settings.png"), fullPage: true });
    await page.reload();
    await expect(node).toBeAttached();
    await node.click({ position: { x: 20, y: 20 } });
    await expect(node.getByRole("button", { name: /720p.*8s/ })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});
