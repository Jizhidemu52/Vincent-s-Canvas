import { test, expect } from "./fixtures";
import { creativeCatalogPresets } from "../src/lib/creative-presets";
import { moduleDefinitions } from "../../shared/feature-catalog";

test("each creative scene and workbench can be pinned, restored and unpinned without leaving the catalog", async ({ page, api }, info) => {
    await page.goto("/creative");
    const catalog = page.locator("main.creative-page");
    const entries = [...creativeCatalogPresets.map(item => ({ label: item.title, path: `/creative/${item.id}` })),
        { label: "图案定位", path: "/creative/pattern-placement" },
        { label: "花型循环", pinnedLabel: "图案循环", path: "/creative/pattern-repeat" }];
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "固定图像生成", exact: true }).click();
    for (const item of entries) {
        await catalog.getByRole("button", { name: `固定${item.label}`, exact: true }).click();
        await expect(catalog.getByRole("button", { name: `取消固定${item.label}`, exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page).toHaveURL(/\/creative$/);
    }
    const pins = page.getByRole("region", { name: "固定入口" });
    await expect(pins.getByRole("link")).toHaveCount(entries.length + 1);
    await page.reload();
    for (const item of entries) await expect(pins.getByRole("link", { name: `${"pinnedLabel" in item ? item.pinnedLabel : item.label}（常用）`, exact: true })).toHaveAttribute("href", item.path);
    await page.screenshot({ path: info.outputPath("creative-pins-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await catalog.getByRole("button", { name: "取消固定图案定位", exact: true }).click();
    await expect(catalog.getByRole("button", { name: "固定图案定位", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "功能模块", exact: true });
    await expect(drawer.getByRole("link", { name: "图案定位（常用）", exact: true })).toHaveCount(0);
    await expect(drawer.getByRole("link", { name: "图案循环（常用）", exact: true })).toHaveAttribute("href", "/creative/pattern-repeat");
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.screenshot({ path: info.outputPath("creative-pins-mobile.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("disabled creative modules cannot be pinned or opened from existing favorites", async ({ page, context, api }) => {
    await page.goto("/creative");
    await page.locator("main.creative-page").getByRole("button", { name: "固定图案定位", exact: true }).click();
    await context.route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: item.moduleKey !== "pattern-placement" })) } }));
    await page.reload();
    await expect(page.locator("main.creative-page").getByRole("button", { name: /固定图案定位/, exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "固定入口" }).getByRole("link", { name: "图案定位（常用）", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});
