import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fixture, personId, departmentId, modelId } from "./fixture";
import { reportFixture } from "../usage-report-fixture";
const output = resolve(import.meta.dirname, "../../../output/usage-report-browser");
const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07&uCompare=none";
async function setup(context: BrowserContext, handle?: (route: Route, url: URL) => Promise<boolean>) {
    const calls: Array<{ path: string; method: string; body: any }> = [],
        errors: string[] = [];
    for (const page of context.pages()) page.on("pageerror", (error) => errors.push(error.message));
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        calls.push({ path: url.pathname, method: route.request().method(), body: route.request().postDataJSON() });
        if (handle && (await handle(route, url))) return;
        if (url.pathname.endsWith("/report-v2"))
            return route.fulfill({ json: { code: 0, data: reportFixture(route.request().postDataJSON()), msg: "ok" } });
        if (url.pathname.endsWith("/analysis-models"))
            return route.fulfill({ json: { code: 0, data: { models: [] }, msg: "ok" } });
        try {
            return route.fulfill({ json: { code: 0, data: fixture(url), msg: "ok" } });
        } catch {
            return route.fulfill({ status: 501, json: { code: "UNMOCKED" } });
        }
    });
    return { calls, errors, reports: () => calls.filter((call) => call.path.endsWith("/report-v2")) };
}
async function loaded(page: Page) {
    await expect(page.getByTestId("usage-v2-content")).toBeVisible();
}
const generate = (page: Page) => page.getByRole("button", { name: "生成免费统计报告", exact: true });
const preview = (page: Page) => page.getByRole("dialog", { name: "免费统计报告预览" });
const option = (page: Page, name: string) =>
    page
        .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
        .filter({ hasText: name });

test("free reports cover six tabs with exact filters and create local Markdown/JSON, not AI calls", async ({
    page,
    context,
}) => {
    const state = await setup(context);
    await page.goto(
        `${base}&uDepartments=${departmentId}&uUsers=${personId}&uModels=${modelId}&uBoards=canvas&uOperations=image_generation`,
    );
    await loaded(page);
    for (const [name, key] of [
        ["总览", "overview"],
        ["人员", "people"],
        ["板块与功能", "boards"],
        ["模型与成本", "models"],
        ["生成质量", "quality"],
        ["流程分析", "flows"],
    ]) {
        if (key !== "overview") {
            await page.getByRole("tab", { name, exact: true }).click();
            await loaded(page);
        }
        await generate(page).click();
        await expect(preview(page)).toBeVisible();
        await expect(page.getByTestId("usage-v2-free-report-preview")).toContainText("团队概况");
        expect(state.reports().at(-1)?.body).toMatchObject({
            page: key,
            period: "selected",
            filters: {
                departmentIds: [departmentId],
                userIds: [personId],
                modelConfigIds: [modelId],
                boardKeys: ["canvas"],
                operationTypes: ["image_generation"],
            },
        });
        if (key === "overview" || key === "people") {
            for (const [label, extension] of [
                ["下载 Markdown", "md"],
                ["下载 JSON", "json"],
            ]) {
                const downloadEvent = page.waitForEvent("download");
                await preview(page).getByRole("button", { name: label, exact: true }).click();
                const download = await downloadEvent;
                expect(download.suggestedFilename()).toBe(
                    `免费统计报告-${key}-selected-2026-10-01-2026-10-07.${extension}`,
                );
                const path = resolve(output, download.suggestedFilename());
                await download.saveAs(path);
                const text = await readFile(path, "utf8");
                for (const value of [personId, modelId, departmentId, "测试设计师甲", "隔离设计部", "隔离图像模型"])
                    expect(text).not.toContain(value);
                if (extension === "json") {
                    const content = JSON.parse(text);
                    expect(content.page).toBe(key);
                    expect(content.metrics.generatedImages.value).toBe(42);
                } else expect(text).toContain("成功保存图片");
            }
        }
        if (key === "overview")
            await page.screenshot({
                path: resolve(output, "free-report-preview-desktop.png"),
                fullPage: false,
                animations: "disabled",
            });
        await preview(page).getByRole("button", { name: "关闭预览", exact: true }).click();
    }
    expect(state.reports()).toHaveLength(6);
    expect(state.calls.filter((call) => /analysis-preview|\/analyze$|rollups\/recompute/.test(call.path))).toHaveLength(
        0,
    );
    expect(state.errors).toEqual([]);
});

test("calendar eligibility is explicit and scope/draft changes remove stale previews", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(base);
    await loaded(page);
    await page.getByLabel("免费统计报告模板").click();
    await expect(option(page, "周报 · 完整自然周")).toHaveClass(/ant-select-item-option-disabled/);
    await expect(option(page, "月报 · 完整自然月")).toHaveClass(/ant-select-item-option-disabled/);
    await page.getByLabel("免费统计报告模板").press("Escape");
    await page.getByLabel("分析开始日期").fill("2026-10-05");
    await page.getByLabel("分析结束日期").fill("2026-10-11");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await loaded(page);
    await page.getByLabel("免费统计报告模板").click();
    await option(page, "周报 · 完整自然周").click();
    await generate(page).click();
    await expect(preview(page)).toBeVisible();
    expect(state.reports().at(-1)?.body).toMatchObject({
        period: "week",
        filters: { from: "2026-10-04T16:00:00.000Z", to: "2026-10-11T16:00:00.000Z" },
    });
    await preview(page).getByRole("button", { name: "关闭预览", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开报告预览" })).toBeVisible();
    await page.getByLabel("分析开始日期").fill("2026-10-01");
    await expect(page.getByRole("button", { name: "打开报告预览" })).toHaveCount(0);
    await expect(generate(page)).toBeDisabled();
    await page.getByLabel("分析结束日期").fill("2026-10-31");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await loaded(page);
    await page.getByLabel("免费统计报告模板").click();
    await option(page, "月报 · 完整自然月").click();
    await generate(page).click();
    await expect(preview(page)).toBeVisible();
    expect(state.reports().at(-1)?.body.period).toBe("month");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(preview(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
        path: resolve(output, "free-report-preview-mobile.png"),
        fullPage: false,
        animations: "disabled",
    });
    await preview(page).getByRole("button", { name: "关闭预览", exact: true }).click();
    await page.getByRole("button", { name: "刷新读取", exact: true }).click();
    await loaded(page);
    await expect(page.getByRole("button", { name: "打开报告预览" })).toHaveCount(0);
    expect(state.errors).toEqual([]);
});

test("report errors and cancelled in-flight work cannot create downloads or stale previews", async ({
    page,
    context,
}) => {
    let mode = "missing",
        release: (() => void) | undefined;
    const state = await setup(context, async (route, url) => {
        if (!url.pathname.endsWith("/report-v2")) return false;
        if (mode === "missing") {
            await route.fulfill({
                status: 409,
                json: { code: "USAGE_ROLLUP_REFRESH_REQUIRED", msg: "PRIVATE_SECRET" },
            });
            return true;
        }
        if (mode === "invalid") {
            const data = reportFixture(route.request().postDataJSON());
            data.content = JSON.stringify({ schemaVersion: 2, page: data.page, period: data.period });
            data.estimatedCharacters = data.content.length;
            await route.fulfill({ json: { code: 0, data } });
            return true;
        }
        if (mode === "hold") {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            await route
                .fulfill({ json: { code: 0, data: reportFixture(route.request().postDataJSON()) } })
                .catch(() => undefined);
            return true;
        }
        return false;
    });
    const downloads: string[] = [];
    page.on("download", (item) => downloads.push(item.suggestedFilename()));
    await page.goto(base);
    await loaded(page);
    await generate(page).click();
    await expect(page.getByText(/本期或对比期的日事实待回填/)).toBeVisible();
    expect(state.reports()).toHaveLength(1);
    mode = "invalid";
    await generate(page).click();
    await expect(page.getByText(/报告响应不完整或与本次范围不一致/)).toBeVisible();
    expect(state.reports()).toHaveLength(2);
    mode = "hold";
    await generate(page).click();
    await expect(page.getByRole("button", { name: "取消报告等待" })).toBeVisible();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.getByRole("button", { name: "取消报告等待" }).click();
    release?.();
    await expect(generate(page)).toBeEnabled();
    await expect(preview(page)).toHaveCount(0);
    expect(state.reports()).toHaveLength(3);
    release = undefined;
    await generate(page).click();
    await expect(page.getByRole("button", { name: "取消报告等待" })).toBeVisible();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.getByLabel("分析开始日期").fill("2026-10-02");
    release?.();
    await expect(page.getByRole("button", { name: "打开报告预览" })).toHaveCount(0);
    await expect(preview(page)).toHaveCount(0);
    expect(downloads).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.reports()).toHaveLength(4);
});

test("person activity dates collapse by Beijing day and paging replaces only the loaded records", async ({
    page,
    context,
}) => {
    const state = await setup(context, async (route, url) => {
        if (!url.pathname.endsWith("/profile")) return false;
        const data = fixture(url) as any,
            currentPage = Number(url.searchParams.get("page") || 1),
            record = data.activityPage.records[0];
        data.activityPage = {
            pagination: { page: currentPage, pageSize: 20, total: 21 },
            records:
                currentPage === 1
                    ? [
                          { ...record, id: "first", occurredAt: "2026-10-06T17:00:00Z", action: "第一页晚间记录" },
                          { ...record, id: "second", occurredAt: "2026-10-06T14:00:00Z", action: "第一页日间记录" },
                      ]
                    : [{ ...record, id: "third", occurredAt: "2026-10-05T12:00:00Z", action: "第二页独立记录" }],
        };
        await route.fulfill({ json: { code: 0, data } });
        return true;
    });
    await page.goto(`${base}&uTab=people`);
    await loaded(page);
    await page.getByRole("button", { name: "测试设计师甲", exact: true }).click();
    await loaded(page);
    await expect(page.getByRole("heading", { name: "测试设计师甲 · 个人使用画像" })).toBeVisible();
    const days = page.getByTestId("usage-activity-day");
    await expect(days).toHaveCount(2);
    await expect(days.nth(0)).toHaveAttribute("open", "");
    await expect(days.nth(0).locator("summary")).toContainText("2026-10-07");
    await expect(days.nth(1)).not.toHaveAttribute("open");
    await days.nth(1).locator("summary").click();
    await expect(days.nth(1).getByText("第一页日间记录")).toBeVisible();
    await expect(days.nth(1).getByText("¥0.600000")).toBeVisible();
    await expect(days.nth(1).getByText("25.0 秒")).toBeVisible();
    await page.locator(".ant-pagination-item-2").click();
    await loaded(page);
    await expect(days).toHaveCount(1);
    await expect(days.first().locator("summary")).toContainText("2026-10-05");
    await expect(page.getByText("第二页独立记录")).toBeVisible();
    await expect(page.getByText("第一页晚间记录")).toHaveCount(0);
    expect(state.calls.some((call) => call.path.endsWith("/profile"))).toBe(true);
    expect(state.errors).toEqual([]);
});
