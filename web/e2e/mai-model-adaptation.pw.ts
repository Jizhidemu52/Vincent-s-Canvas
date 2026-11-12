import type { Locator, Page } from "@playwright/test";
import { test, expect, IMAGE, newCanvas } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { antSelect, chooseAntSelect } from "./antd-select-helpers";

const make = (last: number, name: string, profile: string) => ({ id: `10000000-0000-4000-8000-${String(last).padStart(12, "0")}`, modelId: `10000000-0000-4000-8000-${String(last).padStart(12, "0")}`, name, publicName: name, imageParameterProfile: profile, imageSupportsMask: profile.startsWith("quality-resolution"), capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0, isFeatured: true, displayOrder: last });
const flare = make(11, "aplmart-gpt2.6-flare", "quality-resolution-v2");
const sunburst = make(12, "aplmart-gpt2.6-sunburst", "quality-resolution-v2");
const mai = make(13, "aplmart-mai2.6-flash", "mai-image");
const nano = make(14, "aplmart-nano2.1", "resolution-1k");
const grok = make(15, "aplmart-grok2", "grok-image");
const catalog = [nano, grok, mai, sunburst, flare];
const optimized = "A blue linen dress, preserve the fabric texture and original silhouette.";
const compilationId = "20000000-0000-4000-8000-000000000100";

async function setup(page: Page) {
    await page.route("**/api/models", route => route.fulfill({ json: { models: catalog, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    const compilations: any[] = [];
    await page.route("**/api/prompt-compilations", route => {
        const input = route.request().postDataJSON(); compilations.push(input);
        return route.fulfill({ json: { compilation: { id: compilationId, requestId: input.requestId, status: "success", prompt: optimized, optimized: true } } });
    });
    return compilations;
}

async function openSettings(page: Page) {
    await page.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    return page.getByRole("dialog", { name: /^切换生成图片模型/ });
}
async function selectStandalone(page: Page, settings: Locator, model: typeof mai) {
    await settings.locator('[data-usage-control="model"][role="combobox"]').click();
    await page.locator(`[role="option"][data-usage-value="${model.id}"]`).click();
}
async function addReference(prompt: Locator, count = 1) {
    await prompt.evaluate((element, { bytes, count }) => {
        const data = new DataTransfer();
        for (let index = 0; index < count; index++) data.items.add(new File([Uint8Array.from(bytes)], `reference-${index + 1}.png`, { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { bytes: [...IMAGE], count });
}
async function canvasSelect(page: Page, panel: Locator, model: typeof mai) {
    await panel.getByRole("combobox", { name: "选择模型", exact: true }).click();
    await page.getByTestId("canvas-model-picker-menu").locator(`[role="option"][data-usage-value="${model.id}"]`).first().click();
}

for (const model of [flare, sunburst, mai]) {
    for (const editing of [false, true]) {
        test(`${model.name} ${editing ? "reference edit" : "text image"}: optimized text submits once with the selected model and supported settings`, async ({ page, api }) => {
            const compilations = await setup(page);
            await page.goto(`/image${editing ? "?tool=image-edit" : ""}`);
            const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
            await prompt.fill("蓝色亚麻连衣裙，保留材质");
            const settings = await openSettings(page);
            await selectStandalone(page, settings, model);
            await chooseAntSelect(settings.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }), "2K");
            if (model !== mai) await chooseAntSelect(settings.getByRole("combobox", { name: "图片质量", exact: true }), "高");
            else await expect(settings.getByRole("combobox", { name: "图片质量", exact: true })).toHaveCount(0);
            await settings.getByRole("button", { name: "关闭模型设置", exact: true }).click();
            if (editing) {
                await addReference(prompt);
                await expect(page.getByRole("img", { name: "reference-1.png", exact: true })).toBeVisible();
            }
            await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
            const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
            await expect(preview.locator("pre").nth(1)).toHaveText(optimized);
            await expect(prompt).toHaveValue("蓝色亚麻连衣裙，保留材质");
            expect(api.submissions).toHaveLength(0);
            await preview.getByRole("button", { name: "确认应用", exact: true }).click();
            await expect(preview).toBeHidden();
            await expect(prompt).toHaveValue(optimized);
            expect(compilations).toHaveLength(1);
            expect(compilations[0].modelConfigId).toBe(model.id);
            expect(api.submissions).toHaveLength(0);
            await page.getByRole("button", { name: editing ? "开始编辑" : "开始生成", exact: true }).click();
            await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
            expect(api.submissions).toHaveLength(1);
            expect(api.submissions[0]).toMatchObject({ modelConfigId: model.id, promptInput: { compilationId }, sourceUrls: compilations[0].sourceUrls });
            if (model === mai) {
                expect(api.submissions[0].parameters).not.toHaveProperty("quality");
                expect(api.submissions[0].parameters).not.toHaveProperty("output_format");
                if (editing) for (const key of ["size", "resolution", "width", "height"]) expect(api.submissions[0].parameters).not.toHaveProperty(key);
                else expect(api.submissions[0].parameters).toMatchObject({ resolution: "2k", size: "1:1" });
            } else expect(api.submissions[0].parameters).toMatchObject({ quality: "high", resolution: "2k" });
        });
    }
}

test("standalone explicit model changes clear incompatible 4K options and old optimization IDs without losing text", async ({ page, api }, testInfo) => {
    const compilations = await setup(page);
    await page.goto("/image");
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await prompt.fill("保留轮廓的服装产品图");
    let settings = await openSettings(page);
    await expect(settings.locator('[data-usage-control="model"]')).toContainText("GPT Image 2.6 Flare");
    await chooseAntSelect(settings.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }), "4K");
    await settings.getByText("高级参数", { exact: true }).click();
    await chooseAntSelect(settings.getByRole("combobox", { name: "背景", exact: true }), "透明");
    await chooseAntSelect(settings.getByRole("combobox", { name: "输出格式", exact: true }), "WebP");
    await settings.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
    await expect(preview.locator("pre").nth(1)).toHaveText(optimized);
    await expect(prompt).toHaveValue("保留轮廓的服装产品图");
    expect(api.submissions).toHaveLength(0);
    await preview.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(prompt).toHaveValue(optimized);
    settings = await openSettings(page);
    await selectStandalone(page, settings, mai);
    await expect(antSelect(settings.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }))).toHaveText("1K");
    await settings.getByText("高级参数", { exact: true }).click();
    await expect(settings.getByRole("combobox", { name: "背景", exact: true })).toHaveCount(0);
    await chooseAntSelect(settings.getByRole("combobox", { name: "联网参考", exact: true }), "关闭");
    await page.screenshot({ path: testInfo.outputPath("mai-text-settings.png"), animations: "disabled" });
    await settings.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await expect(prompt).toHaveValue(optimized);
    await addReference(prompt);
    await expect(page.getByRole("img", { name: "reference-1.png", exact: true })).toBeVisible();
    await expect(page.getByText("aplmart-mai2.6-flash · 模型决定尺寸 · 约 100 万像素", { exact: true })).toBeVisible();
    settings = await openSettings(page);
    await expect(settings.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("status").filter({ hasText: "图生图尺寸由模型决定，约 100 万像素" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mai-reference-settings.png"), animations: "disabled" });
    await settings.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
    expect(compilations).toHaveLength(1); expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0].modelConfigId).toBe(mai.id);
    expect(api.submissions[0].promptInput).toBeUndefined();
    expect(api.submissions[0].parameters).toMatchObject({ web_grounding: false, count: 1, n: 1 });
    expect(api.submissions[0].parameters.inputArchive.parameters).toEqual({ web_grounding: false });
    for (const key of ["size", "resolution", "width", "height", "quality", "background", "output_format"]) expect(api.submissions[0].parameters).not.toHaveProperty(key);
});

test("canvas switches profiles without truncating references and restores text-only settings after removal", async ({ page, api }, testInfo) => {
    const compilations = await setup(page);
    await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    const prompt = panel.getByRole("textbox", { name: "描述图像", exact: true });
    await prompt.fill("蓝色亚麻连衣裙");
    await expect(panel.getByRole("combobox", { name: "选择模型", exact: true })).toContainText("GPT Image 2.6 Flare");
    await panel.getByRole("button", { name: "分辨率与质量", exact: true }).click();
    await page.locator('[data-usage-control="resolution"][data-usage-value="4k"]').click();
    await page.getByRole("button", { name: "返回创建面板", exact: true }).click();
    await panel.evaluate((element, bytes) => {
        const data = new DataTransfer();
        for (let index = 0; index < 6; index++) data.items.add(new File([Uint8Array.from(bytes)], `reference-${index + 1}.png`, { type: "image/png" }));
        element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    }, [...IMAGE]);
    await expect(panel.locator(".cw-reference-image")).toHaveCount(6);
    await canvasSelect(page, panel, mai);
    await expect(panel.locator(".cw-reference-image")).toHaveCount(6);
    await expect(panel.getByRole("button", { name: "生成修改图", exact: false })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "宽高比", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "移除参考图 6", exact: true }).click();
    await expect(panel.locator(".cw-reference-image")).toHaveCount(5);
    await expect(panel.getByRole("button", { name: "生成修改图", exact: false })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("mai-canvas-five-references.png") });
    await panel.getByRole("button", { name: "清空", exact: true }).click();
    await expect(panel.getByRole("button", { name: "宽高比", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "清晰度 / 分辨率", exact: true }).click();
    await expect(page.locator('[data-usage-control="resolution"][data-usage-value="1k"]')).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-usage-control="resolution"][data-usage-value="2k"]').click();
    await page.getByRole("button", { name: "返回创建面板", exact: true }).click();
    await panel.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
    await expect(preview.locator("pre").nth(1)).toHaveText(optimized);
    await expect(prompt).toHaveValue("蓝色亚麻连衣裙");
    expect(api.submissions).toHaveLength(0);
    await preview.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(prompt).toHaveValue(optimized);
    await panel.getByRole("button", { name: /^生成(?:\s|$)/ }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]).toMatchObject({ modelConfigId: mai.id, promptInput: { compilationId }, parameters: { resolution: "2k" } });
    expect(api.submissions[0].parameters).not.toHaveProperty("quality");
    expect(compilations).toHaveLength(1);
});
