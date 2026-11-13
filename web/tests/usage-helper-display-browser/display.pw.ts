import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { comparison, departments, ids, overview } from "./data";
import { comparisonText, metricCoverageText, metricText, perActivePersonCost, snapshotText } from "../../src/pages/admin/usage/format";

const output = resolve(import.meta.dirname, "../../../output/i18n-complete-20261113");
const base = "/tests/usage-helper-display-browser/index.html";
const translations: Record<string, string> = {
    "隔离比较员工甲": "Comparison employee A", "隔离比较员工乙": "Comparison employee B", "测试甲部门": "Test department A", "测试乙部门": "Test department B",
    "A · 测试甲部门": "A · Test department A", "B · 测试乙部门": "B · Test department B", "测试维度": "Test dimension",
    "按有记录活跃员工": "Per recorded active employee", "按范围名册": "Per roster member", "合成观察说明": "Synthetic observation",
    "隐藏页面覆盖说明": "Hidden page coverage note", "隐藏指标覆盖说明": "Hidden metric coverage note", "隐藏依据原文": "Hidden evidence source",
    "覆盖不完整，不计算差异": "Incomplete coverage; difference not calculated", "+20.0 个百分点": "+20.0 percentage points",
    "0；相对 B 0.0%": "0; relative to B 0.0%", "0 ms；相对 B 0.0%": "0 ms; relative to B 0.0%", "¥0.000000；相对 B 0.0%": "¥0.000000; relative to B 0.0%",
    [comparison.team.perActivePersonBookedCny.definition]: "Synthetic: team recorded cost divided by the stated population, not provider payment.",
    [comparison.team.populationDefinition]: "Synthetic scope: original filtered team, including roster members without current records; rates use pooled counts, not individual averages.",
    [snapshotText(comparison.meta)]: "Snapshot: mixed refresh times, not one observation time. Original scope retained.",
    [snapshotText(overview.meta)]: "Snapshot: mixed refresh times, not one observation time. Original scope retained.",
};
for (const metric of [comparison.team.perActivePersonBookedCny, comparison.team.perRosterPersonBookedCny, ...departments.map(row => perActivePersonCost(row.metrics)), ...[comparison.team.metrics, ...comparison.people.map(person => person.metrics), overview.metrics, ...departments.map(row => row.metrics)].flatMap(metrics => Object.values(metrics))]) {
        const value = metricText(metric).replace(" 分钟", " min").replace(" 秒", " s").replace("不可用", "Unavailable");
        translations[metricText(metric)] = value;
        translations[metricCoverageText(metric)] = `${value}${metric.state === "partial" ? " (partial coverage)" : ""}; available samples ${metric.availableCount}, missing ${metric.missingCount}`;
        if (comparisonText(metric)) translations[comparisonText(metric)] = comparisonText(metric).replace("较对比期", "Compared with prior period").replace("个百分点", "percentage points").replace("缺少可比数据", "Comparable data unavailable");
}
async function setup(context: BrowserContext) {
    const texts: string[] = [], errors: string[] = [], unexpected: string[] = [], business: string[] = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", error => errors.push(error.message));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") { unexpected.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname !== "/api/display-translations") { business.push(url.pathname); return route.fulfill({ status: 501, json: { code: "UNMOCKED" } }); }
        const source = route.request().postDataJSON().texts as string[];
        texts.push(...source);
        return route.fulfill({ json: { translations: source.map(text => translations[text] ?? text) } });
    });
    return { texts, errors, unexpected, business };
}
async function download(page: Page, label: string) {
    const event = page.waitForEvent("download");
    await page.getByRole("button", { name: label, exact: true }).click();
    const file = await event;
    return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}
async function originalUnchanged(page: Page) {
    expect(await page.evaluate(() => (window as any).usageHelperFixture.current())).toBe(await page.evaluate(() => (window as any).usageHelperFixture.original));
}

test("comparison helper English display preserves profile IDs and byte-identical Chinese workbook exports", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(base);
    const people = page.getByTestId("usage-people-comparison"), department = page.getByTestId("usage-department-comparison");
    const originalPeople = await people.innerText(), originalDepartment = await department.innerText();
    await expect(people).toContainText("按有记录活跃员工人均已记账金额：¥15.750000；可用样本 20，缺失 0");
    await expect(people).toContainText("分母 4 人；隔离合成：团队已记账金额 / 明确人数，不是供应商实付。");
    const originalDownload = await download(page, "导出人员团队对照 Excel");
    const originalDepartmentDownload = await download(page, "导出部门对照 Excel");
    expect(state.texts).toEqual([]);
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(people).toContainText("Synthetic scope: original filtered team");
    await expect(people).toContainText("25.0 s; available samples 20, missing 0");
    await expect(people).toContainText("Numerator Not provided / Denominator 20");
    await expect(people).toContainText("Per recorded active employee");
    await expect(people).toContainText("Per roster member");
    await expect(people).toContainText("Snapshot: mixed refresh times");
    await expect(people).toContainText("Per recorded active employee · Recorded amount per person: ¥15.750000");
    await expect(people).toContainText("Per roster member · Recorded amount per person: ¥10.500000");
    await expect(people).toContainText("Denominator 4 people; Synthetic: team recorded cost");
    await expect(people).toContainText("not older values combined from lists. Snapshot:");
    await people.getByRole("button", { name: "Comparison employee A · View profile", exact: true }).click();
    await expect(page.getByTestId("selection")).toHaveText(ids[0]);
    await expect(department).toContainText("+20.0 percentage points");
    await expect(department).toContainText("Incomplete coverage; difference not calculated");
    await expect.poll(() => people.innerText()).not.toMatch(/[\u3400-\u9fff]/);
    await expect.poll(() => department.innerText()).not.toMatch(/[\u3400-\u9fff]/);
    const englishDownload = await download(page, "Export individual/team comparison to Excel");
    const englishDepartmentDownload = await download(page, "Export department comparison to Excel");
    expect(englishDownload.name).toBe("人员与原范围团队对照.xlsx");
    expect(englishDownload.bytes.equals(originalDownload.bytes)).toBe(true);
    expect(englishDepartmentDownload.bytes.equals(originalDepartmentDownload.bytes)).toBe(true);
    const book = XLSX.read(englishDownload.bytes, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets["当前页明细"]);
    expect(rows.filter(row => row.对象 === "隔离比较员工甲")).toHaveLength(11);
    expect(JSON.stringify(rows)).toContain("可用样本"); expect(JSON.stringify(rows)).not.toContain("Comparison employee A");
    await people.screenshot({ path: resolve(output, "usage-helper-people-en.png") });
    await department.screenshot({ path: resolve(output, "usage-helper-department-en.png") });
    await page.getByRole("button", { name: "中文", exact: true }).click();
    expect(await people.innerText()).toBe(originalPeople); expect(await department.innerText()).toBe(originalDepartment);
    await originalUnchanged(page);
    expect(state.business).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("metric cards and hidden coverage translate on display while diagnostics and drilldown IDs remain original", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(`${base}?view=helpers`);
    const cards = page.locator("[data-usage-metric]");
    const diagnostic = await cards.evaluateAll(elements => elements.map(element => element.getAttribute("data-usage-metric")));
    const originalVisible = await page.locator("main > div, main > section").allInnerTexts();
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(cards.first()).toContainText("3.0 min");
    await expect(cards.nth(1)).toContainText("25.0 s");
    await expect(cards.nth(2)).toContainText("Compared with prior period +18.0 percentage points");
    await expect(page.getByTestId("optimization")).toContainText("40.0% (partial coverage); available samples 20, missing 4");
    await expect(page.getByTestId("optimization")).toContainText("Success rate: 90.0%");
    await expect(page.getByTestId("optimization")).toContainText("Result usage rate: 40.0%");
    await expect(page.getByTestId("optimization")).toContainText("Formal adoption rate: 10.0%");
    await expect(page.getByTestId("usage-snapshot")).toContainText("Snapshot: mixed refresh times");
    for (const source of ["隐藏页面覆盖说明", "隐藏指标覆盖说明", "隐藏依据原文"]) expect(state.texts).not.toContain(source);
    await page.getByTestId("usage-snapshot").locator("..").locator("details > summary").click();
    await expect(page.getByText("Hidden page coverage note", { exact: true })).toBeVisible();
    await expect(page.getByText("Hidden metric coverage note", { exact: true })).toBeVisible();
    await page.locator('details').filter({ hasText: "raw-rule-id" }).locator("summary").click();
    await expect(page.getByText("Hidden evidence source", { exact: true })).toBeVisible();
    const dimensionButton = page.getByRole("button", { name: "Test department A", exact: true });
    await dimensionButton.click();
    await expect(page.getByTestId("selection")).toHaveText("raw-department-a");
    expect(await cards.evaluateAll(elements => elements.map(element => element.getAttribute("data-usage-metric")))).toEqual(diagnostic);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await cards.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, "usage-helper-metrics-mobile-en.png"), fullPage: false });
    await page.getByTestId("usage-snapshot").locator("..").locator("details > summary").click();
    await page.locator('details').filter({ hasText: "raw-rule-id" }).locator("summary").click();
    await page.getByRole("button", { name: "中文", exact: true }).click();
    expect(await page.locator("main > div, main > section").allInnerTexts()).toEqual(originalVisible);
    await originalUnchanged(page);
    expect(state.business).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
