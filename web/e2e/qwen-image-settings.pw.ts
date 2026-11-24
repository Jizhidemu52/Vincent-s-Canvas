import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { toolDefinitions } from "../../shared/feature-catalog";
import { activeWorkbench } from "./headless-workbench";
import { chooseAntSelect } from "./antd-select-helpers";
import { IMAGE, expect, test } from "./fixtures";

const output = resolve(import.meta.dirname, "../../output/qwen-image-settings");
const models = [
    { id: "10000000-0000-4000-8000-000000000001", name: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2" },
    { id: "10000000-0000-4000-8000-000000000018", name: "Qwen Image 3.0", imageParameterProfile: "qwen-image" },
].map(model => ({ ...model, modelId: model.id, publicName: model.name, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 }));

function catalog(boundTool?: string) {
    return { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: tool.toolKey === boundTool ? models[0]!.id : null, configurationVersion: 1 })) };
}

test.beforeEach(async ({ page, api }) => {
    void api;
    await mkdir(output, { recursive: true });
    await page.route("**/api/models", route => route.fulfill({ json: catalog() }));
});

test("select Qwen and submit a creative drawing with its real aspect and resolution controls", async ({ page, api }) => {
    await page.goto("/creative/text-to-style");
    const pane = activeWorkbench(page);
    const settings = pane.locator(".cs-output-settings");
    await settings.locator(":scope > summary").click();
    const picker = settings.getByRole("combobox", { name: "选择模型", exact: true });
    await picker.click();
    const menu = page.getByTestId("canvas-model-picker-menu");
    await menu.getByRole("button", { name: /阿里千问/ }).click();
    await menu.getByRole("option", { name: /Qwen Image 3.0/ }).click();
    await chooseAntSelect(settings.getByRole("combobox", { name: "宽高比", exact: true }), "3:4");
    await chooseAntSelect(settings.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }), "2K");
    await expect(settings.getByRole("combobox", { name: "图片质量", exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(output, "qwen-text-to-style.png"), animations: "disabled" });
    await pane.getByRole("textbox", { name: "款式描述", exact: true }).fill("家居布艺产品图，纯色背景。");
    api.taskStatus = "processing";
    await pane.getByRole("button", { name: /^生成款式/ }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]).toMatchObject({ modelConfigId: models[1]!.id, parameters: { size: "3:4", resolution: "2k" } });
    expect(api.submissions[0]!.parameters).not.toHaveProperty("quality");
});

test("Qwen reference editing keeps resolution selectable and respects an administrator's fixed model", async ({ page, api }) => {
    await page.goto("/image?tool=image-edit");
    const pane = activeWorkbench(page);
    const primary = pane.getByRole("region", { name: "常用参数", exact: true });
    await primary.getByRole("combobox", { name: "选择模型", exact: true }).click();
    const menu = page.getByTestId("canvas-model-picker-menu");
    await menu.getByRole("button", { name: /阿里千问/ }).click();
    await menu.getByRole("option", { name: /Qwen Image 3.0/ }).click();
    await page.locator('input[type="file"][accept*="image"]').first().setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: IMAGE });
    await expect(primary.getByRole("combobox", { name: "分辨率", exact: true })).toBeEnabled();
    await chooseAntSelect(primary.getByRole("combobox", { name: "分辨率", exact: true }), "2K");
    await pane.getByRole("textbox", { name: "图像提示词", exact: true }).fill("保留产品结构，将背景改成米色。");
    await primary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, "qwen-reference-edit.png"), animations: "disabled" });
    api.taskStatus = "processing";
    await pane.getByRole("button", { name: "开始编辑", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]).toMatchObject({ modelConfigId: models[1]!.id, parameters: { resolution: "2k" } });
    expect(api.submissions[0]!.sourceUrls).toHaveLength(1);

    await page.route("**/api/models", route => route.fulfill({ json: catalog("image-edit") }));
    await page.reload();
    const fixed = primary.getByRole("combobox", { name: "选择模型", exact: true });
    await expect(fixed).toContainText("GPT Image 2.6 Flare");
    if (await fixed.isEnabled()) {
        await fixed.click();
        await expect(menu.getByRole("option", { name: /Qwen Image 3.0/ })).toHaveCount(0);
    }
    expect(api.submissions).toHaveLength(1);
});
