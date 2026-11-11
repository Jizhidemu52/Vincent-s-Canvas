import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const oldModel = { id: "10000000-0000-4000-8000-000000000025", name: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution" };
const flare = { id: "10000000-0000-4000-8000-000000000026", name: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2" };
const models = [oldModel, flare].map(model => ({ ...model, modelId: model.id, publicName: model.name, imageSupportsMask: true, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0, isFeatured: true }));
const pickerSelector = '[data-usage-control="model"][role="combobox"]';
const flareLabel = /(?:aplmart-gpt2\.6-flare|GPT Image 2\.6 Flare)/i;
const oldLabel = /(?:aplmart-gpt2\.5-flare|GPT Image 2\.5 Flare)/i;

async function setup(page: Page) {
    await page.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
}
async function imageSettings(page: Page, path: string) {
    await page.goto(path);
    await page.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    return page.getByRole("dialog").locator(pickerSelector);
}
async function selectOld(page: Page, picker: Locator) {
    await picker.click();
    await page.locator(`[role="option"][data-usage-value="${oldModel.id}"]`).click();
    await expect(picker).toContainText(oldLabel);
}

test("new image, edit, creative and seamless workspaces use Flare without selecting the first catalog row", async ({ page, api }) => {
    await setup(page);
    for (const path of ["/image", "/image?tool=image-edit"]) {
        const picker = await imageSettings(page, path);
        await expect(picker).toContainText(flareLabel);
    }
    for (const path of ["/creative/text-to-style", "/creative/style-to-sketch", "/image?tool=seamless-stitch"]) {
        await page.goto(path);
        await expect(page.locator(pickerSelector)).toContainText(flareLabel);
    }
    expect(api.submissions).toHaveLength(0);
});

test("explicit image and seamless model choices persist separately and do not replace other new workspace defaults", async ({ page, api }) => {
    await setup(page);
    let picker = await imageSettings(page, "/image");
    await selectOld(page, picker);
    await page.getByRole("dialog").getByRole("button", { name: /^完\s*成$/ }).click();
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("保留明确选择的旧模型");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].modelConfigId).toBe(oldModel.id);
    await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
    picker = await imageSettings(page, "/image?tool=image-edit");
    await expect(picker).toContainText(flareLabel);
    picker = await imageSettings(page, "/image");
    await expect(picker).toContainText(oldLabel);

    await page.goto("/image?tool=seamless-stitch");
    picker = page.locator(pickerSelector);
    await expect(picker).toContainText(flareLabel);
    await selectOld(page, picker);
    await page.getByRole("combobox", { name: "图片质量", exact: true }).selectOption("max");
    await page.reload();
    await expect(page.locator(pickerSelector)).toContainText(oldLabel);
    await expect(page.getByRole("combobox", { name: "图片质量", exact: true })).toHaveValue("max");
    await page.goto("/creative/text-to-style");
    await expect(page.locator(pickerSelector)).toContainText(flareLabel);
    expect(api.submissions).toHaveLength(1);
});
