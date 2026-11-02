import type { BrowserContext, Route } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";

const owner = "00000000-0000-4000-8000-000000000099";
const assetId = "11111111-1111-4111-8111-111111111111";
const pendingId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const historyId = "44444444-4444-4444-8444-444444444444";
const image = { id: assetId, ownerUserId: owner, ownerName: "设计师甲", departmentName: "设计中心", projectId, projectName: "秋冬针织", taskId: "task-a", filename: "秋冬针织.png", mimeType: "image/png", byteSize: IMAGE.length, kind: "image", source: "generation", operationType: "image_generation", prompt: null, modelName: "测试图像模型", status: "ready", visibilityScope: "private", metadata: { title: "秋冬针织花型", width: 256, height: 256 }, createdAt: "2026-11-01T09:30:00Z", resultStatus: "candidate", downloadCount: 0 };
const pending = { ...image, id: pendingId, filename: "待上传.png", metadata: {}, status: "pending" };
const history = { id: historyId, taskId: "task-a", userId: owner, userName: "设计师甲", departmentName: "设计中心", projectId: "external-project", operationType: "image_generation", modelName: "测试图像模型", prompt: "完整历史提示词", credits: 10, rmbCost: 0.2, status: "success", failureReason: null, createdAt: image.createdAt };

async function mockAdmin(context: BrowserContext) {
    const reads: URL[] = [], mediaReads: URL[] = [], details: string[] = [];
    let failDetail = false;
    const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    await context.route("**/api/auth/methods", route => json(route, { password: true, wecom: false, oa: false }));
    await context.route("**/api/admin/**", async route => {
        const url = new URL(route.request().url()), path = url.pathname;
        if (path === "/api/admin/accounts") return json(route, { users: [], totalUsedCredits: 10 });
        if (path === "/api/admin/departments") return json(route, { departments: [] });
        if (path === "/api/admin/audit-logs") return json(route, { auditLogs: [] });
        if (path === "/api/admin/credit-policy") return json(route, { creditsEnabled: false, updatedAt: null });
        if (path === "/api/admin/assets/owners") return json(route, { owners: [{ value: owner, label: "设计师甲" }] });
        if (path === "/api/admin/projects") return json(route, { projects: [{ id: projectId, externalId: "external-project", name: "秋冬针织", ownerName: "设计师甲", status: "active", taskCount: 1, assetCount: 2, credits: 10, updatedAt: image.createdAt }] });
        if (path === "/api/admin/assets") {
            reads.push(url);
            return json(route, { assets: url.searchParams.get("q") === "不存在" ? [] : [image, pending], nextCursor: null, hasMore: false });
        }
        if (path === "/api/admin/history") return json(route, { history: [history], total: 1, totalCredits: 10, totalRmbCost: 0.2, nextCursor: null, hasMore: false });
        if (path === "/api/admin/history/options") return json(route, { users: [{ value: owner, label: "设计师甲" }], models: [], operations: [] });
        if (path === `/api/admin/history/${historyId}`) return json(route, { history: { ...history, parameters: { quality: "high" }, sourceUrls: [`/api/assets/${assetId}/content`], resultUrls: [`/api/assets/${assetId}/content`, "https://external.invalid/private-image.png", "javascript:alert(1)"] } });
        return route.fallback();
    });
    await context.route("**/api/assets/**", async route => {
        const url = new URL(route.request().url()); mediaReads.push(url);
        if (url.pathname === `/api/assets/${assetId}`) {
            details.push(assetId);
            if (failDetail) return json(route, { msg: "模拟详情暂不可用" }, 503);
            return json(route, { asset: { ...image, prompt: "完整提示词：保留原版花型比例与材质", metadata: { ...image.metadata, parameters: { quality: "high", seed: 42 } } } });
        }
        if (url.pathname.endsWith("/thumb")) return route.fulfill({ contentType: "image/png", body: IMAGE });
        return route.fallback();
    });
    return { reads, mediaReads, details, failNextDetail() { failDetail = true; }, allowDetail() { failDetail = false; } };
}

test("图片墙按需详情、显式重试、URL筛选和全部列表，桌面与移动端无横向溢出", async ({ page, context, api }) => {
    api.role = "super_admin";
    const mock = await mockAdmin(context);
    await page.goto("/admin?tab=projects&keep=retained");
    const wall = page.getByRole("region", { name: "素材图片墙" });
    await expect(wall.getByRole("button", { name: "查看素材：秋冬针织花型" })).toBeVisible();
    await expect(wall).toContainText("尚不可预览：待处理");
    expect(mock.details).toEqual([]);
    expect(mock.mediaReads.every(url => !url.pathname.endsWith("/content"))).toBe(true);
    expect(mock.reads[0].searchParams.get("kind")).toBe("image");
    await page.screenshot({ path: "../output/admin-gallery/desktop-wall.png", fullPage: true });

    mock.failNextDetail();
    await wall.getByRole("button", { name: "查看素材：秋冬针织花型" }).click();
    const drawer = page.getByRole("dialog", { name: "素材详情" });
    await expect(drawer).toContainText("模拟详情暂不可用");
    expect(mock.details.length).toBeGreaterThan(0);
    mock.allowDetail();
    await drawer.getByRole("button", { name: "重试详情" }).click();
    await expect(drawer).toContainText("完整提示词：保留原版花型比例与材质");
    await expect(drawer.getByRole("link", { name: "打开原文件" })).toHaveAttribute("href", `/api/assets/${assetId}/content`);
    await expect(drawer.getByRole("img", { name: "秋冬针织花型" })).toHaveAttribute("src", `/api/assets/${assetId}/thumb?w=1024`);
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("textbox", { name: "素材关键词" }).fill("不存在");
    await page.getByRole("button", { name: "搜索素材", exact: true }).click();
    await expect(page).toHaveURL(/assetQ=/); await expect(wall).toContainText("当前筛选下暂无图片素材");
    expect(new URL(page.url()).searchParams.get("keep")).toBe("retained");
    await page.getByRole("button", { name: "查看素材", exact: true }).click();
    await expect(wall.getByRole("button", { name: "查看素材：秋冬针织花型" })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("assetProject")).toBe(projectId);
    expect(new URL(page.url()).searchParams.has("assetQ")).toBe(false);
    await page.getByText("全部素材列表", { exact: true }).click();
    await expect(page.getByRole("button", { name: "查看详情", exact: true })).toHaveCount(2);
    await expect.poll(() => mock.reads.at(-1)?.searchParams.has("kind")).toBe(false);
    await page.getByText("图片墙", { exact: true }).click();
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.setViewportSize({ width: 390, height: 844 });
    await wall.scrollIntoViewIfNeeded();
    await expect(wall.getByRole("button", { name: "查看素材：秋冬针织花型" })).toBeInViewport();
    await page.screenshot({ path: "../output/admin-gallery/mobile-wall.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await wall.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.getByRole("region", { name: "素材筛选" }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(api.submissions).toEqual([]);
});

test("历史详情只预览本站鉴权缩略，外站与不安全地址不自动请求", async ({ page, context, api }) => {
    api.role = "super_admin";
    const mock = await mockAdmin(context);
    await page.goto("/admin?tab=history");
    await expect(page.getByRole("button", { name: "查看", exact: true })).toBeVisible();
    expect(mock.mediaReads).toEqual([]);
    await page.getByRole("button", { name: "查看", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "生成历史详情" });
    await expect(drawer.getByRole("img", { name: "原图 1", exact: true })).toHaveAttribute("src", `/api/assets/${assetId}/thumb?w=256`);
    await expect(drawer.getByRole("img", { name: "结果 1", exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "结果 2：https://external.invalid/private-image.png", exact: true })).toHaveAttribute("href", "https://external.invalid/private-image.png");
    await expect(drawer).toContainText("此地址不支持直接预览或打开");
    expect(mock.mediaReads.every(url => url.pathname.endsWith("/thumb"))).toBe(true);
    await expect.poll(async () => { const box = await drawer.boundingBox(); return Boolean(box && box.x + box.width <= page.viewportSize()!.width + 1); }).toBe(true);
    await page.screenshot({ path: "../output/admin-gallery/history-preview.png", fullPage: true });
    expect(api.blocked).toEqual([]); expect(api.submissions).toEqual([]);
});
