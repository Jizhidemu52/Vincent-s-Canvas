import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "./fixture";
import type { UsageControlDaily, UsageReleaseContext } from "../../../shared/usage-release-context";

const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uTab=overview&uFrom=2026-10-01&uTo=2026-10-07";
const output = resolve(import.meta.dirname, "../../../output/usage-release-context-browser");
const publications: UsageReleaseContext = {
    source: "release_notes.published_at",
    scope: "global_publications_in_selected_dates",
    observedAt: "2026-10-08T00:00:00Z",
    limit: 200,
    truncated: false,
    releases: [
        {
            version: "v1.0.0",
            title: "<img src=x onerror=alert(1)>合成标题",
            publishedAt: "2026-10-01T16:00:00Z",
            day: "2026-10-02",
        },
        { version: "v1.0.1", title: "同日第二条日志", publishedAt: "2026-10-01T18:00:00Z", day: "2026-10-02" },
    ],
};
const controls: UsageControlDaily = {
    source: "usage_events",
    mappingSource: "existing_control_keys_and_labels",
    totalControls: 2,
    limit: 20,
    truncated: false,
    missingControlRecords: 3,
    series: [
        {
            boardKey: "canvas",
            boardLabel: "画布",
            controlKey: "submit",
            label: "提交",
            total: 8,
            daily: [
                { day: "2026-10-02", count: 5 },
                { day: "2026-10-05", count: 3 },
            ],
        },
        {
            boardKey: "image",
            boardLabel: "图片生成",
            controlKey: "submit",
            label: "提交",
            total: 2,
            daily: [{ day: "2026-10-03", count: 2 }],
        },
    ],
};

async function setup(context: BrowserContext, mode: "full" | "empty" | "omitted" = "full") {
    const calls: string[] = [],
        external: string[] = [],
        errors: string[] = [];
    for (const page of context.pages()) page.on("pageerror", (error) => errors.push(error.message));
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") {
            external.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        calls.push(route.request().method());
        if (route.request().method() !== "GET") return route.fulfill({ status: 405, json: { code: "READ_ONLY_TEST" } });
        const data = fixture(url);
        if (url.pathname.endsWith("/overview") && mode !== "omitted")
            Object.assign(data, {
                releaseContext: { ...publications, releases: mode === "empty" ? [] : publications.releases },
                controlDaily:
                    mode === "empty"
                        ? { ...controls, totalControls: 0, missingControlRecords: 0, series: [] }
                        : controls,
            });
        return route.fulfill({ json: { code: 0, data, msg: "isolated synthetic fixture" } });
    });
    await mkdir(output, { recursive: true });
    return { calls, external, errors };
}

test("publication context and scoped control choices render in desktop and narrow dark views", async ({
    page,
    context,
}) => {
    const state = await setup(context);
    await page.goto(base);
    const panel = page.getByRole("region", { name: "发布日志与控件趋势" });
    await expect(panel.getByText("同日第二条日志", { exact: false })).toBeVisible();
    await expect(panel).toContainText("2026/10/2 00:00:00");
    await expect(panel).toContainText("不是部署时间");
    await expect(panel).toContainText("不受部门或人员筛选影响");
    await expect(panel).toContainText("<img src=x onerror=alert(1)>合成标题");
    await expect(panel.locator("img")).toHaveCount(0);
    await expect(page.locator('[data-usage-chart="每日趋势与对比"] canvas')).toBeVisible();
    await expect(panel.locator('[data-usage-chart="控件已记录使用趋势"] canvas')).toBeVisible();
    await panel.getByText("已记录日的准确计数", { exact: true }).click();
    await expect(panel.getByText("2026-10-02 · 5 条", { exact: true })).toBeVisible();
    await expect(panel.getByText("2026-10-01 · 0 条", { exact: true })).toHaveCount(0);
    await panel.getByRole("combobox", { name: "控件趋势选择" }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("图片生成 · 提交 · 2 条", { exact: true }).click();
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    await expect(panel).toContainText("板块：image；控件：submit");
    await expect(panel.getByText("2026-10-03 · 2 条", { exact: true })).toBeVisible();
    await expect(panel.getByText("2026-10-02 · 5 条", { exact: true })).toHaveCount(0);
    await panel.screenshot({ path: resolve(output, "release-context-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}&theme=dark`);
    await expect(panel.locator('[data-usage-chart="控件已记录使用趋势"] canvas')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await panel.screenshot({ path: resolve(output, "release-context-dark-narrow.png") });
    expect(state.calls.length).toBeGreaterThan(0);
    expect(state.calls.every((method) => method === "GET")).toBe(true);
    expect(state.external).toEqual([]);
    expect(state.errors).toEqual([]);
});

for (const mode of ["empty", "omitted"] as const)
    test(`publication source ${mode} has a distinct truthful empty state`, async ({ page, context }) => {
        const state = await setup(context, mode);
        await page.goto(base);
        const panel = page.getByRole("region", { name: "发布日志与控件趋势" });
        await expect(
            panel.getByText(
                mode === "empty" ? "本期未查到已发布更新日志。" : "发布时间来源未返回，不能推断为没有发布。",
                { exact: true },
            ),
        ).toBeVisible();
        await expect(panel.getByRole("combobox")).toHaveCount(0);
        await expect(panel.locator("canvas")).toHaveCount(0);
        expect(state.errors).toEqual([]);
    });
