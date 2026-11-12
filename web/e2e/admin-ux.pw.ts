import { test, expect, type Page } from "@playwright/test";
import { MockCanvasApi } from "./fixtures";

const account = { id: "person", username: "zhangsan", displayName: "张三", email: "zhangsan@example.test", employeeNo: "D001", role: "designer", status: "active", departmentId: "design", departmentName: "设计部", creditBalance: 500, creditLimit: 500, monthlyCreditLimit: 500, temporaryCreditAdjustment: 0, creditResetAt: "2026-11-01T00:00:00+08:00" };
const provider = { id: "provider", name: "隔离服务", protocol: "openai", baseUrl: "https://example.test/v1", enabled: true, hasCredentials: true };

async function setup(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL); api.role = "super_admin";
    await api.attach(page.context());
    const writes: Array<{ path: string; data: any }> = [];
    let creditsEnabled = false;
    await page.context().route("**/api/**", async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false, wecomLoginUrl: null });
        if (!path.startsWith("/api/admin/")) return route.fallback();
        if (request.method() !== "GET") {
            const data = request.postData() ? request.postDataJSON() : {};
            writes.push({ path, data });
            if (path === "/api/admin/credit-policy") { creditsEnabled = data.creditsEnabled; return json({ creditsEnabled, updatedAt: null }); }
            if (path === "/api/admin/modules") return json({ module: { ...data, updatedAt: "2026-10-30T00:00:00Z" } });
            if (path.endsWith("/credits")) return json({ user: { ...account, creditBalance: account.creditBalance + data.amount } });
            return json({ user: account, provider });
        }
        if (path === "/api/admin/accounts") return json({ users: [account], totalUsedCredits: 24 });
        if (path === "/api/admin/departments") return json({ departments: [{ id: "design", name: "设计部", code: "design" }] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], total: 0, totalRmbCost: 1.23456, nextCursor: null });
        if (path === "/api/admin/credit-policy") return json({ creditsEnabled, updatedAt: null });
        if (path.endsWith("/providers")) return json({ providers: [provider] });
        if (path.endsWith("/prices")) return json({ prices: [{ id: "price", label: "生成一张图", operationType: "image_generation", version: 2, credits: 8, rmbCost: 0.8, status: "draft" }] });
        if (path.endsWith("/models")) return json({ models: [] });
        if (path.endsWith("/workflows")) return json({ workflows: [] });
        if (path.endsWith("/tool-configurations")) return json({ tools: [] });
        if (path.endsWith("/internal-ai")) return json({ seamlessUrl: "https://example.test/generate", hasAppKey: false, updatedAt: null, protocol: "app-key-json" });
        if (path === "/api/admin/projects") return json({ projects: [] });
        if (path === "/api/admin/assets") return json({ assets: [], total: 0, nextCursor: null, hasMore: false });
        if (path === "/api/admin/assets/owners") return json({ owners: [] });
        if (path.endsWith("/tasks")) return json({ tasks: [{ id: "waiting-task", userName: "张三", projectId: "project", operationType: "image_generation", status: "waiting", credits: 8, attempts: 0, priority: "normal", queuedAt: "2026-10-30T00:00:00Z" }], nextCursor: null });
        if (path.endsWith("/batches")) return json({ batches: [], nextCursor: null });
        if (path.includes("reconciliation")) return json({ code: 0, data: { tasks: [], chats: [], minimumChatAgeMinutes: 30 } });
        api.unexpected.push(`${request.method()} ${path}`); return json({});
    });
    return { api, writes };
}

test("admin overview only retains the account card and removed pricing URLs fall back on desktop and narrow screens", async ({ page }) => {
    const { api, writes } = await setup(page);
    await page.goto("/admin?tab=pricing");
    const overview = page.getByRole("region", { name: "管理概览" });
    await expect(overview).toHaveAttribute("aria-busy", "false");
    await expect(overview.locator(":scope > div")).toHaveCount(1);
    await expect(overview.getByText("可管理账号", { exact: true })).toBeVisible();
    await expect(overview.getByText("1", { exact: true })).toBeVisible();
    await expect(overview.getByText(/剩余额度|累计已用积分|人民币成本/)).toHaveCount(0);
    await expect(page.locator("#admin-account")).toBeVisible();
    await expect(page.locator("#admin-credit-adjustment")).toHaveCount(0);
    await expect(page.locator("#admin-account_quotaRemaining")).toHaveCount(0);
    await expect(page.locator("#admin-account_monthlyCreditLimit")).toHaveCount(0);
    const navigation = page.getByRole("navigation", { name: "管理板块" });
    await expect(navigation.getByRole("link", { name: "积分价格", exact: true })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "账号管理", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(navigation.getByRole("link", { name: "板块 API 配置", exact: true })).toBeVisible();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        const bounds = await overview.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.width).toBeGreaterThan(280);
        expect(bounds!.width).toBeLessThanOrEqual(384);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        await overview.screenshot({ path: test.info().outputPath(`account-overview-${viewport.width}.png`) });
    }
    expect(writes).toEqual([]);
    expect(api.pageErrors).toEqual([]);
    expect(api.unexpected).toEqual([]);
});

test("shared provider changes require confirmation and cancellation sends no write", async ({ page }) => {
    const { api, writes } = await setup(page);
    await page.goto("/admin?tab=api");
    await page.getByRole("tab", { name: "API 服务与密钥" }).click();
    const baseUrlName = /^\*?\s*Base URL$/;
    const form = page.locator("form").filter({ has: page.getByRole("textbox", { name: baseUrlName }) });
    await expect(form.getByRole("textbox", { name: baseUrlName })).toHaveValue(provider.baseUrl);
    await form.getByRole("textbox", { name: baseUrlName }).fill("https://changed.example.test/v1");
    await form.getByRole("button", { name: "保存到服务端", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("确认修改共用 API 服务「隔离服务」");
    await expect(page.getByRole("dialog")).toContainText("所有绑定此服务的模型及使用这些模型的板块");
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "返回核对", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(form.getByRole("textbox", { name: baseUrlName })).toHaveValue("https://changed.example.test/v1");
    expect(writes).toEqual([]);
    await form.getByRole("button", { name: "保存到服务端", exact: true }).click();
    await page.getByRole("button", { name: "确认修改共用服务", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ path: "/api/admin/model-configuration/providers/provider", data: { baseUrl: "https://changed.example.test/v1" } });
    expect(api.pageErrors).toEqual([]);
    expect(api.unexpected).toEqual([]);
});

test("account edits preserve financial fields and drafts still block tab changes", async ({ page }) => {
    const { api, writes } = await setup(page);
    await page.goto("/admin");
    await expect(page.getByRole("navigation", { name: "管理板块" })).toBeVisible();
    await expect(page.locator("#admin-credit-adjustment")).toHaveCount(0);
    await expect(page.locator("#admin-monthly-credit")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "启用积分计费" })).toHaveCount(0);
    await page.getByRole("row").filter({ hasText: "zhangsan" }).getByRole("button", { name: /编\s*辑/ }).click();
    await page.locator("#admin-account_name").fill("张三已更新");
    await page.getByRole("button", { name: "保存账号", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toContainText(/积分|余额|额度/);
    await page.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ path: "/api/admin/accounts/person", data: { displayName: "张三已更新", email: account.email, employeeNo: account.employeeNo, departmentId: "design", role: "designer", status: "active" } });
    await page.getByRole("row").filter({ hasText: "zhangsan" }).getByRole("button", { name: /编\s*辑/ }).click();
    await page.locator("#admin-account_name").fill("张三修改中");
    await page.getByRole("navigation", { name: "管理板块" }).getByRole("link", { name: "模块开关" }).click();
    await expect(page.getByRole("dialog")).toContainText("尚未保存");
    await page.getByRole("button", { name: "继续编辑" }).click();
    await expect(page.locator("#admin-account_name")).toHaveValue("张三修改中");
    await page.getByRole("navigation", { name: "管理板块" }).getByRole("link", { name: "模块开关" }).click();
    await page.getByRole("button", { name: "放弃修改" }).click();
    await expect(page).toHaveURL(/tab=modules/);
    await page.locator('[data-module-key="image"] [role="switch"]').click();
    await expect(page.getByRole("dialog")).toContainText("所有有权使用本模块的成员");
    await page.getByRole("button", { name: "保持不变" }).click();
    expect(writes).toHaveLength(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: "../output/interaction-experience/admin/modules-desktop.png", fullPage: true });
    expect(api.pageErrors).toEqual([]); expect(api.unexpected).toEqual([]);
});

test("nested provider tabs protect drafts without exposing removed billing controls", async ({ page }) => {
    const { api, writes } = await setup(page);
    await page.goto("/admin");
    await expect(page.getByRole("switch", { name: "启用积分计费" })).toHaveCount(0);
    expect(writes).toEqual([]);
    await page.getByRole("navigation", { name: "管理板块" }).getByRole("link", { name: "板块 API 配置" }).click();
    await page.getByRole("tab", { name: "API 服务与密钥" }).click();
    await page.getByRole("textbox", { name: /显示名称/ }).fill("尚未保存的服务");
    await page.getByRole("tab", { name: "工作流（高级）" }).click();
    await expect(page.getByRole("dialog")).toContainText("API 服务配置尚未保存");
    await page.getByRole("button", { name: "继续编辑" }).click();
    await expect(page.getByRole("textbox", { name: /显示名称/ })).toHaveValue("尚未保存的服务");
    await page.getByRole("button", { name: "保存到服务端", exact: true }).last().click();
    await expect.poll(() => writes.length).toBe(1);
    await page.getByRole("tab", { name: "工作流（高级）" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存工作流" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin?tab=projects");
    await expect(page.getByRole("navigation", { name: "管理板块" })).toBeVisible();
    await expect(page.getByText("公司项目监管")).toBeVisible();
    await page.getByRole("navigation", { name: "管理板块" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../output/interaction-experience/admin/mobile-navigation.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(api.pageErrors).toEqual([]);
    expect(api.unexpected).toEqual([]);
});

test("cancel task confirmation is required before a server mutation", async ({ page }) => {
    const { api, writes } = await setup(page);
    await page.goto("/admin?tab=batch");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("张三的任务 waiting-task");
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "保留任务" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "确认取消任务" }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].path).toBe("/api/admin/tasks/waiting-task/cancel");
    expect(api.pageErrors).toEqual([]); expect(api.unexpected).toEqual([]);
});

test("administrator login uses labelled form and Enter preserves the destination", async ({ page }) => {
    const { api } = await setup(page);
    const logins: any[] = [];
    await page.context().route("**/api/auth/login", async (route) => {
        logins.push(route.request().postDataJSON());
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { ...account, id: "admin", role: "super_admin", mustChangePassword: false } }) });
    });
    await page.goto("/admin/login?returnTo=%2Fadmin%3Ftab%3Dapi");
    await page.getByLabel("管理员账号", { exact: true }).fill("test-admin");
    await page.getByLabel("登录密码", { exact: true }).fill("FixtureOnly123!");
    await page.getByLabel("登录密码", { exact: true }).press("Enter");
    await expect(page).toHaveURL(/admin\?tab=api/);
    await expect(page.getByRole("tab", { name: "API 服务与密钥" })).toBeVisible();
    expect(logins).toEqual([{ identifier: "test-admin", password: "FixtureOnly123!", portal: "admin" }]);
    expect(api.pageErrors).toEqual([]);
});

test("prompt detail is complete without generation; publish refreshes and review failures are visible", async ({ page }) => {
    const { api } = await setup(page);
    const prompt = `${"保留服装结构，使用暖色织物。".repeat(40)}完整提示词结尾标记`;
    const item = { id: "template", title: "隔离团队模板", prompt, targetTool: "image-generation", scope: "team", favorite: false, version: 1, useCount: 0, category: "服装", tags: [], referenceAssetIds: [], notes: "使用前请调整", modelSnapshot: {}, parameters: {} };
    let lists = 0;
    const mutations: string[] = [];
    await page.context().route("**/api/**prompt-templates**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (path === "/api/prompt-templates") { lists++; return json({ templates: [item], total: 1, page: 1, pageSize: 24 }); }
        if (path === "/api/prompt-templates/review/submissions") return json({ submissions: [{ id: "review", title: "待审核模板", status: "pending", prompt: "审核内容", submitterName: "张三" }] });
        mutations.push(path);
        if (path.endsWith("/review/submissions/review")) return json({ message: "审核服务暂不可用" }, 503);
        if (path.endsWith("/promote-public")) return json({ publication: { templateId: "public", versionId: "version", duplicate: false } });
        if (path.endsWith("/copy")) return json({ template: item });
        if (path.endsWith("/archive")) return json({ message: "下架服务暂不可用" }, 503);
        throw new Error(`Unexpected prompt mutation ${path}`);
    });
    await page.goto("/prompts");
    await page.getByText("团队提示词", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "隔离团队模板" })).toBeVisible();
    await page.getByRole("button", { name: "查看完整提示词：隔离团队模板" }).click();
    await expect(page.getByRole("dialog")).toContainText("完整提示词结尾标记");
    await expect(page.getByRole("dialog").getByRole("button", { name: "填入 图像生成" })).toBeVisible();
    expect(mutations).toEqual([]);
    await expect.poll(() => page.getByRole("dialog").evaluate(element => element.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: "../output/interaction-experience/admin/prompt-details-desktop.png", fullPage: true });
    await page.getByRole("dialog").getByRole("button", { name: /close|关闭/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const before = lists;
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "发布到公共库" }).click();
    await expect.poll(() => lists).toBeGreaterThan(before);
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "复制为我的模板" }).click();
    await expect(page.getByRole("link", { name: "去查看" })).toHaveAttribute("href", "/my-prompts");
    await page.getByRole("button", { name: /^通\s*过$/ }).click();
    await page.getByRole("button", { name: "确认通过" }).click();
    await expect(page.getByText("审核服务暂不可用", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /^驳\s*回$/ }).click();
    await page.getByRole("button", { name: "确认驳回" }).click();
    await expect(page.getByText("审核服务暂不可用", { exact: true }).last()).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: /^下架$/ }).click();
    await page.getByRole("button", { name: "确认下架" }).click();
    await expect(page.getByText("下架服务暂不可用", { exact: true })).toBeVisible();
    expect(api.pageErrors).toEqual([]);
});
