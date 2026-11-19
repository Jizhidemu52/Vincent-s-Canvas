import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect, IMAGE } from "./fixtures";
import { antSelect, chooseAntSelect } from "./antd-select-helpers";
import { activeWorkbench } from "./headless-workbench";
import { toolDefinitions } from "../../shared/feature-catalog";

const output = resolve(import.meta.dirname, "../../output/mai27-model-settings");
const models = [
    { id: "10000000-0000-4000-8000-000000000001", modelId: "gpt-image-2.6-flare", name: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2" },
    { id: "10000000-0000-4000-8000-000000000016", modelId: "mai-image-2.7-flash", name: "aplmart-mai2.7-flash", imageParameterProfile: "mai-image-v2" },
].map(model => ({ ...model, publicName: model.name, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 }));

test.beforeEach(async ({ page, api }) => {
    void api;
    await mkdir(output, { recursive: true });
    await page.route("**/api/models", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) }) }));
});

for (const width of [1440, 390]) test(`MAI 2.7 selection and text-to-image settings at ${width}px`, async ({ page, api }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto("/creative/text-to-style");
    const pane = activeWorkbench(page);
    const settings = pane.locator(".cs-output-settings");
    await settings.locator(":scope > summary").click();
    const picker = settings.getByRole("combobox", { name: "选择模型", exact: true });
    await picker.click();
    const menu = page.getByTestId("canvas-model-picker-menu");
    await menu.getByRole("button", { name: /Microsoft/ }).click();
    await menu.getByRole("option", { name: /MAI Image 2.7 Flash/ }).click();
    await expect(picker).toContainText("MAI Image 2.7 Flash");
    const ratio = settings.getByRole("combobox", { name: "宽高比", exact: true });
    const resolution = settings.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true });
    await chooseAntSelect(ratio, "16:9");
    await chooseAntSelect(resolution, "2K");
    await expect(antSelect(ratio)).toHaveText("16:9");
    await expect(antSelect(resolution)).toHaveText("2K");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await settings.locator("summary", { hasText: "全部高级参数" }).click();
    await expect(settings.getByRole("combobox", { name: "提交前内容检查", exact: true })).toBeVisible();
    await expect(settings.getByRole("combobox", { name: "联网参考", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("combobox", { name: "图片质量", exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(output, `mai27-settings-${width}.png`) });
    await pane.getByRole("textbox", { name: "款式描述", exact: true }).fill("MAI 2.7 模型参数回归测试");
    api.taskStatus = "processing";
    await pane.getByRole("button", { name: /^生成款式/ }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]).toMatchObject({ modelConfigId: models[1]!.id, parameters: { size: "16:9", resolution: "2k" } });
    expect(api.submissions[0]!.parameters).not.toHaveProperty("web_grounding");
    expect(api.submissions[0]!.parameters).not.toHaveProperty("quality");
});

test("MAI 2.7 reference editing disables output dimensions and sends no fake 2K preference", async ({ page, api }) => {
    await page.goto("/image?tool=image-edit");
    const pane = activeWorkbench(page);
    const primary = pane.getByRole("region", { name: "常用参数", exact: true });
    await primary.getByRole("combobox", { name: "选择模型", exact: true }).click();
    const menu = page.getByTestId("canvas-model-picker-menu");
    await menu.getByRole("button", { name: /Microsoft/ }).click();
    await menu.getByRole("option", { name: /MAI Image 2.7 Flash/ }).click();
    await page.locator('input[type="file"][accept*="image"]').first().setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: IMAGE });
    await expect(primary.getByRole("combobox", { name: "宽高比", exact: true })).toBeDisabled();
    await expect(primary.getByRole("combobox", { name: "分辨率", exact: true })).toBeDisabled();
    await expect(primary.getByRole("status")).toContainText("模型根据参考图决定");
    await expect(pane).not.toContainText("100 万像素");
    await pane.getByRole("textbox", { name: "图像提示词", exact: true }).fill("保持图案结构，改为蓝色。");
    await primary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, "mai27-reference-edit.png") });
    api.taskStatus = "processing";
    await pane.getByRole("button", { name: "开始编辑", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]).toMatchObject({ modelConfigId: models[1]!.id });
    expect(api.submissions[0]!.parameters).not.toHaveProperty("size");
    expect(api.submissions[0]!.parameters).not.toHaveProperty("resolution");
    expect(api.submissions[0]!.sourceUrls).toHaveLength(1);
});

test("chat MAI 2.7 defaults visibly to 1:1 without a saved session size", async ({ page, api }) => {
    await page.route("**/api/models", route => route.fulfill({ json: { models: [models[1], { id: "chat", modelId: "gemini-4-carbon", name: "隔离对话模型", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: tool.toolKey === "gpt-chat" ? "chat" : null, configurationVersion: 1 })) } }));
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "出图设置", exact: true }).click();
    await expect(page.getByTestId("chat-image-size")).toContainText("1:1");
    await expect(page.getByText("默认使用 1:1 画幅，可手动指定比例；带参考图时由模型决定尺寸。", { exact: true })).toBeVisible();
    await expect(page.getByText("默认自动选择画幅，也可手动指定比例。", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(output, "mai27-chat-default-size.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});
