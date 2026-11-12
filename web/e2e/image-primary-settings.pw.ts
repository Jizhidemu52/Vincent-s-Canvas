import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { antSelect, chooseAntSelect } from "./antd-select-helpers";
import { toolDefinitions } from "../../shared/feature-catalog";

const output = resolve(import.meta.dirname, "../../output/ui-plan-20261112/image-primary");
const models = [
    { id: "10000000-0000-4000-8000-000000000001", modelId: "gpt-image-2.6-flare", name: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2" },
    { id: "10000000-0000-4000-8000-000000000002", modelId: "gpt-image-2.6-sunburst", name: "aplmart-gpt2.6-sunburst", imageParameterProfile: "quality-resolution-v2" },
].map(model => ({ ...model, publicName: model.name, capabilities: ["generate", "edit", "upscale"], creditCost: 0, rmbCost: 0 }));

test.beforeEach(async ({ page, api }) => {
    void api;
    await page.route("**/api/models", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) }) }));
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    test(`inline primary controls select actual model ratio resolution at ${viewport.width}`, async ({ page, api }) => {
        await mkdir(output, { recursive: true });
        await page.setViewportSize(viewport);
        await page.goto("/image");
        const pane = page.getByRole("tabpanel");
        const primary = pane.getByRole("region", { name: "常用参数", exact: true });
        await expect(primary).toBeVisible();
        const picker = primary.getByRole("combobox", { name: "选择模型", exact: true });
        await expect(picker).toBeEnabled();
        await primary.scrollIntoViewIfNeeded();
        const grid = await primary.locator(".image-primary-grid").boundingBox();
        const model = await picker.boundingBox();
        const ratio = primary.getByRole("combobox", { name: "宽高比", exact: true });
        const resolution = primary.getByRole("combobox", { name: "分辨率", exact: true });
        const ratioBox = await antSelect(ratio).boundingBox();
        const resolutionBox = await antSelect(resolution).boundingBox();
        expect(grid!.x).toBeGreaterThanOrEqual(0);
        expect(grid!.x + grid!.width).toBeLessThanOrEqual(viewport.width);
        expect(Math.abs(ratioBox!.y - resolutionBox!.y)).toBeLessThan(2);
        if (viewport.width > 420) expect(Math.abs(model!.y - ratioBox!.y)).toBeLessThan(2);
        else expect(model!.y).toBeLessThan(ratioBox!.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await picker.click();
        const menu = page.getByTestId("canvas-model-picker-menu");
        await menu.getByRole("option", { name: /GPT Image 2.6 Sunburst/ }).first().click();
        await expect(picker).toContainText("GPT Image 2.6 Sunburst");
        await chooseAntSelect(ratio, "16:9");
        await chooseAntSelect(resolution, "2K");
        await page.keyboard.press("Escape");
        await pane.getByRole("textbox", { name: "图像提示词", exact: true }).fill("INLINE_ONLY_展示针织开衫");
        await primary.scrollIntoViewIfNeeded();
        await expect(pane.getByLabel("自定义宽度", { exact: true })).toHaveCount(0);
        expect(api.submissions).toHaveLength(0);
        await page.screenshot({ path: resolve(output, `inline-${viewport.width}.png`) });
        await pane.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: /切换生成图片模型/ });
        await expect(dialog.getByRole("combobox", { name: "生成图片模型" })).toContainText("GPT Image 2.6 Sunburst");
        await expect(antSelect(dialog.getByRole("combobox", { name: "宽高比", exact: true }))).toHaveText("16:9");
        await expect(antSelect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }))).toHaveText("2K");
        await expect(dialog.getByLabel("输出格式", { exact: true })).not.toBeVisible();
        await dialog.getByRole("button", { name: /^完\s*成$/ }).click();
        api.taskStatus = "processing";
        await pane.getByRole("button", { name: "开始生成", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        expect(api.submissions[0]).toMatchObject({ modelConfigId: models[1]!.id });
        expect(api.submissions[0]!.parameters).toMatchObject({ size: "16:9", resolution: "2k" });
        await chooseAntSelect(ratio, "9:16");
        expect(api.submissions[0]!.parameters).toMatchObject({ size: "16:9", resolution: "2k" });
        expect(api.submissions).toHaveLength(1);
    });
}

test("inline exact-pixel restriction preserves explicit dimensions and independent quality", async ({ page, api }) => {
    await page.goto("/image");
    const pane = page.getByRole("tabpanel");
    await pane.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /切换生成图片模型/ });
    await dialog.locator("summary", { hasText: "自定义像素" }).click();
    await dialog.getByLabel("自定义宽度", { exact: true }).fill("1536");
    await dialog.getByLabel("自定义宽度", { exact: true }).press("Tab");
    await chooseAntSelect(dialog.getByRole("combobox", { name: "图片质量", exact: true }), "高");
    await dialog.getByRole("button", { name: /^完\s*成$/ }).click();
    const primary = pane.getByRole("region", { name: "常用参数", exact: true });
    await expect(primary.getByRole("combobox", { name: "分辨率", exact: true })).toBeDisabled();
    await expect(primary.getByRole("status")).toContainText("精确像素 1536 × 1024 优先");
    await expect(antSelect(primary.getByRole("combobox", { name: "宽高比", exact: true }))).toHaveText("3:2");
    expect(api.submissions).toHaveLength(0);
});
