import { test, expect, newCanvas } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

for (const surface of ["chat", "canvas"] as const) {
    for (const width of [1440, 390]) {
        test(`${surface} 对话示例 ${width}px 可达且查看不会发送或改动草稿`, async ({ page, context, api }, info) => {
            await page.setViewportSize({ width, height: 900 });
            await context.route("**/api/models", route => route.fulfill({ json: {
                models: [
                    { id: "example-chat", modelId: "example-chat", name: "隔离对话模型", capabilities: ["chat", "vision", "tools"], creditCost: 0, rmbCost: 0 },
                    { id: "example-image", modelId: "gpt-image-2", name: "隔离图片模型", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
                ], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? "example-chat" : "example-image", configurationVersion: 1 })),
            } }));
            await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
            if (surface === "chat") await page.goto("/chat");
            else {
                const id = await newCanvas(page);
                if (width === 390) {
                    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
                    await page.getByRole("menuitem", { name: "打开对话", exact: true }).click();
                } else await page.getByRole("tab", { name: "对话", exact: true }).first().click();
                await expect.poll(() => Boolean(api.document(id))).toBe(true);
            }
            const input = surface === "chat" ? page.getByRole("textbox", { name: /^(对话内容|Message)$/ }) : page.locator(".cw-agent-panel textarea").last();
            await expect(input).toBeEnabled();
            await input.fill("保留我的草稿，不发送，也不替换参考图。");
            const requests: string[] = [];
            page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
            if (surface === "canvas" && width === 390) {
                await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
                await page.getByRole("menuitem", { name: "收起对话", exact: true }).click();
                await expect(page.locator(".cw-agent-panel")).toBeHidden();
                await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
                await page.getByRole("menuitem", { name: "打开对话", exact: true }).click();
                await expect(input).toHaveValue("保留我的草稿，不发送，也不替换参考图。");
            }

            const help = page.getByTestId("conversation-examples"), content = page.getByTestId("conversation-examples-content"), toggle = help.locator("summary");
            await expect(toggle).toHaveText("对话示例");
            await expect(content).toBeHidden();
            expect((await help.boundingBox())!.height).toBeLessThanOrEqual(32);
            await toggle.focus(); await page.keyboard.press("Enter");
            await expect(content).toBeVisible();
            await expect(help).toContainText("方案和图号以当前对话为准");
            await expect(help.locator("dt")).toHaveText(["采用方案", "回上一版", "回原图", "指定图号", "先讨论不出图"]);
            await expect(help).toContainText("采用 B 方案");
            await expect(help).toContainText("以图 3 为基础");
            await help.getByText("先讨论不出图：给我 A、B 两个方向，说说各自的区别。", { exact: true }).click();
            await expect(input).toHaveValue("保留我的草稿，不发送，也不替换参考图。");
            await expect(help.locator("button, input, textarea, select")).toHaveCount(0);
            expect((await help.boundingBox())!.height).toBeLessThanOrEqual(200);
            expect(await help.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
            const bounds = (await help.boundingBox())!;
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
            await content.evaluate(element => { element.scrollTop = 0; });

            if (width === 390) {
                await page.evaluate(async () => (await import("/src/stores/use-theme-store.ts")).useThemeStore.getState().setTheme("dark"));
                await help.screenshot({ path: info.outputPath(`${surface}-390-dark-zh.png`), animations: "disabled" });
                await page.evaluate(async () => (await import("/src/lib/i18n.ts")).setUiLocale("en-US"));
                await expect(toggle).toHaveText("Conversation examples");
                await expect(help).toContainText("Use image 3 from this conversation");
                expect(await help.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            }
            await page.screenshot({ path: info.outputPath(`${surface}-${width}-expanded.png`), animations: "disabled" });
            await toggle.focus(); await page.keyboard.press("Space");
            await expect(content).toBeHidden();
            await toggle.click(); await expect(content).toBeVisible();
            await expect(input).toHaveValue("保留我的草稿，不发送，也不替换参考图。");
            expect(requests).toEqual([]);
            expect(api.submissions).toHaveLength(0);
            expect(api.batchSubmissions).toHaveLength(0);
        });
    }
}
