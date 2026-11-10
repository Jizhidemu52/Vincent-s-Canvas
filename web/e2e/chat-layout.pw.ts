import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";

const imageData = `data:image/png;base64,${readFileSync(new URL("../../labs/design-workbench/assets/garment.png", import.meta.url)).toString("base64")}`;
const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/chat-layout.fixture.tsx"></script></body></html>`;

test("real chat keeps a readable column, original image ratio and stable composer at desktop and narrow widths", async ({ page, api }, info) => {
    await page.route("**/api/models", route => route.fulfill({ json: {
        models: [{ id: "layout-chat", modelId: "gpt-6-astra", name: "布局对话模型", capabilities: ["chat", "vision"] }, { id: "layout-image", modelId: "gpt-image-2", name: "布局出图模型", capabilities: ["generate", "edit"] }],
        prices: [], tools: [{ toolKey: "gpt-chat", modelConfigId: "layout-chat", enabled: true }, { toolKey: "gpt-chat-image", modelConfigId: "layout-image", enabled: true }],
    } }));
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    await page.evaluate(async imageData => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        const messages = Array.from({ length: 8 }, (_, index) => ({ id: `history-${index}`, role: index % 2 ? "assistant" as const : "user" as const, content: index % 2 ? "我们先保留版型与纹理，只修改确认的颜色。\n\n".repeat(3) + (index === 1 ? `长文件名：${"reference_image_original_".repeat(25)}` : "") : "请保留服装版型，仅调整配色。", createdAt: "2026-01-01" }));
        await chatSessionStorage.save(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, [{ id: "layout-session", title: "版型配色", updatedAt: "2026-01-01", messages: [...messages,
            { id: "result", role: "assistant", content: "已按确认的方案完成配色。原有轮廓、接缝与背景仍需要核对。\n\n**局部修改**可以先涂选，再描述要求。", generatedImages: [{ id: "garment", dataUrl: imageData }], createdAt: "2026-01-01" },
        ] }]);
    }, imageData);
    await page.reload();
    const list = page.getByTestId("chat-message-list"), dock = page.getByTestId("chat-composer-dock"), composer = page.getByRole("textbox", { name: "对话内容", exact: true });
    const result = page.locator('[data-message-id="result"]');
    await expect(result.locator("img")).toBeVisible();
    await expect.poll(() => list.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await expect(result.getByText("只改局部时，先涂选；选区外保留原图", { exact: true })).toBeVisible();
    const historyCount = await page.locator("[data-message-id]").count();
    for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        if (width < 768) {
            const close = page.locator("aside").getByRole("button", { name: "收起会话", exact: true });
            if (await close.isVisible()) await close.click();
            await expect.poll(() => page.locator("aside[aria-hidden]").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(1);
        }
        await composer.fill("");
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        expect((await result.boundingBox())!.width).toBeLessThanOrEqual(768);
        expect((await result.locator("img").boundingBox())!.width).toBeLessThanOrEqual(576);
        await expect(result.locator("img")).toHaveCSS("object-fit", "contain");
        expect((await dock.boundingBox())!.y + (await dock.boundingBox())!.height).toBeLessThanOrEqual(width === 1440 ? 1000 : 844);
        await page.screenshot({ path: info.outputPath(`chat-${width}.png`), animations: "disabled" });
        await composer.fill("长输入框内容不能把消息区挤走。\n".repeat(40));
        expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(176);
        expect((await list.boundingBox())!.height).toBeGreaterThan(150);
        expect(await composer.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        expect(await page.locator("[data-message-id]").count()).toBe(historyCount);
    }
    await composer.fill("");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.screenshot({ path: info.outputPath("chat-320-dark.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});

test("shared Chat/Canvas follow batches resize work, follows late media and respects upward reading", async ({ page, api }, info) => {
    await page.route("**/__chat-layout", route => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.addInitScript(() => {
        const NativeObserver = ResizeObserver;
        (window as any).__followObservers = 0;
        window.ResizeObserver = class extends NativeObserver {
            constructor(callback: ResizeObserverCallback) { super(callback); (window as any).__followObservers++; }
        };
    });
    await page.goto("/__chat-layout");
    const list = page.getByTestId("fixture-list");
    const bottomGap = () => list.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    await expect.poll(bottomGap).toBeLessThan(2);
    const observerCount = await page.evaluate(() => (window as any).__followObservers);
    for (let index = 0; index < 4; index++) await page.getByRole("button", { name: "stream chunk", exact: true }).click();
    await expect.poll(bottomGap).toBeLessThan(2);
    expect(await page.evaluate(() => (window as any).__followObservers)).toBe(observerCount);
    await page.getByRole("button", { name: "grow media", exact: true }).click();
    await expect.poll(bottomGap).toBeLessThan(2);
    await list.evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await page.getByRole("button", { name: "stream chunk", exact: true }).click();
    await expect(page.getByRole("button", { name: "新消息", exact: true })).toBeVisible();
    expect(await list.evaluate(element => element.scrollTop)).toBe(120);
    await page.getByRole("button", { name: "grow media", exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await list.evaluate(element => element.scrollTop)).toBe(120);
    await page.getByRole("button", { name: "新消息", exact: true }).click();
    await expect.poll(bottomGap).toBeLessThan(2);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("textbox", { name: "对话输入" }).fill("长输入\n".repeat(30));
    expect((await page.getByRole("textbox").boundingBox())!.height).toBeLessThanOrEqual(160);
    expect((await list.boundingBox())!.height).toBeGreaterThan(150);
    await page.screenshot({ path: info.outputPath("canvas-composer-320.png") });
    expect(api.submissions).toHaveLength(0);
});
