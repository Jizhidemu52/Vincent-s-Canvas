import { test, expect } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const standard = { id: "10000000-0000-4000-8000-000000000011", name: "Seedance 2.5", modelId: "doubao-seedance-2.5", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const flash = { ...standard, id: "10000000-0000-4000-8000-000000000015", name: "Seedance 2.5 Flash", modelId: "seedance-2-5-flash" };

test("Seedance Flash is selectable and exposes its own desktop and mobile limits", async ({ page, context, api }, info) => {
    await context.route("**/api/models", route => route.fulfill({ json: { models: [standard, flash], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })), prices: [] } }));
    await page.goto("/video");
    await page.getByRole("button", { name: "调整", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "参数", exact: true });
    await expect(settings.getByRole("button", { name: "1080p", exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "1080p", exact: true }).click();
    await settings.getByRole("combobox", { name: "选择模型", exact: true }).click();
    const menu = page.getByTestId("canvas-model-picker-menu");
    const choices = menu.getByRole("option", { name: "Seedance 2.5 Flash", exact: true });
    if (!await choices.count()) await menu.locator(".canvas-model-family-toggle").filter({ hasText: "Seedance" }).click();
    await choices.first().click();
    await expect(settings.getByRole("combobox", { name: "选择模型", exact: true })).toContainText("Seedance 2.5 Flash");
    await expect(settings.getByRole("button", { name: "1080p", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "720p", exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "480p", exact: true })).toBeVisible();
    await expect(settings.getByRole("switch", { name: "生成声音", exact: true })).toBeVisible();
    await expect(settings.getByRole("combobox", { name: "视频输出格式", exact: true })).toBeVisible();
    await settings.getByRole("combobox", { name: "视频生成方式", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("首尾帧", { exact: true }).click();
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    await expect(settings).toContainText("此模式固定使用自适应比例");
    await page.screenshot({ path: info.outputPath("seedance-flash-settings-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(settings.getByRole("combobox", { name: "视频时长", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("seedance-flash-settings-390.png") });
    expect(api.submissions).toHaveLength(0);
});
