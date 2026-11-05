import { test, expect, type Page } from "@playwright/test";
import type { UsageV2Models, UsageV2Overview, UsageV2People } from "../../shared/usage-analytics-v2";
import { fixture, modelId, personId } from "../tests/usage-v2-browser/fixture";
import { peopleComparisonFixture } from "../tests/usage-v2-browser/people-comparison-fixture";
import { MockCanvasApi } from "./fixtures";

const textModel = "10000000-0000-4000-8000-000000000002";
const pageTwoPersonId = "20000000-0000-4000-8000-000000000021";
const dateScope = { from: "2026-10-31T16:00:00.000Z", to: "2026-11-02T16:00:00.000Z" };
const filteredScope = { ...dateScope, boardKeys: "canvas", modelConfigIds: modelId };

async function setup(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL); api.role = "super_admin";
    await api.attach(page.context());
    const requests: Array<{ path: string; method: string; input: any }> = [];
    await page.context().route("**/api/**", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (url.origin !== test.info().project.use.baseURL) return route.fallback();
        const json = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
        const ok = (data: unknown) => json({ code: 0, data, msg: "ok" });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false, wecomLoginUrl: null });
        if (path === "/api/admin/accounts") return json({ users: [{ userId: personId, displayName: "测试设计师甲", username: "fixture", role: "designer", status: "active", creditBalance: 100 }], totalUsedCredits: 4 });
        if (path === "/api/admin/departments") return json({ departments: [] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], totalRmbCost: .32208, total: 0, nextCursor: null });
        if (!path.startsWith("/api/admin/usage/")) return route.fallback();
        const input = request.method() === "GET" ? Object.fromEntries(url.searchParams) : request.postDataJSON();
        requests.push({ path, method: request.method(), input });
        if (request.method() === "GET") {
            if (path.endsWith("/analysis-models")) return ok({ models: [{ id: textModel, name: "已配置文字模型" }] });
            if (path.endsWith("/overview")) {
                const data = fixture(url) as UsageV2Overview;
                // Retain the original regression's sub-yuan six-decimal and zero-day cases.
                data.metrics.generationBookedCny = { ...data.metrics.generationBookedCny, value: .32208, amount: "0.322080" };
                data.metrics.successRate = { ...data.metrics.successRate, value: .75 };
                data.daily = data.daily.map((row, index) => ({ ...row, metrics: { ...row.metrics, generationBookedCny: { ...data.metrics.generationBookedCny, value: index === 0 ? 0 : .32208, amount: index === 0 ? "0.000000" : "0.322080" } } }));
                return ok(data);
            }
            if (path.endsWith("/people-v2")) {
                const data = fixture(url) as UsageV2People;
                const people = Array.from({ length: 21 }, (_, index) => ({ ...data.people[0], userId: index === 0 ? personId : "20000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"), displayName: index === 0 ? "测试设计师甲" : "测试员工 " + (index + 1) }));
                data.people = people.slice((data.pagination.page - 1) * 20, data.pagination.page * 20);
                data.pagination.total = people.length;
                return ok(data);
            }
            if (path.endsWith("/models")) {
                const data = fixture(url) as UsageV2Models;
                data.models.push({ ...data.models[0], key: "unknown", label: "未知模型", modelConfigId: null });
                return ok(data);
            }
            if (path.endsWith("/options") || path === "/api/admin/usage/people/" + personId + "/profile") return ok(fixture(url));
        }
        if (request.method() === "POST" && path.endsWith("/people-compare")) return ok(peopleComparisonFixture(input.filters, input.selectedUserIds, ["测试设计师甲", "测试员工 21"]));
        if (request.method() === "POST" && path.endsWith("/analysis-preview")) return ok({ previewId: "fixture-preview", previewHash: "fixture-hash", expiresAt: "2099-01-01T00:00:00Z", content: JSON.stringify({ scope: input, summary: { totalRmbCost: .32208 } }), estimatedCharacters: 500, includesPromptSamples: false, sampleCount: 0, warnings: ["不含姓名、图片或完整提示词；仅供流程改进。"] });
        api.unexpected.push(request.method() + " " + path);
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "MOCK_BLOCKED", msg: "No live action allowed" }) });
    });
    return { api, requests };
}
const select = async (page: Page, label: string, option: string) => {
    await page.getByLabel(label, { exact: true }).click();
    await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText(option, { exact: true }).click();
    await page.getByLabel(label, { exact: true }).press("Escape");
};
const loaded = async (page: Page) => expect(page.getByTestId("usage-v2-content")).toBeVisible();

test("usage filters, drilldown and sorting stay scoped without sending AI; desktop/mobile layouts remain readable", async ({ page }) => {
    const { api, requests } = await setup(page);
    const latest = (suffix: string) => requests.filter(request => request.path.endsWith(suffix)).at(-1)?.input;
    await page.goto("/admin?tab=usage-analysis");
    await loaded(page);
    await expect(page.getByRole("tab")).toHaveCount(6);
    await expect.poll(() => requests.some(request => request.path.endsWith("/options"))).toBe(true);
    const initialReads = requests.filter(request => request.path.endsWith("/overview")).length;
    await page.getByLabel("分析开始日期", { exact: true }).fill("2026-11-01");
    await page.getByLabel("分析结束日期", { exact: true }).fill("2026-11-02");
    await expect(page.getByText("筛选尚未应用；导出和 AI 确认暂不可用", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "导出完整 JSONL", exact: true })).toBeDisabled();
    expect(requests.filter(request => request.path.endsWith("/overview"))).toHaveLength(initialReads);
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await loaded(page);
    await expect.poll(() => latest("/overview")).toMatchObject(dateScope);
    await expect(page.getByLabel("当前分析范围")).toContainText("2026-11-01 至 2026-11-02");
    const trend = page.getByRole("region", { name: "每日趋势与对比", exact: true });
    await expect(trend.locator("canvas")).toBeVisible();
    await select(page, "总览趋势指标", "已记账生成金额");
    await trend.getByText("日期准确值与键盘下钻", { exact: true }).click();
    await expect(trend).toContainText("¥0.000000");
    await expect(trend).toContainText("¥0.322080");
    await expect(page.locator('[data-usage-metric^="终态请求成功率："]')).toContainText("75.0%");
    await expect(page.locator('[data-usage-metric^="本软件可见活跃时长"]')).toContainText("不可用");
    await page.getByText("口径与数据覆盖", { exact: false }).click();
    await expect(page.getByText("合成样例：部分结果缺少关联。", { exact: false })).toBeVisible();
    await page.screenshot({ path: "../output/admin-usage-optimization/desktop.png", fullPage: true });

    await page.getByRole("tab", { name: "模型与成本", exact: true }).click();
    await loaded(page);
    await expect(page.getByRole("button", { name: "未知模型 · generate · canvas", exact: true })).toBeVisible();
    const beforeUnknown = requests.length, beforeUnknownUrl = page.url();
    await page.getByRole("button", { name: "未知模型 · generate · canvas", exact: true }).click();
    expect(page.url()).toBe(beforeUnknownUrl);
    expect(requests).toHaveLength(beforeUnknown);
    await page.getByRole("button", { name: "隔离图像模型 · generate · canvas", exact: true }).click();
    await loaded(page);
    await expect.poll(() => latest("/models")).toMatchObject({ ...filteredScope, operationTypes: "generate" });
    await expect(page.getByRole("button", { name: "预览将发送的汇总", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "清除维度筛选", exact: true }).click();
    await loaded(page);
    await select(page, "分析模型筛选", "隔离图像模型");
    await select(page, "分析板块筛选", "画布");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await loaded(page);
    await expect.poll(() => latest("/models")).toMatchObject(filteredScope);
    expect(latest("/models").operationTypes).toBeUndefined();

    await page.getByRole("tab", { name: "人员", exact: true }).click();
    await loaded(page);
    await expect.poll(() => latest("/people-v2")).toMatchObject(filteredScope);
    await page.getByRole("button", { name: "测试设计师甲", exact: true }).click();
    await expect(page.getByRole("heading", { name: "测试设计师甲 · 个人使用画像", exact: true })).toBeVisible();
    expect(latest("/people/" + personId + "/profile")).toMatchObject(filteredScope);
    expect(requests.filter(request => /\/people\/[^/]+$/.test(request.path))).toEqual([]);
    await page.getByRole("button", { name: "← 返回人员列表", exact: true }).click();
    await loaded(page);
    await page.getByLabel("对比选择 测试设计师甲", { exact: true }).check();
    await page.getByRole("columnheader", { name: "已记账金额", exact: true }).click();
    await loaded(page);
    await expect.poll(() => latest("/people-v2")).toMatchObject({ ...filteredScope, sort: "generationBookedCny", order: "asc" });
    await expect(page.getByText("跨页已选 1 / 5 人", { exact: true })).toBeVisible();
    await page.locator(".ant-pagination-item-2").click();
    await loaded(page);
    await expect.poll(() => latest("/people-v2").page).toBe("2");
    await expect(page.getByRole("button", { name: "测试设计师甲", exact: true })).toHaveCount(0);
    await expect(page.getByText("跨页已选 1 / 5 人", { exact: true })).toBeVisible();
    await page.getByLabel("对比选择 测试员工 21", { exact: true }).check();
    await expect(page.getByText("跨页已选 2 / 5 人", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "读取所选人员对比", exact: true }).click();
    await expect(page.getByTestId("usage-people-comparison")).toBeVisible();
    // AntD's leaving loading icon can remain in the accessible name after completion.
    const compareButton = page.getByRole("button", { name: /^(?:loading )?读取所选人员对比$/ });
    await expect(compareButton).toBeEnabled();
    await expect(compareButton).not.toHaveClass(/ant-btn-loading/);
    expect(latest("/people-compare")).toMatchObject({ filters: { ...dateScope, boardKeys: ["canvas"], modelConfigIds: [modelId] }, selectedUserIds: [personId, pageTwoPersonId] });

    await page.getByRole("button", { name: "预览将发送的汇总", exact: true }).click();
    await expect(page.getByTestId("usage-v2-preview")).toBeVisible();
    expect(latest("/analysis-preview")).toMatchObject({ ...dateScope, boardKey: "canvas", modelConfigId: modelId, includePromptSamples: false });
    const beforePreset = requests.length;
    await page.getByRole("button", { name: "近 7 天", exact: true }).click();
    await expect(page.getByTestId("usage-v2-preview")).toHaveCount(0);
    await expect(page.getByTestId("usage-people-comparison")).toHaveCount(0);
    await expect(page.getByText("跨页已选 0 / 5 人", { exact: true })).toBeVisible();
    await expect(compareButton).toBeDisabled();
    await expect(page.getByRole("button", { name: "发送已预览汇总 · 可能付费", exact: true })).toBeDisabled();
    expect(requests).toHaveLength(beforePreset);
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await loaded(page);
    await expect(page.getByText("筛选尚未应用", { exact: false })).toHaveCount(0);
    await expect.poll(() => latest("/people-v2").page).toBe("1");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "使用分析", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../output/admin-usage-optimization/mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("tab", { name: "总览", exact: true }).click();
    await loaded(page);
    await expect(trend.locator("canvas")).toBeVisible();
    await trend.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../output/admin-usage-optimization/mobile-trend.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(requests.filter(request => /\/(analyze(?:-v2)?|recompute)$/.test(request.path))).toEqual([]);
    expect(api.pageErrors).toEqual([]); expect(api.unexpected).toEqual([]); expect(api.blocked).toEqual([]);
});
