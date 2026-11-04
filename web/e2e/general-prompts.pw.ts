import { test, expect } from "./fixtures";
import { generalPromptTemplates } from "../../shared/general-prompt-templates";
import { generalPromptSnapshot } from "../src/pages/prompts/general-prompts";

test("general catalog works without shared APIs, searches full text, copies and saves a personal snapshot", async ({ page, context, api }) => {
    const requests: string[] = [], saved: unknown[] = [];
    await context.route("**/api/prompt-templates**", async route => {
        const request = route.request();
        requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/prompt-templates") {
            saved.push(request.postDataJSON());
            return route.fulfill({ json: { template: { id: "isolated-personal-copy", currentVersionId: "isolated-version" } } });
        }
        return route.fulfill({ status: 503, json: { message: "隔离测试：共享库暂时不可用" } });
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/prompts");
    await expect(page.locator("[data-general-prompt-id]")).toHaveCount(generalPromptTemplates.length);
    expect(requests).toEqual([]);
    const item = generalPromptTemplates[0];
    await page.getByPlaceholder("搜索标题、完整提示词或分类").fill(item.title);
    const card = page.locator(`[data-general-prompt-id="${item.id}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: `查看完整提示词：${item.title}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: item.title, exact: true });
    await expect(drawer.getByText(item.prompt, { exact: true })).toBeVisible();
    for (const source of item.sources) await expect(drawer.getByRole("link", { name: source.title, exact: true })).toHaveAttribute("href", source.url);
    await drawer.getByRole("button", { name: "复制提示词", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(item.prompt);
    await drawer.getByRole("button", { name: "存到我的提示词", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "已存到我的提示词", exact: true })).toBeDisabled();
    expect(saved).toEqual([generalPromptSnapshot(item)]);
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByPlaceholder("搜索标题、完整提示词或分类").fill("完全不存在的提示词条目");
    await expect(page.getByText("没有找到匹配模板", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    await expect(page.locator("[data-general-prompt-id]")).toHaveCount(generalPromptTemplates.length);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
    expect(requests).toEqual(["POST /api/prompt-templates"]);
});

test("each target fills only its prompt without generation", async ({ page, context, api }) => {
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 24 } }));
    for (const target of ["image-generation", "image-edit", "video"] as const) {
        const item = generalPromptTemplates.find(value => value.targetTool === target)!;
        expect(item, `catalog includes ${target}`).toBeTruthy();
        await page.goto("/prompts");
        const card = page.locator(`[data-general-prompt-id="${item.id}"]`);
        await card.getByRole("button", { name: /^填入/ }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(target === "video" ? "/video" : "/image");
        expect(new URL(page.url()).searchParams.get("prompt")).toBe(item.prompt);
        expect(new URL(page.url()).searchParams.get("tool")).toBe(target === "image-edit" ? "image-edit" : null);
        const prompt = target === "video" ? page.locator("textarea").filter({ visible: true }).first() : page.getByRole("textbox", { name: "图像提示词", exact: true });
        await expect(prompt).toHaveValue(item.prompt);
        await page.waitForTimeout(300);
        await expect(prompt).toHaveValue(item.prompt);
    }
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("team and public lists remain separate; catalog and details fit 390px in light and dark", async ({ page, context, api }, info) => {
    api.role = "super_admin";
    const sharedScopes: string[] = [];
    await context.route("**/api/prompt-templates?*", route => {
        const scope = new URL(route.request().url()).searchParams.get("scope")!;
        sharedScopes.push(scope);
        return route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 24 } });
    });
    await context.route("**/api/prompt-templates/review/submissions", route => route.fulfill({ json: { submissions: [] } }));
    await page.goto("/prompts");
    await expect(page.locator("[data-general-prompt-id]")).toHaveCount(generalPromptTemplates.length);
    await page.getByText("团队提示词", { exact: true }).click();
    await expect.poll(() => sharedScopes.includes("team")).toBe(true);
    await expect(page.locator("[data-general-prompt-id]")).toHaveCount(0);
    await page.getByText("公共提示词库", { exact: true }).click();
    await expect.poll(() => sharedScopes.includes("public")).toBe(true);
    await expect(page.getByRole("button", { name: "新建公共模板", exact: true })).toBeVisible();
    await page.getByText("通用提示词", { exact: true }).click();
    await expect(page.getByRole("button", { name: "新建公共模板", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("general-prompts-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const card of await page.locator("[data-general-prompt-id]").all()) expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("general-prompts-mobile.png"), fullPage: true, animations: "disabled" });
    const item = generalPromptTemplates[0];
    await page.locator(`[data-general-prompt-id="${item.id}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("general-prompts-mobile-card.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: `查看完整提示词：${item.title}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: item.title, exact: true });
    await expect(drawer).toBeVisible();
    await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0);
    expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(drawer.getByRole("button", { name: "存到我的提示词", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("general-prompts-mobile-detail.png"), fullPage: true, animations: "disabled" });
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).first().click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("general-prompts-mobile-dark.png"), fullPage: true, animations: "disabled" });
    expect(api.submissions).toEqual([]);
});
