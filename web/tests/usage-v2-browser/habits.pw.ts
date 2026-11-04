import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture, personId } from "./fixture";

const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07";
const output = resolve(import.meta.dirname, "../../../output/usage-habits-browser");
async function setup(context: BrowserContext, empty = false) {
    const calls: Array<{ path: string; method: string }> = [], errors: string[] = [];
    for (const page of context.pages()) page.on("pageerror", error => errors.push(error.message));
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        calls.push({ path: url.pathname, method: route.request().method() });
        if (route.request().method() !== "GET") return route.fulfill({ status: 405, json: { code: "READ_ONLY_TEST" } });
        const data = fixture(url) as any;
        if (empty && url.pathname.endsWith("/profile")) {
            data.habits.rates = data.habits.rates.map((row: any) => ({ ...row, eligible: 0, matched: 0, missing: 0, rate: { ...row.rate, value: null, state: "unavailable", denominator: 0 } }));
            data.habits.referenceCounts = { eligible: 0, missing: 0, items: [] };
            data.habits.parameters = [];
        }
        return route.fulfill({ json: { code: 0, data, msg: "isolated synthetic fixture" } });
    });
    await mkdir(output, { recursive: true });
    return { calls, errors };
}

test("profile habits and independent board parameter rows remain readable in light and narrow dark views", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(`${base}&uTab=people&uPerson=${personId}`);
    const habits = page.getByTestId("usage-work-habits");
    await expect(habits.getByRole("heading", { name: "批次关联任务占比" })).toBeVisible();
    await expect(habits.getByText("12.5%", { exact: true })).toBeVisible();
    await expect(habits).toContainText("有效分母 24");
    await expect(page.getByTestId("usage-reference-counts")).toContainText("重复项不去重");
    await expect(page.getByTestId("usage-parameters")).toContainText("未记录 / 无有效值");
    await habits.screenshot({ path: resolve(output, "profile-habits-light.png") });
    await page.goto(`${base}&uTab=boards`);
    const parameters = page.getByTestId("usage-parameters");
    await expect(parameters.getByRole("heading", { name: "已记录参数分布 · 按板块" })).toBeVisible();
    await expect(parameters.locator("tbody .ant-table-row")).toHaveCount(3);
    await expect(parameters.locator("tbody .ant-table-row").filter({ hasText: "high" })).toContainText("75.0%");
    await expect(parameters.locator("tbody .ant-table-row").filter({ hasText: "画布" })).toContainText("不可用");
    await parameters.getByRole("columnheader", { name: /^板块/ }).locator(".ant-table-filter-trigger").click();
    const dropdown = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
    await dropdown.getByText("图片生成", { exact: true }).click();
    await dropdown.getByRole("button", { name: /确\s*定|OK/ }).click();
    await expect(dropdown).not.toBeVisible();
    await expect(parameters.locator("tbody .ant-table-row")).toHaveCount(2);
    await parameters.screenshot({ path: resolve(output, "board-parameters-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}&uTab=people&uPerson=${personId}&theme=dark`);
    await expect(habits).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await habits.screenshot({ path: resolve(output, "profile-habits-dark-narrow.png") });
    expect(state.calls.every(call => call.method === "GET")).toBe(true);
    expect(state.calls.some(call => /\/people\/[^/]+$/.test(call.path))).toBe(false);
    expect(state.errors).toEqual([]);
});

test("empty task history renders unavailable habit proportions and no invented reference buckets", async ({ page, context }) => {
    const state = await setup(context, true);
    await page.goto(`${base}&uTab=people&uPerson=${personId}`);
    const habits = page.getByTestId("usage-work-habits");
    await expect(habits.getByText("不可用", { exact: true })).toHaveCount(3);
    await expect(habits).not.toContainText("0.0%");
    await expect(page.getByText("当前范围没有可用的参考项数量记录", { exact: true })).toBeVisible();
    await expect(page.getByText("当前范围没有任务参数记录", { exact: true })).toBeVisible();
    expect(state.errors).toEqual([]);
});
