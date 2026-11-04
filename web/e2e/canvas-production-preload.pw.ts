import { test, expect, type Page } from "@playwright/test";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog";
import type { ApiUser } from "../src/services/api/auth";

const origin = "http://127.0.0.1:5405";
const guest: ApiUser = {
    id: "00000000-0000-4000-8000-000000000098",
    username: "guest-00000000-0000-4000-8000-000000000098",
    displayName: "隔离试用访客",
    email: null,
    employeeNo: null,
    role: "designer",
    status: "active",
    departmentId: null,
    departmentName: null,
    groupId: null,
    groupName: null,
    groupRole: null,
    mustChangePassword: false,
    mfaEnabled: false,
    creditBalance: 0,
    creditLimit: 0,
    monthlyCreditLimit: 0,
    temporaryCreditAdjustment: 0,
    creditPeriodStart: "2026-11-01T00:00:00.000Z",
    creditResetAt: "2026-12-01T00:00:00.000Z",
};
const entries = ["canvas-quick-generate-panel", "canvas-workspace-tools", "canvas-shortcuts-dialog"];
const entryAsset = (path: string, extension: "js" | "css") =>
    entries.some(name => new RegExp(`^/assets/${name}-[\\w-]{8}\\.${extension}$`).test(path));

async function openAndCloseEntries(page: Page) {
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "描述图像", exact: true })).toHaveValue("");
    // Never press Enter, optimize a prompt, or click the generation button.
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await expect(panel).toHaveCount(0);

    await page.getByRole("button", { name: "全部工具", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "全部工具", exact: true });
    await expect(tools).toBeVisible();
    await expect(tools.getByRole("combobox", { name: "搜索工具或工作台", exact: true })).toBeVisible();
    await tools.getByRole("button", { name: "关闭全部工具", exact: true }).click();
    await expect(tools).toBeHidden();

    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "快捷键", exact: true }).click();
    const shortcuts = page.getByRole("dialog", { name: "快捷键与画布操作", exact: true });
    await expect(shortcuts).toBeVisible();
    // Use the explicit close action: the unchanged preload baseline also has
    // a warm-open Escape edge case, outside this dynamic-loading smoke.
    await shortcuts.getByRole("button", { name: "Close", exact: true }).click();
    await expect(shortcuts).toBeHidden();
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeEnabled();
}

test("标准 dist：三个画布动态入口冷加载与同页暖加载均可关闭，JS/CSS 无失败且不写 API", async ({ page, context }) => {
    const errors: string[] = [], blocked: string[] = [], writes: string[] = [], unknownReads: string[] = [];
    const assetFailures: string[] = [], sourceRequests: string[] = [], sockets: string[] = [];
    const assets: Array<{ path: string; status: number; contentType: string }> = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => {
        const path = new URL(request.url()).pathname;
        if (/\.(?:js|css)$/.test(path)) assetFailures.push(`${path}: ${request.failure()?.errorText}`);
    });
    page.on("response", response => {
        const path = new URL(response.url()).pathname;
        if (!/^\/assets\/.*\.(?:js|css)$/.test(path)) return;
        const contentType = response.headers()["content-type"] || "";
        assets.push({ path, status: response.status(), contentType });
        if (!response.ok() || !(/\.css$/.test(path) ? /text\/css/.test(contentType) : /javascript/.test(contentType))) {
            assetFailures.push(`${response.status()} ${path} (${contentType})`);
        }
    });
    await context.routeWebSocket("**/*", socket => { sockets.push(socket.url()); socket.close(); });
    await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (url.origin !== origin) { blocked.push(request.url()); return route.abort("blockedbyclient"); }
        if (!["GET", "HEAD"].includes(request.method())) {
            writes.push(`${request.method()} ${path}`);
            return route.abort("blockedbyclient");
        }
        if (/^\/(?:src\/|@vite\/|@id\/|node_modules\/|tests\/)/.test(path)) {
            sourceRequests.push(path);
            return route.abort("blockedbyclient");
        }
        if (!path.startsWith("/api/")) return route.continue();
        const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
        // Trial mode keeps canvas persistence in this fresh browser context.
        // The real trial middleware supplies a guest designer identity; 401
        // would exercise ServiceUnavailable, not the canvas. This is synthetic
        // JSON only: no real authentication, cloud save, upload or paid call.
        if (path === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
        if (path === "/api/auth/session") return json({ user: guest });
        if (path === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
        if (path === "/api/models") return json({
            models: [{ id: "10000000-0000-4000-8000-000000000001", name: "Isolated image model", modelId: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 }],
            prices: [],
            tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: "10000000-0000-4000-8000-000000000001", configurationVersion: 1 })),
        });
        if (path === "/api/release-notes") return json({ notes: [], hasMore: false });
        if (path === "/api/tasks") return json({ tasks: [], nextCursor: null });
        unknownReads.push(`${request.method()} ${path}`);
        return json({ message: "Unmocked read blocked by production-preload smoke" }, 501);
    });

    await page.goto("/canvas");
    await expect(page.locator('script[type="module"][src^="/assets/"]')).toHaveCount(1);
    await page.getByRole("button", { name: "新建画布", exact: true }).first().click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    const canvasUrl = page.url();
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
    const skipGuide = page.getByRole("button", { name: "跳过引导", exact: true });
    if (await skipGuide.isVisible()) await skipGuide.click();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toHaveCount(0);

    await test.step("冷路径：真实动态 JS 与 CSS 加载后正常打开和关闭", async () => {
        await openAndCloseEntries(page);
        for (const name of entries) {
            await expect.poll(() => assets.some(asset => new RegExp(`^/assets/${name}-[\\w-]{8}\\.js$`).test(asset.path))).toBe(true);
        }
        for (const name of ["canvas-quick-generate-panel", "canvas-workspace-tools"]) {
            await expect.poll(() => assets.some(asset => new RegExp(`^/assets/${name}-[\\w-]{8}\\.css$`).test(asset.path))).toBe(true);
            // A successful preload alone is insufficient: CSS must be applied.
            await expect.poll(() => page.evaluate(prefix => Array.from(document.styleSheets).some(sheet =>
                sheet.href?.includes(`/assets/${prefix}-`) && sheet.cssRules.length > 0), name)).toBe(true);
        }
        await expect(page).toHaveURL(canvasUrl);
    });
    const coldEntryAssets = assets.filter(asset => entryAsset(asset.path, "js") || entryAsset(asset.path, "css"));
    await test.step("暖路径：同页重开使用模块缓存且关闭后画布仍可操作", async () => {
        await openAndCloseEntries(page);
        await expect(page).toHaveURL(canvasUrl);
        expect(assets.filter(asset => entryAsset(asset.path, "js") || entryAsset(asset.path, "css"))).toEqual(coldEntryAssets);
    });
    expect(assets.some(asset => /^\/assets\/project-[\w-]{8}\.js$/.test(asset.path))).toBe(true);
    expect(errors, "No page errors or failed dynamic imports").toEqual([]);
    expect(assetFailures, "Every requested built JS/CSS must load with the correct MIME type").toEqual([]);
    expect(sourceRequests, "Never serve Vite source fixtures").toEqual([]);
    expect(blocked, "No external host is contacted").toEqual([]);
    expect(sockets, "No WebSocket connection is opened").toEqual([]);
    expect(writes, "No API or other HTTP writes, including generation and paid analysis").toEqual([]);
    expect(unknownReads, "Only explicitly mocked local read APIs are allowed").toEqual([]);
});
