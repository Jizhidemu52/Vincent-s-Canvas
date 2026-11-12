import { test, expect, type Page } from "@playwright/test";
import { MockCanvasApi } from "./fixtures";

async function prepare(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL);
    await api.attach(page.context());
    await page.context().route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0 } }));
    await page.context().route("**/api/layer-studio/estimate", route => route.fulfill({ json: { estimate: { currency: "CNY", estimatedPrecharge: 3.2, maximumOutputs: 1, sourceCount: 0, priceVersion: 1, employeeCredits: 0, providerCharge: "unverified" } } }));
    return api;
}
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    test(`shared pages and ready layer footer are legible in both themes at ${size.width}`, async ({ page }) => {
        const api = await prepare(page);
        await page.setViewportSize(size);
        await page.goto("/");
        await expect(page.getByRole("heading", { name: "想法成真", exact: true })).toBeVisible();
        await expect(page.locator(".home-tool-preview img").first()).toHaveAttribute("data-loaded", "true");
        const homeTitle = await page.locator(".home-content .wb-title").first().boundingBox();
        await page.screenshot({ path: test.info().outputPath("home-light.png") });
        await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
        await page.screenshot({ path: test.info().outputPath("home-dark.png") });
        await page.goto("/assets");
        await expect(page.getByRole("heading", { name: "素材库", exact: true })).toBeVisible();
        const assetTitle = await page.locator(".wb-title").boundingBox();
        expect(Math.abs(assetTitle!.x - homeTitle!.x)).toBeLessThan(2);
        await page.getByRole("button", { name: "添加", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "上传图片" })).toBeVisible();
        await page.keyboard.press("Escape");
        await noOverflow(page);
        await page.screenshot({ path: test.info().outputPath("assets-dark.png") });
        await page.goto("/prompts");
        const promptTabs = page.getByRole("navigation", { name: "提示词分类", exact: true });
        await expect(promptTabs.getByRole("link", { name: "共享提示词", exact: true })).toHaveAttribute("aria-current", "page");
        await promptTabs.getByRole("link", { name: "我的提示词", exact: true }).click();
        await expect(page).toHaveURL(/\/my-prompts$/);
        await expect(promptTabs.getByRole("link", { name: "我的提示词", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "提示词库", exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath("prompt-tabs-dark.png") });
        await page.goto("/layer-studio");
        await page.getByRole("button", { name: "图片生成 / 编辑", exact: true }).click();
        await page.getByRole("textbox", { name: "图片描述", exact: true }).fill("针织服装细节，保留原有结构");
        const generate = page.getByRole("button", { name: "生成图片", exact: true });
        await expect(generate).toBeEnabled();
        await expect(generate).toBeInViewport();
        await expect(generate).toHaveText("生成图片");
        await expect(page.getByRole("button", { name: "新建任务", exact: true })).toBeInViewport();
        for (const theme of ["dark", "light"]) {
            if (theme === "light") await page.getByRole("button", { name: "切换到浅色主题", exact: true }).click();
            await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
            const contrast = await generate.evaluate(element => {
                const style = getComputedStyle(element);
                const luminance = (color: string) => {
                    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
                    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
                };
                const text = luminance(style.color), background = luminance(style.backgroundColor);
                return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
            });
            const colors = await generate.evaluate(element => {
                const style = getComputedStyle(element);
                return { color: style.color, background: style.backgroundColor };
            });
            expect(contrast, JSON.stringify(colors)).toBeGreaterThan(4.5);
            await noOverflow(page);
            await page.screenshot({ path: test.info().outputPath(`layer-ready-${theme}.png`) });
        }
        expect(api.submissions).toEqual([]);
        expect(api.blocked).toEqual([]); expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
    });
}

test("image loading reserves a neutral box, fades only after load and honors reduced motion", async ({ page }) => {
    const api = await prepare(page);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/design-examples/knit-sketch.webp", async route => { await hold; await route.continue(); });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const image = page.locator(".home-tool-preview img").first();
    await expect(image).toHaveAttribute("data-loaded", "false");
    await expect(image).toBeVisible();
    expect(await image.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    release();
    await expect(image).toHaveAttribute("data-loaded", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await image.evaluate(element => Number.parseFloat(getComputedStyle(element).animationDuration))).toBeLessThan(.001);
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await page.screenshot({ path: test.info().outputPath("home-mobile.png") });
    expect(api.submissions).toEqual([]); expect(api.blocked).toEqual([]); expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
});
