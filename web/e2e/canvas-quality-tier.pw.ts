import { toolDefinitions } from "../../shared/feature-catalog";
import type { BrowserContext } from "@playwright/test";
import { expect, newCanvas, test } from "./fixtures";

async function useQualityModel(context: BrowserContext) {
    const model = { id: "10000000-0000-4000-8000-000000000001", modelId: "gpt-image-2.6-flare", name: "Fixture image", protocol: "openai", capabilities: ["generate","edit"], creditCost: 0 };
    await context.route("**/api/models", route => route.fulfill({ json: { models: [model], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })) } }));
}

test("config node quality presets persist the exact two parameters without generating", async ({ page, context, api }, info) => {
    await useQualityModel(context);
    const project = await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "生成配置", exact: true }).click();
    const picker = page.getByRole("group", { name: "图片质量", exact: true });
    await picker.getByText("高清", { exact: true }).click();
    const stored = () => api.document(project)?.nodes.find(node => node.type === "config")?.metadata;
    await expect.poll(() => [stored()?.quality, JSON.parse(stored()?.imageOptions || "{}").resolution]).toEqual(["high", "2k"]);
    await page.reload();
    await expect(picker.getByRole("radio", { name: "高清", exact: true })).toBeChecked();
    await picker.getByText("标准", { exact: true }).click();
    await expect.poll(() => [stored()?.quality, JSON.parse(stored()?.imageOptions || "{}").resolution]).toEqual(["medium", "1k"]);
    expect(api.submissions).toHaveLength(0);
    await picker.screenshot({ path: info.outputPath("quality-presets.png") });
});

test("canvas creation applies the chosen quality and resolution only on generate", async ({ page, context, api }, info) => {
    await useQualityModel(context);
    await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill("只改袖口的颜色");
    await panel.getByRole("group", { name: "图片质量", exact: true }).getByText("高清", { exact: true }).click();
    await expect(panel.getByRole("radio", { name: "高清", exact: true })).toBeChecked();
    expect(api.submissions).toHaveLength(0);
    await panel.screenshot({ path: info.outputPath("creation-quality.png") });
    await panel.locator("button.cw-generate-button").click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].parameters).toMatchObject({ quality: "high", resolution: "2k" });
});
