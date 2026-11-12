import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { antSelect, chooseAntSelect } from "./antd-select-helpers";

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/image-generation-settings-dialog.fixture.tsx"></script></body></html>`;
const output = resolve(import.meta.dirname, "../../output/image-generation-settings-dialog");
const sunburst = "7bf4a4e1-7202-49dd-bf16-363d01971347";

test.beforeEach(async ({ page }) => {
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1" || url.pathname.startsWith("/api/")) return route.abort();
        if (url.pathname === "/__image-settings") return route.fulfill({ contentType: "text/html", body: fixture });
        return route.continue();
    });
});

async function openDialog(page: Page, query = "") {
    await page.goto(`/__image-settings${query}`);
    const opener = page.getByRole("button", { name: "切换生成图片模型", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: /切换生成图片模型/ });
    await expect(dialog).toBeVisible();
    return { dialog, opener, picker: dialog.getByRole("combobox", { name: "生成图片模型", exact: true }) };
}

test("desktop model selection and parameters are retained after closing, with focus restored", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const { dialog, opener, picker } = await openDialog(page);
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(760);
    expect(bounds!.width).toBeLessThanOrEqual(900);
    expect(bounds!.height).toBeLessThan(750);
    await expect(picker).toBeFocused();
    await expect(picker).toContainText("GPT Image 2.6 Flare");
    await expect(picker).not.toContainText("7bf4a4e1");
    await expect(dialog.getByLabel("输出格式", { exact: true })).not.toBeVisible();
    await page.screenshot({ path: resolve(output, "desktop-light.png") });
    await picker.press("Enter");
    await expect(page.getByRole("option", { name: /GPT Image 2.6 Flare/ })).toHaveAttribute("data-state", "checked");
    await page.getByRole("option", { name: /GPT Image 2.6 Sunburst/ }).click();
    await expect(picker).toContainText("GPT Image 2.6 Sunburst");
    await chooseAntSelect(dialog.getByRole("combobox", { name: "宽高比", exact: true }), "16:9");
    await chooseAntSelect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }), "2K");
    await chooseAntSelect(dialog.getByRole("combobox", { name: "图片质量", exact: true }), "高");
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    await chooseAntSelect(dialog.getByRole("combobox", { name: "输出格式", exact: true }), "PNG");
    await dialog.getByRole("button", { name: /^完\s*成$/ }).click();
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    const config = JSON.parse(await page.getByTestId("settings-state").textContent() || "{}");
    expect(config).toMatchObject({ imageModel: sunburst, size: "16:9", quality: "high", count: "1" });
    expect(JSON.parse(config.imageOptions)).toMatchObject({ resolution: "2k", output_format: "png" });
    await opener.click();
    await expect(picker).toContainText("GPT Image 2.6 Sunburst");
    await expect(antSelect(dialog.getByRole("combobox", { name: "宽高比", exact: true }))).toHaveText("16:9");
    await expect(dialog.getByLabel("输出格式", { exact: true })).not.toBeVisible();
    await picker.press("Enter");
    await expect(page.getByRole("listbox", { name: "可用生成图片模型", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: /GPT Image 2.6 Sunburst/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(picker).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    expect(errors).toEqual([]);
});

test("390px dark reduced-motion sheet stays in bounds, supports long labels and keyboard navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    const { dialog, opener, picker } = await openDialog(page, "?theme=dark");
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.height).toBeLessThanOrEqual(830);
    expect(Math.abs(bounds!.y + bounds!.height - 844)).toBeLessThanOrEqual(2);
    await expect(dialog).toHaveCSS("animation-duration", "0s");
    await expect(picker).toBeFocused();
    await page.screenshot({ path: resolve(output, "mobile-dark.png") });
    await picker.press("Enter");
    await expect(page.getByRole("option", { name: /团队专用/ })).toBeVisible();
    await page.screenshot({ path: resolve(output, "mobile-models-dark.png") });
    await page.getByRole("option", { name: /GPT Image 2.6 Sunburst/ }).click();
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    await chooseAntSelect(dialog.getByRole("combobox", { name: "输出格式", exact: true }), "WebP");
    await dialog.getByLabel("输出压缩质量", { exact: true }).fill("85");
    const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth || document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    const complete = dialog.getByRole("button", { name: /^完\s*成$/ });
    const close = dialog.getByRole("button", { name: "关闭模型设置", exact: true });
    await complete.focus();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(complete).toBeFocused();
    for (let index = 0; index < 10; index++) {
        await page.keyboard.press("Tab");
        await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement) ? "inside" : document.activeElement?.outerHTML.slice(0, 500))).toBe("inside");
    }
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    const config = JSON.parse(await page.getByTestId("settings-state").textContent() || "{}");
    expect(JSON.parse(config.imageOptions)).toMatchObject({ output_format: "webp", output_compression: "85" });
});

test("exact pixels keep resolution inactive and backend-assigned models stay locked", async ({ page }) => {
    const { dialog, picker } = await openDialog(page, "?bound=1");
    await expect(picker).toBeDisabled();
    await expect(picker).toContainText("后台指定");
    await dialog.locator("summary", { hasText: "自定义像素" }).click();
    await dialog.getByLabel("自定义宽度", { exact: true }).fill("1536");
    await dialog.getByLabel("自定义宽度", { exact: true }).press("Tab");
    await expect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("status")).toContainText("精确像素 1536 × 1024 优先");
    await expect(dialog.getByRole("combobox", { name: "图片质量", exact: true })).toBeEnabled();
});
