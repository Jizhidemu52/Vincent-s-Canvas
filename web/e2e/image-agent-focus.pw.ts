import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/image-agent-focus.fixture.tsx"></script></body></html>`;
test.beforeEach(async ({ page }) => {
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (url.pathname === "/__focus") return route.fulfill({ contentType: "text/html", body: fixture });
        if (url.pathname.endsWith("/thumb")) return route.fulfill({ contentType: "image/png", path: resolve(import.meta.dirname, "media/reference.png") });
        if (url.pathname.startsWith("/api/")) return route.abort();
        return route.continue();
    });
    await page.goto("/__focus");
});

test("persistent explicit selection supports versions, original, previous and new creation without any provider calls", async ({ page }) => {
    const focus = page.locator("[data-image-agent-focus]");
    await expect(focus).toHaveAttribute("data-focus-id", "v3");
    await expect(focus.getByText("底图已锁定", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择图片", exact: true }).click();
    await page.getByRole("button", { name: "选择图片: 图1 · V2", exact: true }).click();
    await expect(focus).toHaveAttribute("data-focus-id", "v2");
    await expect(page.getByRole("button", { name: "选择图片: 图1 · V2", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "remount", exact: true }).click();
    await page.getByRole("button", { name: "remount", exact: true }).click();
    await expect(focus).toHaveAttribute("data-focus-id", "v2");
    await page.getByRole("button", { name: "原图", exact: true }).click();
    await expect(focus).toHaveAttribute("data-focus-id", "original");
    await expect(page.getByRole("button", { name: "原图", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "新创作", exact: true }).click();
    await expect(page.getByTestId("selection")).toHaveText("new");
    await expect(focus.getByText("不沿用当前图片", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择图片", exact: true }).click();
    await page.getByRole("button", { name: "选择图片: 图2", exact: true }).click();
    await expect(focus).toHaveAttribute("data-focus-id", "v3");
    await page.getByRole("button", { name: "上一版", exact: true }).click();
    await expect(page.getByTestId("selection")).toHaveText("v2");
});

test("keyboard can expand and select; unavailable ancestors and busy state never offer usable fake actions", async ({ page }) => {
    const chooser = page.getByRole("button", { name: "选择图片", exact: true });
    await chooser.focus(); await page.keyboard.press("Enter"); await expect(chooser).toHaveAttribute("aria-expanded", "true");
    const version = page.getByRole("button", { name: "选择图片: 图1 · V2", exact: true });
    await version.focus(); await page.keyboard.press("Space");
    await expect(page.getByTestId("selection")).toHaveText("v2");
    await page.keyboard.press("Escape"); await expect(chooser).toHaveAttribute("aria-expanded", "false"); await expect(chooser).toBeFocused();
    await page.getByRole("button", { name: "remove original", exact: true }).click();
    await expect(page.getByRole("button", { name: "原图", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "上一版", exact: true })).toHaveCount(0);
    await chooser.click();
    await expect(page.getByRole("button", { name: "选择图片: 图3", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "busy", exact: true }).click();
    await expect(page.getByRole("button", { name: "新创作", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /选择图片: 图2/ })).toBeDisabled();
});

test("notes and narrow panels remain readable in both themes and languages", async ({ page }, info) => {
    const panel = page.getByTestId("panel");
    await page.getByText("作品说明", { exact: true }).click();
    await expect(page.getByText("记录创作要求，不代表画面已经验收。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "width", exact: true }).click();
    await page.getByRole("button", { name: "选择图片", exact: true }).click();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("focus-narrow-light-zh.png") });
    await page.getByRole("button", { name: "theme", exact: true }).click();
    await expect(page.locator("[data-image-agent-focus]")).toHaveCSS("color", "rgb(163, 163, 163)");
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(page.getByRole("region", { name: "Current work", exact: true })).toBeVisible();
    await expect(page.getByText("Base image locked", { exact: true })).toBeVisible();
    await expect(page.getByText("Work notes", { exact: true })).toBeVisible();
    await expect(page.getByText("花边宽度不变 · 原版比例不变", { exact: false })).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("focus-narrow-dark-en.png") });
    await page.getByRole("button", { name: "clear focus", exact: true }).click();
    await expect(page.getByText("Start without the current image", { exact: true })).toBeVisible();
    await expect(page.getByText("Work notes", { exact: true })).toHaveCount(0);
});
