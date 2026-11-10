import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { MockCanvasApi, IMAGE } from "./fixtures";

const owner = "00000000-0000-4000-8000-000000000099";
async function setup(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL); await api.attach(page.context());
    await page.context().route("**/api/prompt-templates?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ templates: [], total: 0 }) }));
    return api;
}
function clean(api: MockCanvasApi) {
    expect(api.submissions).toEqual([]); expect(api.blocked).toEqual([]);
    expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
}

test("main navigation enables creative prompt preview, cancels without generation, and persists the shared mobile setting", async ({ page }) => {
    const api = await setup(page);
    const previewRequests: unknown[] = [];
    const compiledPrompt = "Create a cobalt blue knitted hat with a ribbed folded cuff.";
    await page.context().route("**/api/tasks/preview", route => {
        const input = route.request().postDataJSON();
        expect(route.request().method()).toBe("POST");
        expect(input).toMatchObject({ toolKey: "creative-text-to-style", operationType: "image_generation", sourceUrls: [], promptInput: { scene: "text-to-style", userText: "钴蓝色针织帽，罗纹翻边" } });
        previewRequests.push(input);
        return route.fulfill({ json: { preview: { prompt: compiledPrompt, summaryZh: "保留针织材质与罗纹翻边要求", optimized: true, promptInput: { ...input.promptInput, compilationId: "30000000-0000-4000-8000-000000000001" } } } });
    });
    await page.goto("/creative/text-to-style");
    const description = page.getByRole("textbox", { name: "款式描述", exact: true });
    await expect(description).toBeVisible();
    const desktopToggle = page.getByRole("button", { name: "生成前确认：已关闭", exact: true });
    await expect(desktopToggle).toBeVisible();
    await expect(desktopToggle).toHaveAttribute("aria-pressed", "false");
    await desktopToggle.click();
    await expect(page.getByRole("button", { name: "生成前确认：已开启", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByRole("button", { name: "生成前确认：已开启", exact: true })).toHaveAttribute("aria-pressed", "true");
    await description.fill("钴蓝色针织帽，罗纹翻边");
    await page.getByRole("button", { name: /^生成款式/ }).click();
    const preview = page.getByRole("dialog", { name: "生成前确认", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByLabel("实际发送文本", { exact: true })).toHaveText(compiledPrompt);
    await page.screenshot({ path: test.info().outputPath("desktop-preview.png"), fullPage: true, animations: "disabled" });
    expect(previewRequests).toHaveLength(1);
    expect(api.submissions).toEqual([]);
    await preview.getByRole("button", { name: "取消，返回修改", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(page.getByRole("button", { name: /^生成款式/ })).toBeEnabled();
    await expect(description).toHaveValue("钴蓝色针织帽，罗纹翻边");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "功能模块", exact: true });
    const mobileToggle = drawer.getByRole("button", { name: "生成前确认：已开启", exact: true });
    await expect(mobileToggle).toBeVisible();
    await expect(mobileToggle).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: test.info().outputPath("mobile-enabled.png"), fullPage: true, animations: "disabled" });
    await mobileToggle.click();
    await expect(drawer.getByRole("button", { name: "生成前确认：已关闭", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(description).toHaveValue("钴蓝色针织帽，罗纹翻边");
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "生成前确认：已关闭", exact: true })).toHaveAttribute("aria-pressed", "false");
    expect(previewRequests).toHaveLength(1);
    expect(api.batchSubmissions).toEqual([]);
    clean(api);
});

test("manual pinned navigation stays stable, has one active location, and mobile includes workbench and theme", async ({ page }) => {
    const api = await setup(page);
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav.getByRole("button", { name: "固定图像生成", exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "固定图像生成", exact: true }).click();
    const pinned = page.getByRole("region", { name: "固定入口" });
    await expect(pinned).toContainText("图像生成");
    await nav.getByRole("link", { name: "图像生成", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "图像提示词" })).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await nav.getByRole("link", { name: "素材库", exact: true }).click();
    await expect(page.getByRole("heading", { name: "素材库", exact: true })).toBeVisible();
    await expect(pinned.getByRole("link")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("desktop-light.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开导航菜单" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("link", { name: "工作台", exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "切换到深色主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await expect(drawer.getByRole("status").filter({ hasText: "画布" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("mobile-dark.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    clean(api);
});

test("asset export includes every filtered page and original files, not only loaded cards", async ({ page }) => {
    const api = await setup(page);
    const assets = ["a", "b"].map((id, index) => ({ id, ownerUserId: owner, ownerName: "设计师", kind: "image", filename: `generation-${id}.png`, source: "generation", metadata: { title: `generation-${id}.png`, tags: ["面料"], width: 256, height: 256 }, prompt: `面料原图 ${index + 1}`, status: "ready", mimeType: "image/png", byteSize: IMAGE.length, createdAt: "2026-10-30T00:00:00Z", resultStatus: "unused", usabilityScore: 0, downloadCount: 0, contentUrl: `/api/assets/${id}/content` }));
    const originalText = Buffer.from("\ufeff原始文字\r\n不可丢失", "utf8");
    const textAsset = { ...assets[0], id: "text", kind: "text", filename: "原始说明.txt", prompt: "", metadata: {}, contentUrl: "/api/assets/text/content", mimeType: "text/plain", byteSize: originalText.length };
    const otherOwner = { ...assets[0], id: "other", ownerUserId: "another-employee", filename: "不在当前素材列表.png", contentUrl: "/api/assets/other/content" };
    const complete = [...assets, textAsset, otherOwner];
    const pageReads: string[] = [];
    await page.context().route("**/api/assets**", async route => {
        const req = route.request(), url = new URL(req.url());
        const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
        if (url.pathname === "/api/assets") { pageReads.push(url.search); return json({ assets: url.searchParams.has("cursor") ? [assets[1], textAsset, otherOwner] : [assets[0]], hasMore: !url.searchParams.has("cursor"), nextCursor: url.searchParams.has("cursor") ? null : "second" }); }
        if (url.pathname === "/api/assets/batch") { expect(req.postDataJSON().assetIds).not.toContain("other"); return json({ assets: complete.filter(asset => req.postDataJSON().assetIds.includes(asset.id)) }); }
        if (url.pathname === "/api/assets/text/content") return route.fulfill({ contentType: "text/plain", body: originalText });
        if (url.pathname.endsWith("/events")) return json({ eventId: "export-record" });
        return route.fallback();
    });
    await page.goto("/assets");
    await expect(page.getByRole("heading", { name: "面料原图 1", exact: true })).toBeVisible();
    await expect(page.getByText("可用性 0/100", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "更多筛选", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "按标签筛选" })).toBeVisible();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出全部筛选素材" }).click();
    const download = await downloading;
    const bytes = await readFile((await download.path())!);
    const files = unzipSync(bytes), manifest = JSON.parse(new TextDecoder().decode(files["assets.json"]));
    expect(manifest.assets.map((asset: any) => asset.id)).toEqual(["a", "b", "text"]);
    expect(manifest.files).toHaveLength(3);
    expect(manifest.assets[2].data.content).toBe("原始文字\r\n不可丢失");
    for (const file of manifest.files) expect(Buffer.from(files[file.path])).toEqual(file.storageKey.startsWith("text:") ? originalText : IMAGE);
    expect(pageReads.some(search => search.includes("limit=100") && search.includes("cursor=second"))).toBe(true);
    await expect(page.getByText("已导出当前筛选的全部 3 个素材", { exact: true })).toBeVisible();
    clean(api);
});

test("expired session preserves editable draft and opt-in same-account recovery without generation", async ({ page }) => {
    const api = await setup(page); let expired = false, loginCalls = 0;
    await page.context().route("**/api/auth/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/session" && expired) return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "expired" }) });
        if (path === "/api/auth/login") {
            loginCalls++; expired = false;
            expect(route.request().postDataJSON()).toMatchObject({ identifier: "e2e", portal: "designer" });
            return route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: owner, username: "e2e", displayName: "隔离回归账号", role: "designer", status: "active", mustChangePassword: false } }) });
        }
        return route.fallback();
    });
    await page.goto("/image");
    const input = page.getByRole("textbox", { name: "图像提示词" });
    await input.fill("未提交的草稿，过期后不要丢失");
    expired = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const recovery = page.getByRole("button", { name: "恢复登录", exact: true });
    await expect(recovery).toBeVisible();
    await expect(page.getByRole("dialog", { name: "登录已过期" })).toHaveCount(0);
    await expect(page.locator('[inert]')).toHaveCount(0);
    await input.fill("未提交的草稿，过期后不要丢失，继续编辑");
    await recovery.click();
    await expect(page.getByRole("link", { name: "在新窗口登录（支持原登录方式）" })).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByLabel("登录密码", { exact: true })).toHaveCount(0);
    await recovery.click();
    await page.getByLabel("登录密码", { exact: true }).fill("FixtureOnly2026");
    await page.getByRole("button", { name: "重新登录并继续" }).click();
    await expect(recovery).toHaveCount(0);
    await expect(input).toHaveValue("未提交的草稿，过期后不要丢失，继续编辑");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "图像提示词" })).toHaveValue("未提交的草稿，过期后不要丢失，继续编辑");
    expect(loginCalls).toBe(1); clean(api);
});
