import { test, expect } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const routes = [
    ["home", "/", ".home-page"], ["creative", "/creative", ".creative-page"],
    ["scene", "/creative/text-to-style", ".cs-page"], ["image", "/image", ".image-workbench"],
    ["video", "/video", ".video-workbench"], ["chat", "/chat", "main:has(> .flex)"],
    ["assets", "/assets", ".wb-page[aria-label='素材库']"], ["prompts", "/prompts", "main.wb-page"], ["my-prompts", "/my-prompts", "main.wb-page"],
    ["placement", "/creative/pattern-placement", ".local-design-workbench"],
    ["repeat", "/creative/pattern-repeat", ".local-design-workbench"],
    ["stitch", "/image?tool=seamless-stitch", ".stitch-workbench"],
] as const;

for (const [name, path, selector] of routes) test(`${name}: desktop, mobile and dark visual contract`, async ({ page, api }, info) => {
    await page.context().route("**/api/prompt-templates**", route => route.fulfill({ json: { templates: [], total: 0, submissions: [] } }));
    if (name === "video" || name === "chat") await page.context().route("**/api/models", route => route.fulfill({ json: {
        models: [{ id: "video", modelId: "video", parameterModelId: "doubao-seedance-2.5", name: "隔离视频", capabilities: ["video"] },
            { id: "chat", modelId: "gpt-6-astra", name: "隔离对话", capabilities: ["chat", "vision"] },
            { id: "image", modelId: "gpt-image-2", name: "隔离图片", capabilities: ["generate", "edit"] }],
        tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: tool.toolKey === "gpt-chat" ? "chat" : tool.toolKey.startsWith("video") ? "video" : "image", configurationVersion: 1 })), prices: [],
    } }));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(path);
    const main = page.locator(selector).first();
    await expect(main).toBeVisible();
    await expect(main.locator(".ant-skeleton:visible")).toHaveCount(0);
    if (["placement", "repeat"].includes(name)) await expect(page.locator('[data-workbench-select-control="project"]').getByRole("combobox")).toBeEnabled();
    for (const [variant, width, height, dark] of [["desktop", 1366, 768, false], ["mobile", 390, 844, false], ["dark", 1366, 768, true]] as const) {
        await page.setViewportSize({ width, height });
        if (dark) await page.evaluate(async () => { const { useThemeStore } = await import("/src/stores/use-theme-store.ts"); useThemeStore.getState().setTheme("dark"); });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(main.locator("select:visible")).toHaveCount(0);
        const fontSizes = await main.evaluate(element => {
            const values = new Set<string>();
            const unusual: string[] = [];
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode, parent = node.parentElement;
                if (!parent || !node.textContent?.trim() || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || parent.closest("svg, style, script")) continue;
                const rect = parent.getBoundingClientRect();
                if (rect.width < 1 || rect.height < 1) continue;
                const font = getComputedStyle(parent).fontSize; values.add(font);
                if (!["12px", "13px", "14px", "16px", "20px", "28px"].includes(font)) unusual.push(`${font} ${parent.outerHTML.slice(0, 240)}`);
            }
            return { values: [...values].sort(), unusual };
        });
        await info.attach(`${variant}-fonts`, { body: JSON.stringify(fontSizes), contentType: "application/json" });
        expect(fontSizes.unusual).toEqual([]);
        await page.screenshot({ path: info.outputPath(`${name}-${variant}.png`), animations: "disabled" });
    }
    if (name === "creative") await expect(main.locator(".creative-card h3").first()).toHaveCSS("font-size", "16px");
    if (name === "scene") await expect(main.locator(".cs-form-heading h1")).toHaveCSS("font-size", "28px");
    if (name === "home") {
        await expect(main.getByRole("region", { name: "最近素材", exact: true }).locator(".wb-empty svg")).toHaveCount(1);
        await expect(main.getByRole("region", { name: "收藏的提示词", exact: true }).locator(".wb-empty a")).toHaveAttribute("href", "/my-prompts");
    }
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("empty history shows one meaningful create action and disabled selection explains why", async ({ page, api }) => {
    await page.goto("/image");
    await page.getByRole("tab", { name: "历史记录", exact: false }).click();
    const empty = page.locator(".image-history-panel .wb-empty");
    await page.locator(".image-history-panel").getByRole("button", { name: "全选", exact: true }).hover({ force: true });
    await expect(page.locator(".ant-tooltip:visible")).toHaveText("暂无生成记录");
    await expect(empty.locator("svg")).toHaveCount(2);
    await expect(empty.getByRole("button", { name: "新建任务，继续创作" })).toBeEnabled();
    await empty.getByRole("button", { name: "新建任务，继续创作" }).click();
    await expect(page.locator(".image-result-tabs").getByRole("tab", { name: "本次结果", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(api.submissions).toEqual([]);
});
