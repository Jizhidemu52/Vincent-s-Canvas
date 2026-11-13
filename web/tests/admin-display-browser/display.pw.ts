import { test, expect, type BrowserContext } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { reportFixture } from "../usage-report-fixture";

const output = resolve(import.meta.dirname, "../../../output/i18n-complete-20261113");
const base = "/tests/admin-display-browser/index.html";
const markdown = "# 报告总览\n\n保持报告原文。";
const translations: Record<string, string> = {
    "开发组": "Development group", "成果": "Outputs", "团队": "Team", "部门产出": "Department output",
    "开发摘要": "Development summary", "保留图案形状": "Preserve the motif shape", "隐藏快照说明": "Hidden snapshot description", "隐藏输入描述": "Hidden input description", "隐藏响应说明": "Hidden response description",
    [markdown]: "# Report overview\n\nKeep the original report.", "报告独立标题": "Independent report title",
    "针织开发部": "Knitwear development", "帽子开发组": "Hat development", "员工甲": "Employee A", "样例项目": "Sample project", "成果提示原文": "Original output prompt",
    "提交 4 张": "4 images submitted", "成功 3 / 失败 1 / 取消 0": "Succeeded 3 / failed 1 / canceled 0", "批量完成率 75%": "Batch completion 75%",
    "北京时间今日 · 按账号去重，不随日期筛选变化": "Today in Beijing time · unique accounts, independent of date filters", "活跃日为至少有一张有效成果": "An active day has at least one valid output",
};
const performance = {
    period: { from: "2026-11-01T00:00:00Z", to: "2026-11-08T00:00:00Z" }, todayUsage: { date: "2026-11-13", timeZone: "Asia/Shanghai", users: 1 },
    metrics: { requestedOutputs: 4, validOutputs: 3, naturalDailyAverage: 0.43, activeDailyAverage: 3, successCount: 3, failedCount: 1, cancelledCount: 0, successRate: 75, batchCompletionRate: 75, averageDurationSeconds: 15, reworkRate: 0, onTimeDeliveryRate: 100, totalCredits: 0, totalRmbCost: 0, averageCreditsPerOutput: 0, averageCostPerOutput: 0, averageCostPerAdopted: 0, downloadRate: 66.67, averageUsabilityScore: 60 },
    trend: [], directions: [{ direction: "apparel", count: 3, rate: 100 }], funnel: [],
    designers: [{ userId: "employee-1", userName: "员工甲", departmentName: "针织开发部", groupName: "帽子开发组", outputs: 3, successRate: 75, downloadRate: 66.67, reuseRate: 0, adoptionRate: 0, deliveryRate: 0, usabilityScore: 60, credits: 0, rmbCost: 0, topDirection: "apparel" }],
    failureReasons: [], tasks: [], assets: [{ id: "asset-1", userName: "员工甲", departmentName: "针织开发部", groupName: "帽子开发组", projectName: "样例项目", operationType: "image_generation", modelName: "Fixture model", prompt: "成果提示原文", primaryDirection: "apparel", secondaryDirections: [], adminDirectionTags: [], directionRuleVersion: "fixture", createdAt: "2026-11-13T00:00:00Z", resultStatus: "candidate", usabilityScore: 60 }],
    options: { users: [], departments: [], groups: [] }, comparisons: null,
};
async function setup(context: BrowserContext) {
    const texts: string[] = [], errors: string[] = [], calls: Array<{ path: string; method: string; body: any }> = [];
    let report: ReturnType<typeof reportFixture> | null = null;
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", error => errors.push(error.message));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const body = route.request().postDataJSON();
        calls.push({ path: url.pathname, method: route.request().method(), body });
        if (url.pathname === "/api/display-translations") {
            texts.push(...body.texts);
            return route.fulfill({ json: { translations: body.texts.map((text: string) => translations[text] ?? text) } });
        }
        if (url.pathname.endsWith("/report-v2")) {
            report = reportFixture(body);
            report.markdown = markdown;
            report.content = JSON.stringify({ ...JSON.parse(report.content), title: "报告独立标题", apiKey: "不可发送密钥" });
            report.estimatedCharacters = report.content.length;
            return route.fulfill({ json: { code: 0, data: report, msg: "ok" } });
        }
        if (url.pathname.endsWith("/analysis-models")) return route.fulfill({ json: { code: 0, data: { models: [] }, msg: "ok" } });
        if (url.pathname === "/api/performance") return route.fulfill({ json: performance });
        if (url.pathname === "/api/performance/assets/asset-1/direction") return route.fulfill({ json: { ok: true } });
        return route.fulfill({ status: 501, json: { code: "UNMOCKED", path: url.pathname } });
    });
    return { texts, errors, calls, report: () => report! };
}

test("chart translates its actual canvas labels and preserves native click payloads", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(base);
    await expect(page.locator('[data-usage-chart] canvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).adminDisplayFixture.readChart().axisLabel)).toBe("Development group");
    const chart = await page.evaluate(() => (window as any).adminDisplayFixture.readChart());
    expect(chart).toMatchObject({ category: "开发组", seriesName: "成果", legendLabel: "Outputs", axisName: "Submission to completion (ms)", tooltip: "Development group\nOutputs: 12" });
    const box = await page.locator("[data-usage-chart]").boundingBox();
    await page.mouse.click(box!.x + chart.point[0], box!.y + chart.point[1]);
    await expect(page.getByTestId("chart-selection")).toHaveText(JSON.stringify({ index: 0, name: "开发组" }));
    await page.screenshot({ path: resolve(output, "admin-display-chart-en.png"), fullPage: false });
    await page.getByRole("button", { name: "中文", exact: true }).click();
    await expect(page.getByRole("img", { name: "部门产出", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).adminDisplayFixture.current())).toBe(await page.evaluate(() => (window as any).adminDisplayFixture.original));
    expect(state.errors).toEqual([]);
    expect(state.calls.every(call => call.path === "/api/display-translations")).toBe(true);
});

test("closed compilation details never queue hidden JSON; displayed human leaves preserve protected values", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(`${base}?view=compilation`);
    await expect(page.getByText("Development summary", { exact: true })).toBeVisible();
    expect(state.texts).not.toContain("隐藏快照说明");
    expect(state.texts).not.toContain("隐藏响应说明");
    await page.locator("details > summary").click();
    const snapshot = page.getByTestId("compilation-request-snapshot"), response = page.getByTestId("compilation-raw-response");
    await expect(snapshot).toContainText("Hidden snapshot description");
    await expect(response).toContainText("Hidden response description");
    await expect(snapshot).toContainText('"apiKey": "保密令牌"');
    await expect(snapshot).toContainText('"code": "保留程序代码"');
    for (const value of ["保密令牌", "保留程序代码", "原始请求标识", "原始模型标识", "保留令牌", "原始代码", "https://example.invalid/原路径"]) expect(state.texts).not.toContain(value);
    await page.getByRole("button", { name: "中文", exact: true }).click();
    await expect(snapshot).toContainText("隐藏快照说明");
    await expect(response).toContainText("隐藏响应说明");
    expect(await page.evaluate(() => (window as any).adminDisplayFixture.current())).toBe(await page.evaluate(() => (window as any).adminDisplayFixture.original));
    expect(state.errors).toEqual([]);
});

test("report tabs require separate English opt-in and both downloads retain the original bytes", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(`${base}?view=report`);
    await page.getByRole("button", { name: "Generate free statistical report", exact: true }).click();
    const preview = page.getByTestId("usage-v2-free-report-preview");
    await expect(preview).toContainText("报告总览");
    await page.waitForTimeout(1200);
    expect(state.texts).not.toContain(markdown);
    expect(state.texts).not.toContain("报告独立标题");
    await page.getByRole("button", { name: "Translate this preview into English", exact: true }).click();
    await expect(preview).toContainText("Report overview");
    await page.getByRole("tab", { name: "Aggregate JSON", exact: true }).click();
    await expect(page.getByTestId("usage-v2-free-report-json")).toContainText("报告独立标题");
    expect(state.texts).not.toContain("报告独立标题");
    await page.getByRole("button", { name: "Translate this preview into English", exact: true }).click();
    await expect(page.getByTestId("usage-v2-free-report-json")).toContainText("Independent report title");
    expect(state.texts).not.toContain("不可发送密钥");
    for (const [label, extension, original] of [["Download Markdown", "md", state.report().markdown], ["Download JSON", "json", state.report().content]]) {
        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("button", { name: label, exact: true }).click();
        const download = await downloadEvent, target = resolve(output, `admin-display-report.${extension}`);
        await download.saveAs(target);
        expect(await readFile(target, "utf8")).toBe(original);
        expect(download.suggestedFilename()).toMatch(new RegExp(`^免费统计报告-overview-selected-.*\\.${extension}$`));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const reportTab = page.getByRole("tab", { name: "Report and evidence tables", exact: true });
    await reportTab.click();
    await expect(reportTab).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: resolve(output, "admin-display-report-mobile.png"), fullPage: false, animations: "disabled" });
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByRole("button", { name: "中文", exact: true }).click();
    await page.getByRole("button", { name: "打开报告预览", exact: true }).click();
    await expect(preview).toContainText("报告总览");
    await page.getByRole("tab", { name: "聚合 JSON", exact: true }).click();
    await expect(page.getByTestId("usage-v2-free-report-json")).toContainText("报告独立标题");
    await expect(page.getByRole("button", { name: "Translate this preview into English", exact: true })).toHaveCount(0);
    expect(state.calls.filter(call => call.path.endsWith("/report-v2"))).toHaveLength(1);
    expect(state.errors).toEqual([]);
});

test("department and group display translates while direction saves its original value and tags", async ({ page, context }) => {
    const state = await setup(context), before = JSON.stringify(performance);
    await page.goto(`${base}?view=performance`);
    const designer = page.locator('[data-row-key="employee-1"]');
    await expect(designer).toContainText("Knitwear development / Hat development");
    await expect(page.getByText("15 s", { exact: true })).toBeVisible();
    await expect(page.getByText("4 images submitted", { exact: true })).toBeVisible();
    const direction = page.locator('[data-row-key="asset-1"] .ant-select');
    await direction.click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: "Product image" }).click();
    await expect.poll(() => state.calls.filter(call => call.method === "PATCH").length).toBe(1);
    expect(state.calls.find(call => call.method === "PATCH")?.body).toEqual({ primaryDirection: "product", secondaryDirections: [], adminTags: ["商品图"] });
    expect(JSON.stringify(performance)).toBe(before);
    await page.getByRole("button", { name: "中文", exact: true }).click();
    await expect(designer).toContainText("针织开发部 / 帽子开发组");
    await expect(page.getByText("15 秒", { exact: true })).toBeVisible();
    expect(state.errors).toEqual([]);
});
