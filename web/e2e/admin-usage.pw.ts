import { test, expect, type Page } from "@playwright/test";
import { MockCanvasApi } from "./fixtures";

const imageModel = "10000000-0000-4000-8000-000000000001", textModel = "10000000-0000-4000-8000-000000000002";
const summary = { visits: 5, interactions: 11, generationRequests: 4, chatRequests: 1, succeeded: 3, failed: 1, pending: 1, totalRmbCost: .32208, generatedImages: 4 };
const coverage = { collectionStartedAt: "2026-10-15T00:00:00Z", historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, droppedEventCount: 2, missingHistoryCount: 1, notes: ["取消和中断计入失败。", "已保存历史金额不按新单价重算；未上报缺口可能未知。"] };
const daily = [{ day: "2026-11-01", ...summary, generationRequests: 0, chatRequests: 0, succeeded: 0, failed: 0, pending: 0, totalRmbCost: 0, generatedImages: 0 }, { day: "2026-11-02", ...summary }];
const breakdowns = { boards: [{ key: "canvas-image", label: "画布图片生成", count: 18 }, { key: "unknown", label: "未记录板块", count: 1 }], models: [{ key: imageModel, label: "历史图片模型", count: 4 }, { key: textModel, label: "文字模型", count: 1 }, { key: "unknown", label: "未知模型", count: 1 }], controls: [{ key: "quality", label: "画质", count: 11 }], daily };
const people = Array.from({ length: 21 }, (_, index) => ({ userId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, displayName: `测试员工 ${index + 1}`, departmentName: "设计部", summary, lastActivityAt: "2026-11-02T03:00:00Z" }));

async function setup(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL); api.role = "super_admin";
    await api.attach(page.context());
    const requests: Array<{ path: string; method: string; input: any }> = [];
    await page.context().route("**/api/**", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        const json = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
        const ok = (data: unknown) => json({ code: 0, data, msg: "ok" });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false, wecomLoginUrl: null });
        if (path === "/api/admin/accounts") return json({ users: [{ ...people[0], username: "fixture", role: "designer", status: "active", creditBalance: 100 }], totalUsedCredits: 4 });
        if (path === "/api/admin/departments") return json({ departments: [] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], totalRmbCost: summary.totalRmbCost, total: 0, nextCursor: null });
        if (!path.startsWith("/api/admin/usage/")) return route.fallback();
        const input = request.method() === "GET" ? Object.fromEntries(url.searchParams) : request.postDataJSON();
        requests.push({ path, method: request.method(), input });
        if (path.endsWith("/analysis-models")) return ok({ models: [{ id: textModel, name: "已配置文字模型" }] });
        if (path.endsWith("/people")) {
            const current = Number(input.page || 1), pageSize = 20;
            return ok({ people: people.slice((current - 1) * pageSize, current * pageSize), pagination: { page: current, pageSize, total: people.length }, summary, breakdowns, coverage });
        }
        if (path.includes("/people/")) return ok({ person: people[0], summary, breakdowns, coverage, records: [], pagination: { page: 1, pageSize: 20, total: 0 } });
        if (path.endsWith("/analysis-preview")) return ok({ previewId: "fixture-preview", previewHash: "fixture-hash", expiresAt: "2099-01-01T00:00:00Z", content: JSON.stringify({ scope: input, summary }), estimatedCharacters: 500, includesPromptSamples: false, sampleCount: 0, warnings: ["不含姓名、图片或完整提示词；仅供流程改进。"] });
        api.unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "MOCK_BLOCKED", msg: "No live action allowed" }) });
    });
    return { api, requests };
}
const select = async (page: Page, label: string, option: string) => {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByLabel(label, { exact: true }).fill(option);
    await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText(option, { exact: true }).click();
};

test("usage filters, drilldown and sorting stay scoped without sending AI; desktop/mobile layouts remain readable", async ({ page }) => {
    const { api, requests } = await setup(page);
    await page.goto("/admin?tab=usage-analysis");
    await expect(page.getByRole("heading", { name: "每日趋势", exact: true })).toBeVisible();
    await page.getByLabel("使用分析开始日期", { exact: true }).fill("2026-11-01");
    await page.getByLabel("使用分析结束日期", { exact: true }).fill("2026-11-02");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(page.getByLabel("使用分析已应用范围")).toContainText("2026-11-01 至 2026-11-02");
    const trend = page.getByRole("region", { name: "每日趋势", exact: true });
    await expect(trend).toContainText("1 个成功任务缺少结算历史");
    await trend.getByText("查看每日准确数据", { exact: false }).click();
    await expect(trend.getByRole("table")).toContainText("￥0.322080");
    await expect(trend.getByRole("table")).toContainText("75.0%");
    await expect(page.getByRole("button", { name: "筛选模型调用分布：未知模型" })).toHaveCount(0);
    await page.screenshot({ path: "../output/admin-usage-optimization/desktop.png", fullPage: true });

    await page.getByRole("button", { name: "筛选模型调用分布：历史图片模型", exact: true }).click();
    await expect.poll(() => requests.filter(request => request.path.endsWith("/people")).at(-1)?.input.modelConfigId).toBe(imageModel);
    await select(page, "使用分析板块筛选", "画布图片生成");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect.poll(() => requests.filter(request => request.path.endsWith("/people")).at(-1)?.input.boardKey).toBe("canvas-image");
    const users = page.getByRole("region", { name: "用户使用列表", exact: true });
    await users.getByRole("button", { name: "测试员工 1", exact: true }).click();
    await expect(page.getByRole("heading", { name: "个人每日趋势", exact: true })).toBeVisible();
    expect(requests.find(request => request.path.includes("/people/"))?.input).toMatchObject({ boardKey: "canvas-image", modelConfigId: imageModel });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "个人每日趋势", exact: true })).toHaveCount(0);
    await users.getByRole("row").filter({ hasText: "测试员工 1" }).first().getByRole("checkbox").check();
    await users.getByRole("columnheader", { name: "生成消费（元）" }).click();
    await expect.poll(() => requests.filter(request => request.path.endsWith("/people")).at(-1)?.input.sort).toBe("cost");
    await expect(users.getByRole("button", { name: "导出选中（1）" })).toBeEnabled();
    await users.getByTitle("2", { exact: true }).click();
    await expect.poll(() => requests.filter(request => request.path.endsWith("/people")).at(-1)?.input.page).toBe("2");
    await expect(users.getByRole("button", { name: "导出选中（1）" })).toBeEnabled();
    await page.getByRole("button", { name: "预览将发送的汇总", exact: true }).click();
    await expect(page.getByTestId("usage-analysis-preview")).toBeVisible();
    expect(requests.find(request => request.path.endsWith("/analysis-preview"))?.input).toMatchObject({ boardKey: "canvas-image", modelConfigId: imageModel, from: "2026-10-31T16:00:00.000Z", to: "2026-11-02T16:00:00.000Z" });
    await page.getByRole("button", { name: "近 7 天", exact: true }).click();
    await expect(page.getByTestId("usage-analysis-preview")).toHaveCount(0);
    await expect(users.getByRole("button", { name: "导出选中（0）" })).toBeDisabled();
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(page.getByText("筛选条件尚未应用", { exact: false })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "使用分析", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../output/admin-usage-optimization/mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await trend.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../output/admin-usage-optimization/mobile-trend.png", fullPage: true });
    expect(requests.filter(request => request.path.endsWith("/analyze"))).toEqual([]);
    // Old bookmarked V2 query parameters must not switch the production entry back to the rejected dashboard.
    await page.goto("/admin?tab=usage-analysis&uLegacy=0&uTab=quality");
    await expect(page.getByRole("heading", { name: "每日趋势", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "用户使用列表", exact: true })).toBeVisible();
    await expect(page.getByTestId("usage-v2-content")).toHaveCount(0);
    expect(requests.filter(request => /\/(overview|options|people-v2|models|quality|flows|recompute|analysis-preview-v2|analyze-v2)$/.test(request.path))).toEqual([]);
    expect(api.pageErrors).toEqual([]); expect(api.unexpected).toEqual([]);
});
