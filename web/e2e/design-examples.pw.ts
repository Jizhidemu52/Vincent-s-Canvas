import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { moduleDefinitions } from "../../shared/feature-catalog";
import { designExampleForLocation, designExampleForScene } from "../src/lib/design-examples";

const scenes = ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft"];
const routes = ["/image", ...["detail-enhance", "image-edit", "angle-control", "seamless-stitch", "midjourney-blend"].map(tool => `/image?tool=${tool}`), "/video", "/chat", "/creative", "/assets", "/prompts", "/my-prompts", "/design-library", "/reference-import", "/creative/pattern-placement", "/creative/pattern-repeat", "/creative/series-recipe", ...scenes.map(scene => `/creative/${scene}`)];
const OWNER = "00000000-0000-4000-8000-000000000099";
const detail = (page: Page) => page.getByRole("dialog", { name: "图文操作案例", exact: true });

async function exampleFixture(context: BrowserContext) {
    const writes: string[] = [];
    context.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/") && !path.startsWith("/api/usage") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${path}`);
    });
    await context.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: true } }));
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 24 } }));
    await context.route("**/api/design-library?*", route => route.fulfill({ json: { code: 0, data: { items: [], total: 0, page: 1, pageSize: 24 }, msg: "ok" } }));
    return writes;
}

for (const href of routes) {
    test(`route example is explicit, illustrated and read-only: ${href}`, async ({ page, context, api }) => {
        const writes = await exampleFixture(context);
        const url = new URL(href, "http://example.test"), scene = scenes.find(id => url.pathname === `/creative/${id}`);
        const example = scene ? designExampleForScene(scene) : designExampleForLocation(url.pathname, url.search);
        expect(example, `catalog for ${href}`).toBeTruthy();
        await page.goto(href);
        if (scene) {
            await expect(page.getByTestId("feature-example")).toHaveCount(0);
            await expect(page.getByRole("button", { name: "功能示例", exact: true })).toHaveAttribute("aria-pressed", "true");
        } else {
            const banner = page.getByTestId("feature-example");
            await expect(banner).toHaveAttribute("data-example-id", example!.id);
            await expect(detail(page)).toHaveCount(0);
            await banner.getByRole("button", { name: "收起操作案例", exact: true }).click();
            await expect(banner.getByRole("button", { name: /^展开操作案例/ })).toBeVisible();
            await banner.getByRole("button", { name: /^展开操作案例/ }).click();
            await banner.getByRole("button", { name: "查看操作案例", exact: true }).click();
            await expect(detail(page)).toBeInViewport({ ratio: 0.99 });
            await expect(page.locator(".ant-drawer-mask")).toHaveCount(0);
        }
        const article = page.getByTestId("design-example-article");
        await expect(article).toHaveAttribute("data-example-id", example!.id);
        await expect(article.getByRole("heading", { name: example!.title, exact: true })).toBeVisible();
        await expect(article).toContainText("不是你的生成记录");
        await expect(article).toContainText(example!.cost);
        await expect(article).toContainText(example!.limitation);
        for (const image of await article.locator("img").all()) {
            await image.scrollIntoViewIfNeeded();
            await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
        }
        expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0); expect(writes).toEqual([]);
    });
}

test("copy and download never fill a real draft or create generation history; existing records remain byte-equivalent", async ({ page, context, api }) => {
    const writes = await exampleFixture(context);
    await page.goto("/image");
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await expect(prompt).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "画布已同步" })).toBeVisible();
    await prompt.fill("我的未提交设计草稿，不应被操作案例覆盖");
    await page.evaluate(async ({ owner, sceneIds }) => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { createSceneForm } = await import("/src/pages/creative/scene-form-model.ts");
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        await createWorkspaceStorage("image_generation_logs").setItem("existing-image", { id: "existing-image", ownerId: owner, tool: "image-generation", title: "已有图片任务", prompt: "保留原文", createdAt: 1700000000000, images: [], references: [], status: "成功" });
        await createWorkspaceStorage("video_generation_logs").setItem("existing-video", { id: "existing-video", title: "已有视频任务", prompt: "原视频要求", createdAt: 1700000000000, status: "成功" });
        const sceneStorage = createWorkspaceStorage("creative_scene_workspaces");
        for (const sceneId of sceneIds) await sceneStorage.setItem(`history-index:${owner}:${sceneId}`, { version: 1, entries: sceneId === "text-to-style" ? [{ id: "existing-scene", ownerId: owner, sceneId, createdAt: 1700000000000, successCount: 0, failCount: 0, hasSelection: false, unresolvedCount: 0 }] : [] });
        await sceneStorage.setItem(`history-record:${owner}:text-to-style:existing-scene`, { id: "existing-scene", ownerId: owner, sceneId: "text-to-style", createdAt: 1700000000000, prompt: "原创意要求", form: createSceneForm("text-to-style"), config: { model: "", imageModel: "", size: "auto", quality: "medium", count: "1" }, referenceImages: {}, results: [], images: [], durationMs: 0, successCount: 0, failCount: 0 });
        await chatSessionStorage.save(`wireless-canvas:llm-chat:${owner}`, [{ id: "existing-chat", title: "已有对话", messages: [{ id: "existing-message", role: "user", content: "原聊天内容", createdAt: "2023-11-14T22:13:20.000Z" }], updatedAt: "2023-11-14T22:13:20.000Z" }]);
    }, { owner: OWNER, sceneIds: scenes });
    const snapshot = async () => page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const result: Record<string, unknown> = {};
        for (const name of ["image_generation_logs", "video_generation_logs", "creative_scene_workspaces", "app_state"]) {
            const items: Array<[string, unknown]> = [];
            await createWorkspaceStorage(name).iterate((value: unknown, key: string) => { if (name !== "creative_scene_workspaces" || key.startsWith("history-")) items.push([key, value]); });
            result[name] = items.sort(([a], [b]) => a.localeCompare(b));
        }
        return JSON.stringify(result);
    });
    const before = await snapshot();
    await page.getByTestId("feature-example").getByRole("button", { name: "查看操作案例", exact: true }).click();
    await expect(detail(page)).toBeInViewport({ ratio: 0.99 });
    await detail(page).getByRole("button", { name: "复制示例要求", exact: true }).click();
    await expect(page.getByText("示例要求已复制；请检查后手动粘贴", { exact: true })).toBeVisible();
    const material = designExampleForLocation("/image")!.media[0];
    const downloadEvent = page.waitForEvent("download");
    await detail(page).getByRole("link", { name: `下载${material.label}`, exact: true }).first().click();
    const downloaded = await downloadEvent;
    expect(await readFile((await downloaded.path())!)).toEqual(await readFile(resolve(import.meta.dirname, "../public", material.src.replace(/^\//, ""))));
    await detail(page).getByRole("button", { name: "关闭", exact: true }).click();
    await expect(prompt).toHaveValue("我的未提交设计草稿，不应被操作案例覆盖");
    for (const href of ["/video", "/chat", ...scenes.map(id => `/creative/${id}`)]) {
        await page.goto(href);
        await expect(page.getByTestId(href.startsWith("/creative/") ? "design-example-article" : "feature-example")).toBeVisible();
        if (href === "/creative/text-to-style") {
            const description = page.getByRole("textbox", { name: "款式描述", exact: true });
            await description.fill("保留这条真实草稿，不能被案例或复制操作改写");
            await expect(page.getByRole("button", { name: /生成款式/ })).toBeEnabled();
            const article = page.getByTestId("design-example-article");
            await article.getByRole("button", { name: "复制示例要求", exact: true }).focus();
            await page.keyboard.press("Control+Enter");
            await article.getByRole("link", { name: /^下载/ }).first().focus();
            await page.keyboard.press("Meta+Enter");
            await expect(page.getByRole("button", { name: "功能示例", exact: true })).toHaveAttribute("aria-pressed", "true");
            await expect(description).toHaveValue("保留这条真实草稿，不能被案例或复制操作改写");
        }
    }
    await page.getByRole("button", { name: "最近任务", exact: true }).click();
    await expect(page.getByText("还没有生成记录", { exact: true })).toBeVisible();
    expect(await snapshot()).toBe(before);
    expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0); expect(writes).toEqual([]);
});

test("blocked modules do not reveal examples and canvas/team remain untouched", async ({ page, context, api }) => {
    const writes = await exampleFixture(context);
    const blocked = new Set(["image", "creative-text-to-style"]);
    await context.route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: !blocked.has(item.moduleKey) })) } }));
    for (const href of ["/image", "/creative/text-to-style"]) {
        await page.goto(href); await expect(page.getByRole("heading", { name: "此功能暂未开放", exact: true })).toBeVisible();
        await expect(page.getByTestId("feature-example")).toHaveCount(0); await expect(page.getByTestId("design-example-article")).toHaveCount(0);
    }
    for (const href of ["/canvas", "/team"]) {
        await page.goto(href); await expect(page.getByTestId("feature-example")).toHaveCount(0); await expect(page.getByTestId("design-example-article")).toHaveCount(0);
    }
    expect(api.submissions).toHaveLength(0); expect(writes).toEqual([]);
});

test("examples remain readable in light, dark and narrow layouts without covering the editing controls", async ({ page, context, api }, info) => {
    const writes = await exampleFixture(context);
    await page.goto("/image");
    const banner = page.getByTestId("feature-example"), prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await expect(banner).toBeVisible(); await expect(prompt).toBeVisible();
    await page.screenshot({ path: info.outputPath("image-example-desktop-light.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).first().click();
    await expect(page.locator("html")).toHaveClass(/dark/); await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await page.screenshot({ path: info.outputPath("image-example-desktop-dark.png"), fullPage: true, animations: "disabled" });
    await banner.getByRole("button", { name: "查看操作案例", exact: true }).click();
    await expect(detail(page)).toBeInViewport({ ratio: 0.99 });
    await page.screenshot({ path: info.outputPath("article-desktop-dark.png"), fullPage: true, animations: "disabled" });
    await detail(page).getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(banner).toBeVisible();
    expect(await banner.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("image-example-mobile-dark.png"), fullPage: true, animations: "disabled" });
    await banner.getByRole("button", { name: "查看操作案例", exact: true }).click();
    await expect(detail(page)).toBeInViewport({ ratio: 0.99 });
    expect(await detail(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("article-mobile-dark.png"), fullPage: true, animations: "disabled" });
    await detail(page).getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "功能模块", exact: true });
    await menu.getByRole("button", { name: "切换到浅色主题", exact: true }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await menu.getByRole("button", { name: "关闭", exact: true }).click(); await expect(menu).toBeHidden();
    await page.goto("/creative/garment-colorway");
    const article = page.getByTestId("design-example-article");
    for (const image of await article.locator("img").all()) {
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
        await image.evaluate((element: HTMLImageElement) => element.decode());
    }
    await article.evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: info.outputPath("creative-example-mobile-light.png"), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(api.submissions).toHaveLength(0); expect(writes).toEqual([]);
});
