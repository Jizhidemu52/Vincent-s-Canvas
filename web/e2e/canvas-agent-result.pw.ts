import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-agent-result.fixture.tsx"></script></body></html>`;
test.beforeEach(async ({ page }) => {
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (url.pathname === "/__results") return route.fulfill({ contentType: "text/html", body: fixture });
        if (url.pathname === "/result.png") return route.fulfill({ contentType: "image/png", path: resolve(import.meta.dirname, "media/reference.png") });
        if (url.pathname.startsWith("/api/")) return route.abort();
        return route.continue();
    });
    await page.goto("/__results");
    await expect(page.getByTestId("canvas-agent-image-result")).toBeVisible();
});

test("desktop result actions reveal on hover and keyboard focus while version and current remain visible", async ({ page }) => {
    const result = page.getByTestId("canvas-agent-image-result"), actions = page.getByTestId("canvas-agent-image-actions");
    await expect(actions).toHaveCSS("opacity", "0");
    await expect(result.getByText("图2 · V3", { exact: true })).toBeVisible();
    await expect(page.getByTestId("canvas-agent-image-current")).toBeVisible();
    await expect(page.getByTestId("canvas-node-agent-version")).toHaveText("V3");
    await result.hover(); await expect(actions).toHaveCSS("opacity", "1");
    await page.mouse.move(800, 800); await expect(actions).toHaveCSS("opacity", "0");
    await result.getByRole("button", { name: "选择 图2 作为编辑目标", exact: true }).focus();
    await expect(actions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(result.getByRole("button", { name: "在此基础上改", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("last-action")).toHaveText("edit:image-v3");
    await result.getByRole("button", { name: "更多图片操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "圈选修改", exact: true }).click();
    await expect(page.getByTestId("last-action")).toHaveText("mask:image-v3");
});

test("selection, busy state and narrow light/dark cards preserve target and operable secondary actions", async ({ page }, info) => {
    await page.getByRole("button", { name: "clear selection", exact: true }).click();
    await expect(page.getByTestId("canvas-agent-image-current")).toHaveCount(0);
    const result = page.getByTestId("canvas-agent-image-result");
    await result.getByRole("button", { name: "选择 图2 作为编辑目标", exact: true }).click();
    await expect(page.getByTestId("canvas-agent-image-current")).toBeVisible();
    await page.getByRole("button", { name: "busy", exact: true }).click(); await result.hover();
    await expect(result.getByRole("button", { name: "在此基础上改", exact: true })).toBeDisabled();
    await expect(result.getByRole("button", { name: "作为参考", exact: true })).toBeDisabled();
    await result.getByRole("button", { name: "更多图片操作", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "圈选修改", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "busy", exact: true }).click();
    await page.getByRole("button", { name: "narrow", exact: true }).click();
    for (const theme of ["light", "dark"]) {
        if (theme === "dark") await page.getByRole("button", { name: "theme", exact: true }).click();
        await result.hover();
        const bounds = await result.boundingBox(), actions = await page.getByTestId("canvas-agent-image-actions").boundingBox();
        expect(bounds && actions).toBeTruthy();
        expect(actions!.x).toBeGreaterThanOrEqual(bounds!.x); expect(actions!.x + actions!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
        expect(await result.evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true);
        await page.screenshot({ path: info.outputPath(`result-${theme}-narrow.png`) });
    }
    await result.getByRole("button", { name: "更多图片操作", exact: true }).click();
    await page.getByRole("button", { name: "选此图生成视频", exact: true }).click();
    await expect(page.getByTestId("last-action")).toHaveText("video:attachment");
});

test.describe("touch device", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    test("keeps action controls visible without hover and sends the selected image identity", async ({ page }) => {
        await expect(page.getByTestId("canvas-agent-image-actions")).toHaveCSS("opacity", "1");
        await page.getByRole("button", { name: "作为参考", exact: true }).tap();
        await expect(page.getByTestId("last-action")).toHaveText("reference:image-v3");
        await page.getByRole("button", { name: "更多图片操作", exact: true }).tap();
        await page.getByRole("menuitem", { name: "圈选修改", exact: true }).tap();
        await expect(page.getByTestId("last-action")).toHaveText("mask:image-v3");
    });
});
