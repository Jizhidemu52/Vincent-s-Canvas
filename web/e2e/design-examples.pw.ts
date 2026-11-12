import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { moduleDefinitions } from "../../shared/feature-catalog";
import { designExampleForLocation, designExampleForScene } from "../src/lib/design-examples";

const scenes = ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft"];
const routes = ["/image", ...["image-edit", "midjourney-blend"].map(tool => `/image?tool=${tool}`), "/video", "/chat", "/assets", "/prompts", "/my-prompts", "/design-library", "/reference-import", "/creative/pattern-placement", "/creative/pattern-repeat", ...scenes.map(scene => `/creative/${scene}`)];
const record = (page: Page) => page.locator('[data-testid="practice-example-record"]:visible');
const article = (page: Page) => page.locator('[data-testid="design-example-article"]:visible');
const videoExampleSource = "/design-examples/model-natural-showcase.mp4";
const videoExampleDownload = "/design-examples/model-natural-showcase-original.mp4";
const videoExamplePoster = "/design-examples/model-natural-source.webp";

async function readVideoExampleAssets() {
    // Require the actual delivered assets; missing media must fail, never skip or use a substitute video.
    const [video, poster, original] = await Promise.all([videoExampleSource, videoExamplePoster, videoExampleDownload].map(src => readFile(resolve(import.meta.dirname, "../public", src.slice(1)))));
    expect(video.length, "The real case video must not be empty").toBeGreaterThan(32);
    expect(video.subarray(4, 8).toString("ascii"), "The case must be an MP4 file").toBe("ftyp");
    expect(poster.length, "The real source/poster must not be empty").toBeGreaterThan(0);
    expect(original.subarray(4, 8).toString("ascii")).toBe("ftyp");
    return original;
}

async function savedExampleHistory(page: Page) {
    return page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return JSON.stringify(await Promise.all(["image_generation_logs", "video_generation_logs"].map(async name => {
            const entries: Array<[string, unknown]> = [];
            await createWorkspaceStorage(name).iterate((value, key) => { entries.push([key, value]); });
            return entries.sort(([left], [right]) => left.localeCompare(right));
        })));
    });
}

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
    test(`own module example appears in history or saved items, not a global tutorial: ${href}`, async ({ page, context, api }) => {
        const writes = await exampleFixture(context);
        const url = new URL(href, "http://example.test"), scene = scenes.find(id => url.pathname === `/creative/${id}`);
        const example = scene ? designExampleForScene(scene) : designExampleForLocation(url.pathname, url.search);
        expect(example, `catalog for ${href}`).toBeTruthy();
        await page.goto(href);
        if (["/image", "/video"].includes(url.pathname)) await page.getByRole("tab", { name: /^历史记录/ }).click();
        await expect(page.getByTestId("feature-example")).toHaveCount(0);
        await expect(record(page)).toHaveCount(1);
        await expect(record(page)).toHaveAttribute("data-example-id", example!.id);
        const toggle = record(page).getByTestId("practice-example-toggle");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.click();
        await expect(article(page)).toHaveAttribute("data-example-id", example!.id);
        await expect(article(page).getByRole("heading", { name: example!.title, exact: true })).toBeVisible();
        await expect(article(page)).toContainText(example!.purpose);
        await expect(article(page)).toContainText(`入口：${example!.location}`);
        await expect(article(page).locator("dt")).toHaveText(["输入", "操作", "结果"]);
        await expect(article(page).locator("dd")).toHaveText(example!.steps.map(step => step.detail));
        await expect(article(page)).not.toContainText("费用与执行");
        await expect(article(page)).not.toContainText("使用边界");
        await expect(article(page).locator("pre, details, footer")).toHaveCount(0);
        for (const image of await article(page).locator("img").all()) {
            await image.scrollIntoViewIfNeeded();
            await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
        }
        await toggle.click();
        await expect(article(page)).toHaveCount(0);
        expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0); expect(writes).toEqual([]);
    });
}

test("copy and download preserve the real draft and saved records, without any generation submission", async ({ page, context, api }) => {
    const writes = await exampleFixture(context);
    await page.goto("/image");
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await expect(prompt).toBeVisible();
    await page.getByRole("tab", { name: /^历史记录/ }).click();
    await expect(record(page)).toBeVisible();
    await prompt.fill("我的未提交设计草稿，不应被操作案例覆盖");
    await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        await createWorkspaceStorage("image_generation_logs").setItem("existing-image", { id: "existing-image", ownerId: "00000000-0000-4000-8000-000000000099", tool: "image-generation", title: "已有图片任务", prompt: "保留原文", createdAt: 1700000000000, images: [], references: [], status: "成功" });
        await createWorkspaceStorage("video_generation_logs").setItem("existing-video", { id: "existing-video", title: "已有视频任务", prompt: "原视频要求", createdAt: 1700000000000, status: "成功" });
    });
    const snapshot = () => page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return JSON.stringify(await Promise.all([
            createWorkspaceStorage("image_generation_logs").getItem("existing-image"),
            createWorkspaceStorage("video_generation_logs").getItem("existing-video"),
        ]));
    });
    const before = await snapshot();
    await record(page).getByTestId("practice-example-toggle").click();
    await article(page).getByRole("button", { name: "复制示例要求", exact: true }).click();
    await expect(page.getByText("示例要求已复制", { exact: true })).toBeVisible();
    const material = designExampleForLocation("/image")!.media[0];
    const downloadEvent = page.waitForEvent("download");
    await article(page).getByRole("link", { name: `下载${material.label}`, exact: true }).first().click();
    const downloaded = await downloadEvent;
    expect(await readFile((await downloaded.path())!)).toEqual(await readFile(resolve(import.meta.dirname, "../public", material.src.replace(/^\//, ""))));
    await article(page).getByRole("button", { name: "复制示例要求", exact: true }).focus();
    await page.keyboard.press("Control+Enter");
    await article(page).getByRole("link", { name: /^下载/ }).first().focus();
    await page.keyboard.press("Meta+Enter");
    await record(page).getByTestId("practice-example-toggle").click();
    await expect(prompt).toHaveValue("我的未提交设计草稿，不应被操作案例覆盖");
    for (const href of ["/video", "/chat", "/creative/text-to-style"]) {
        await page.goto(href);
        if (href === "/video") await page.getByRole("tab", { name: "历史记录", exact: true }).click();
        await expect(record(page)).toBeVisible();
        await record(page).getByTestId("practice-example-toggle").click();
        await expect(article(page)).toBeVisible();
    }
    expect(await snapshot()).toBe(before);
    expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0); expect(writes).toEqual([]);
});

test("native MP4 video example loads only when expanded, plays at 1x manually, unloads on collapse and downloads unchanged", async ({ page, context, api }) => {
    const sourceBytes = await readVideoExampleAssets();
    const writes = await exampleFixture(context);
    const videoRequests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname === videoExampleSource) videoRequests.push(request.url()); });
    await page.goto("/video");
    const prompt = page.getByRole("textbox", { name: "视频提示词", exact: true });
    await page.getByRole("tab", { name: "历史记录", exact: true }).click();
    await expect(record(page)).toBeVisible();
    await prompt.fill("我的未提交视频要求，案例播放与下载不能覆盖");
    await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        await createWorkspaceStorage("video_generation_logs").setItem("existing-native-example-video", { id: "existing-native-example-video", title: "已有视频记录", prompt: "保留原视频要求", createdAt: 1700000000000, status: "成功" });
    });
    const historyBefore = await savedExampleHistory(page);
    const toggle = record(page).getByTestId("practice-example-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(record(page).locator("video")).toHaveCount(0);
    await expect(toggle.locator("img")).toHaveCount(2);
    for (const poster of await toggle.locator("img").all()) {
        await expect(poster).toHaveAttribute("src", videoExamplePoster);
        await poster.scrollIntoViewIfNeeded();
        await expect.poll(() => poster.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    }
    // Give lazy previews a complete render opportunity before asserting that no video was fetched.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(videoRequests, "Collapsed examples may request only their poster, not the MP4").toEqual([]);

    await toggle.click();
    await expect(article(page).getByRole("heading", { name: "视频生成 · 模特自然展示毛衫", exact: true })).toBeVisible();
    const video = article(page).locator("video");
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("src", videoExampleSource);
    await expect(video).toHaveAttribute("poster", videoExamplePoster);
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).toHaveAttribute("playsinline", "");
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).not.toHaveAttribute("autoplay", "");
    await expect(video).not.toHaveAttribute("loop", "");
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(element.duration) && element.duration > 0 && element.videoWidth > 0 && element.videoHeight > 0)).toBe(true);
    expect(videoRequests.length).toBeGreaterThan(0);
    expect(await video.evaluate((element: HTMLVideoElement) => ({ paused: element.paused, defaultRate: element.defaultPlaybackRate, rate: element.playbackRate, autoplay: element.autoplay, loop: element.loop }))).toEqual({ paused: true, defaultRate: 1, rate: 1, autoplay: false, loop: false });

    // Use the native player's trusted keyboard control, not a scripted play()/pause() call.
    await video.press("Space");
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0)).toBe(true);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await video.press("Space");
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(article(page)).toBeVisible();

    const downloadEvent = page.waitForEvent("download");
    await article(page).locator(`a[href="${videoExampleDownload}"]`).click();
    const downloaded = await downloadEvent;
    expect(downloaded.suggestedFilename()).toBe("model-natural-showcase-original.mp4");
    expect(await downloaded.failure()).toBeNull();
    expect(await readFile((await downloaded.path())!)).toEqual(sourceBytes);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await video.press("Space");
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    const detachedPlayer = await video.elementHandle();
    expect(detachedPlayer).not.toBeNull();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(article(page)).toHaveCount(0);
    await expect(record(page).locator("video")).toHaveCount(0);
    await expect.poll(() => detachedPlayer!.evaluate((element: HTMLVideoElement) => ({ connected: element.isConnected, paused: element.paused }))).toEqual({ connected: false, paused: true });
    await detachedPlayer!.dispose();

    await toggle.click();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true);
    expect(await video.evaluate((element: HTMLVideoElement) => ({ paused: element.paused, time: element.currentTime, defaultRate: element.defaultPlaybackRate, rate: element.playbackRate }))).toEqual({ paused: true, time: 0, defaultRate: 1, rate: 1 });
    await toggle.click();
    await expect(prompt).toHaveValue("我的未提交视频要求，案例播放与下载不能覆盖");
    expect(await savedExampleHistory(page)).toBe(historyBefore);
    expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0); expect(writes).toEqual([]);
});

for (const viewport of [{ width: 1800, height: 1200 }, { width: 390, height: 844 }]) {
    test(`native MP4 video example fits the ${viewport.width}px layout without changing history or submitting generation`, async ({ page, context, api }, info) => {
        await readVideoExampleAssets();
        const writes = await exampleFixture(context);
        await page.setViewportSize(viewport);
        await page.goto("/video");
        await expect(page.getByRole("textbox", { name: "视频提示词", exact: true })).toBeVisible();
        const historyBefore = await savedExampleHistory(page);
        if (viewport.width === 390) await page.getByRole("button", { name: "记录", exact: true }).click();
        else await page.getByRole("tab", { name: "历史记录", exact: true }).click();
        await expect(record(page)).toBeVisible();
        await record(page).getByTestId("practice-example-toggle").click();
        const video = article(page).locator("video");
        await expect(video).toBeVisible();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true);
        await video.scrollIntoViewIfNeeded();
        expect(await record(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        expect(await article(page).evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return element.scrollWidth <= element.clientWidth + 1 && [...element.querySelectorAll("figure, video, img, a")].every(child => {
                const childBounds = child.getBoundingClientRect();
                return childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1;
            });
        })).toBe(true);
        const playerBounds = (await video.boundingBox())!;
        expect(playerBounds.x).toBeGreaterThanOrEqual(0);
        expect(playerBounds.x + playerBounds.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath(`native-video-example-${viewport.width}px.png`), fullPage: true, animations: "disabled" });
        await record(page).getByTestId("practice-example-toggle").click();
        await expect(record(page).locator("video")).toHaveCount(0);
        expect(await savedExampleHistory(page)).toBe(historyBefore);
        expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0); expect(writes).toEqual([]);
    });
}

test("blocked modules reveal no examples, and the catalog has no unrelated mixed example", async ({ page, context, api }) => {
    const writes = await exampleFixture(context);
    const blocked = new Set(["image", "creative-text-to-style"]);
    await context.route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: !blocked.has(item.moduleKey) })) } }));
    for (const href of ["/image", "/creative/text-to-style"]) {
        await page.goto(href);
        await expect(page.getByRole("heading", { name: "此功能暂未开放", exact: true })).toBeVisible();
        await expect(record(page)).toHaveCount(0);
    }
    for (const href of ["/canvas", "/team", "/creative"]) {
        await page.goto(href);
        await expect(record(page)).toHaveCount(0);
        await expect(page.getByTestId("feature-example")).toHaveCount(0);
    }
    expect(api.submissions).toHaveLength(0); expect(writes).toEqual([]);
});

test("history examples fit desktop, dark and mobile layouts without covering the editing controls", async ({ page, context, api }, info) => {
    const writes = await exampleFixture(context);
    await page.goto("/image");
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await page.getByRole("tab", { name: /^历史记录/ }).click();
    await expect(record(page)).toBeVisible(); await expect(prompt).toBeVisible();
    await record(page).getByTestId("practice-example-toggle").click();
    await expect(article(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath("history-example-desktop-light.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).first().click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await page.screenshot({ path: info.outputPath("history-example-desktop-dark.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: /^历史记录/ }).click();
    await expect(record(page)).toBeVisible();
    await expect(record(page).getByTestId("practice-example-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(article(page)).toBeVisible();
    expect(await record(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("history-example-mobile-dark.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(record(page)).toHaveCount(0);
    await page.goto("/creative/garment-colorway");
    await record(page).getByTestId("practice-example-toggle").click();
    for (const image of await article(page).locator("img").all()) {
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
    }
    await article(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("creative-example-mobile-dark.png"), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(api.submissions).toHaveLength(0); expect(writes).toEqual([]);
});
