import { test, expect, type BrowserContext, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "./fixture";
import { compilationDepartment, compilationFixture, compilationPerson, emptyCompilationSummary } from "../usage-compilation-analysis-fixture";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";

const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07&uTab=models";
const output = resolve(import.meta.dirname, "../../../output/usage-compilation-browser");
type CompilationHandler = (route: Route, scope: UsageV2Scope) => Promise<void>;
async function setup(context: BrowserContext, handle?: CompilationHandler) {
    const calls: Array<{ path: string; method: string; scope: UsageV2Scope | null }> = [], errors: string[] = [];
    for (const page of context.pages()) page.on("pageerror", error => errors.push(error.message));
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const generic = url.pathname.endsWith("/compilations") ? null : fixture(url) as any;
        const scope: UsageV2Scope = generic?.meta?.scope ?? {
            from: url.searchParams.get("from")!, to: url.searchParams.get("to")!, timezone: "Asia/Shanghai",
            compare: (url.searchParams.get("compare") || "previous_period") as UsageV2Scope["compare"],
            departmentBasis: (url.searchParams.get("departmentBasis") || "at_event") as UsageV2Scope["departmentBasis"],
        };
        for (const key of ["userIds", "departmentIds", "boardKeys", "modelConfigIds", "operationTypes"] as const) {
            if (url.searchParams.has(key)) scope[key] = url.searchParams.get(key)!.split(",");
        }
        if (url.searchParams.has("search")) scope.search = url.searchParams.get("search")!;
        calls.push({ path: url.pathname, method: route.request().method(), scope: url.pathname.endsWith("/compilations") ? scope : null });
        if (route.request().method() !== "GET") return route.fulfill({ status: 405, json: { code: "ISOLATED_READ_ONLY" } });
        if (url.pathname.endsWith("/compilations")) {
            if (handle) return handle(route, scope);
            return route.fulfill({ json: { code: 0, data: compilationFixture(scope) } });
        }
        return route.fulfill({ json: { code: 0, data: generic } });
    });
    await mkdir(output, { recursive: true });
    return { calls, errors, reads: () => calls.filter(call => call.path.endsWith("/compilations")) };
}

test("compilation groups load explicitly, keep separate statuses and null-aware costs, and fit light/dark narrow views", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(`${base}&uBasis=current&uDepartments=${compilationDepartment}&uUsers=${compilationPerson}`);
    const section = page.getByTestId("usage-compilation-analysis");
    await expect(section.getByText("尚未读取独立编译统计。", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "当前筛选任务关联编译 · 独立费用", exact: true })).toBeVisible();
    expect(state.reads()).toHaveLength(0);
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section.getByTestId("usage-compilation-results")).toBeVisible();
    expect(state.reads()).toHaveLength(1);
    expect(state.reads()[0]?.scope).toMatchObject({ departmentBasis: "current", departmentIds: [compilationDepartment], userIds: [compilationPerson] });
    await expect(section.getByTestId("usage-compilation-group-all")).toContainText("9 条本期编译记录");
    await expect(section.getByTestId("usage-compilation-group-linked")).toContainText("5 条本期编译记录");
    await expect(section.getByTestId("usage-compilation-group-unlinked")).toContainText("4 条本期编译记录");
    await expect(section.getByTestId("usage-compilation-group-all")).toContainText("本期管理员测试：是 2 · 否 4 · 未知 3");
    await expect(section.getByTestId("usage-compilation-group-all")).toContainText("对比期管理员测试：是 0 · 否 1 · 未知 0");
    await expect(section.getByTestId("usage-compilation-cache").getByRole("row", { name: /^非缓存源调用记录/ })).toContainText("5");
    const stateRows = section.getByTestId("usage-compilation-statuses");
    await expect(stateRows.getByRole("row", { name: /^失败 / })).toContainText("1");
    await expect(stateRows.getByRole("row", { name: /^待核查 / })).toContainText("3");
    const money = section.getByTestId("usage-compilation-costs");
    await expect(money.getByRole("row", { name: /^本期 CNY/ })).toContainText("0.000000");
    await expect(money.getByRole("row", { name: /^本期 CNY/ })).toContainText("0.120000");
    await expect(money.getByRole("row", { name: /^本期 未知/ })).toContainText("不可用");
    await expect(money.getByRole("row", { name: /^对比期 USD/ })).toContainText("0.010000");
    await expect(section).toContainText("不证明供应商已接受或扣费");
    await expect(section).toContainText("成功可能包含基础模板回退");
    await section.screenshot({ path: resolve(output, "compilation-wide-light.png"), animations: "disabled" });
    await section.getByRole("combobox", { name: "编译分组详情", exact: true }).click();
    await section.getByRole("combobox", { name: "编译分组详情", exact: true }).press("ArrowDown");
    await section.getByRole("combobox", { name: "编译分组详情", exact: true }).press("ArrowDown");
    await section.getByRole("combobox", { name: "编译分组详情", exact: true }).press("Enter");
    await expect(section.getByRole("heading", { name: "当前未关联任务 · 分组明细", exact: true })).toBeVisible();
    await expect(section.getByTestId("usage-compilation-coverage").getByRole("row", { name: /^源调用输入 Token/ })).toContainText("不可用 · 可用 0 / 缺失 2");
    expect(state.reads()).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}&theme=dark`);
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section.getByTestId("usage-compilation-results")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await section.screenshot({ path: resolve(output, "compilation-narrow-dark.png"), animations: "disabled" });
    expect(state.calls.every(call => call.method === "GET")).toBe(true);
    expect(state.calls.every(call => ["/api/admin/usage/models", "/api/admin/usage/options", "/api/admin/usage/compilations"].includes(call.path))).toBe(true);
    expect(state.errors).toEqual([]);
});

test("unsupported shared dimensions stay selected and never issue compilation requests", async ({ page, context }) => {
    const state = await setup(context);
    for (const [query, reason] of [
        [`uBasis=at_event&uDepartments=${compilationDepartment}`, "事件时部门"], ["uBoards=image", "板块"],
        [`uModels=${compilationPerson}`, "生成模型"], ["uOperations=image_generation", "操作类型"],
    ]) {
        await page.goto(`${base}&${query}`);
        const section = page.getByTestId("usage-compilation-analysis");
        await expect(section.getByText("当前共享筛选不支持独立编译口径", { exact: true })).toBeVisible();
        await expect(section).toContainText(`不支持：${reason}`);
        await expect(section.getByRole("button", { name: "读取独立编译统计", exact: true })).toBeDisabled();
        for (const [key, value] of new URLSearchParams(query)) expect(new URL(page.url()).searchParams.get(key)).toBe(value);
    }
    expect(state.reads()).toHaveLength(0);
    expect(state.errors).toEqual([]);
});

test("cancel, applied-scope change, refresh and role changes discard pending or loaded statistics without automatic rereads", async ({ page, context }) => {
    let hold = true;
    const releases: Array<() => void> = [];
    const state = await setup(context, async (route, scope) => {
        const data = compilationFixture(scope); data.meta.notes = ["LATE_COMPILATION_MARKER"];
        if (hold) await new Promise<void>(resolve => releases.push(resolve));
        await route.fulfill({ json: { code: 0, data } }).catch(() => undefined);
    });
    await page.goto(base);
    const section = page.getByTestId("usage-compilation-analysis");
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect.poll(() => releases.length).toBe(1);
    await section.getByRole("button", { name: "取消编译统计读取", exact: true }).click(); releases[0]!();
    await expect(section).toContainText("已取消本次等待");
    await expect(section.getByTestId("usage-compilation-results")).toHaveCount(0);
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect.poll(() => releases.length).toBe(2);
    await page.getByLabel("分析开始日期", { exact: true }).fill("2026-10-02");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(section.getByText("尚未读取独立编译统计。", { exact: true })).toBeVisible(); releases[1]!();
    await expect(page.getByText("LATE_COMPILATION_MARKER", { exact: true })).toHaveCount(0);
    expect(state.reads()).toHaveLength(2);
    hold = false;
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section.getByTestId("usage-compilation-results")).toBeVisible();
    expect(state.reads()[2]?.scope?.from).toBe("2026-10-01T16:00:00.000Z");
    await page.getByRole("button", { name: "刷新读取", exact: true }).click();
    await expect(section.getByText("尚未读取独立编译统计。", { exact: true })).toBeVisible();
    expect(state.reads()).toHaveLength(3);
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section.getByTestId("usage-compilation-results")).toBeVisible();
    await page.evaluate(async () => {
        const module = await import("/src/stores/use-user-store.ts");
        const store = module.useUserStore;
        store.setState({ user: { ...store.getState().user, role: "designer" } });
    });
    await expect(page.getByText("仅超级管理员可访问使用分析", { exact: true })).toBeVisible();
    await expect(section).toHaveCount(0);
    expect(state.reads()).toHaveLength(4);
    expect(state.errors).toEqual([]);
});

test("malformed or failed responses show safe errors and require a new explicit retry", async ({ page, context }) => {
    let mode = "malformed";
    const state = await setup(context, async (route, scope) => {
        if (mode === "failed") return route.fulfill({ status: 503, body: "PRIVATE_PROVIDER_ERROR" });
        const data = compilationFixture(scope) as any;
        if (mode === "malformed") data.current.all.prompt = "PRIVATE_COMPILATION_PROMPT";
        return route.fulfill({ json: { code: 0, data } });
    });
    await page.goto(base);
    const section = page.getByTestId("usage-compilation-analysis");
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section).toContainText("编译分析响应不完整");
    await expect(section.getByTestId("usage-compilation-results")).toHaveCount(0);
    expect(state.reads()).toHaveLength(1);
    mode = "failed";
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section).toContainText("读取未完成");
    await expect(section).not.toContainText("PRIVATE_");
    expect(state.reads()).toHaveLength(2);
    mode = "valid";
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section.getByTestId("usage-compilation-results")).toBeVisible();
    expect(state.reads()).toHaveLength(3);
    expect(state.errors).toEqual([]);
});

test("empty source-call coverage remains unavailable and disabled comparison is never filled with zero", async ({ page, context }) => {
    const state = await setup(context, async (route, scope) => {
        const data = compilationFixture(scope);
        data.current = { from: scope.from, to: scope.to, all: emptyCompilationSummary(), linked: emptyCompilationSummary(), unlinked: emptyCompilationSummary() };
        return route.fulfill({ json: { code: 0, data } });
    });
    await page.goto(`${base}&uCompare=none`);
    const section = page.getByTestId("usage-compilation-analysis");
    await section.getByRole("button", { name: "读取独立编译统计", exact: true }).click();
    await expect(section.getByTestId("usage-compilation-group-all")).toContainText("0 条本期编译记录");
    await expect(section).toContainText("未启用对比；不补造对比期。");
    await expect(section.getByTestId("usage-compilation-coverage").getByRole("row", { name: /^源调用输入 Token/ })).toContainText("不可用 · 可用 0 / 缺失 0");
    await expect(section.getByTestId("usage-compilation-coverage").getByRole("row", { name: /^源调用平均耗时/ })).toContainText("不可用 · 可用 0 / 缺失 0");
    await expect(section.getByTestId("usage-compilation-costs")).toContainText("当前分组没有源调用费用记录；金额不可用，不补零。");
    expect(state.reads()).toHaveLength(1);
    expect(state.errors).toEqual([]);
});
