import { test, expect, type BrowserContext, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "./fixture";
import {
    emptyMatureSummary,
    matureDepartment,
    matureFixture,
    matureModel,
    maturePerson,
} from "../usage-mature-results-fixture";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";

const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07&uTab=quality";
const output = resolve(import.meta.dirname, "../../../output/usage-mature-results-browser");
async function setup(context: BrowserContext, handle?: (route: Route, scope: UsageV2Scope) => Promise<void>) {
    const calls: Array<{ path: string; method: string; scope: UsageV2Scope | null }> = [],
        errors: string[] = [];
    for (const page of context.pages()) page.on("pageerror", (error) => errors.push(error.message));
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const isMature = url.pathname === "/api/admin/usage/mature-results";
        const generic = isMature ? null : (fixture(url) as any);
        const scope: UsageV2Scope = generic?.meta?.scope ?? {
            from: url.searchParams.get("from")!,
            to: url.searchParams.get("to")!,
            timezone: "Asia/Shanghai",
            compare: (url.searchParams.get("compare") || "previous_period") as UsageV2Scope["compare"],
            departmentBasis: (url.searchParams.get("departmentBasis") || "at_event") as UsageV2Scope["departmentBasis"],
        };
        for (const key of ["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const)
            if (url.searchParams.has(key)) scope[key] = url.searchParams.get(key)!.split(",");
        if (url.searchParams.has("search")) scope.search = url.searchParams.get("search")!;
        calls.push({ path: url.pathname, method: route.request().method(), scope: isMature ? scope : null });
        if (route.request().method() !== "GET")
            return route.fulfill({ status: 405, json: { code: "ISOLATED_READ_ONLY" } });
        if (isMature)
            return handle ? handle(route, scope) : route.fulfill({ json: { code: 0, data: matureFixture(scope) } });
        return route.fulfill({ json: { code: 0, data: generic } });
    });
    await mkdir(output, { recursive: true });
    return { calls, errors, reads: () => calls.filter((call) => call.path === "/api/admin/usage/mature-results") };
}

test("mature result window is explicit, keeps full scope, shows cohort exclusions and partial evidence without reopening global deltas", async ({
    page,
    context,
}) => {
    const state = await setup(context);
    await page.goto(
        `${base}&uBasis=current&uDepartments=${matureDepartment}&uUsers=${maturePerson}&uBoards=image&uModels=${matureModel}&uOperations=image_generation`,
    );
    const section = page.getByTestId("usage-mature-results");
    await expect(section.getByText("尚未读取 7 日成熟结果。", { exact: true })).toBeVisible();
    expect(state.reads()).toHaveLength(0);
    const globalRate = page.locator('[data-usage-metric^="结果使用率："]');
    await expect(globalRate).toContainText("缺少可比数据");
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect(section.getByTestId("usage-mature-data")).toBeVisible();
    expect(state.reads()).toHaveLength(1);
    expect(state.reads()[0]?.scope).toMatchObject({
        departmentBasis: "current",
        departmentIds: [matureDepartment],
        userIds: [maturePerson],
        boardKeys: ["image"],
        modelConfigIds: [matureModel],
        operationTypes: ["image_generation"],
    });
    const cohort = section.getByTestId("usage-mature-cohort");
    await expect(cohort.getByRole("row", { name: /^已满 168 小时的成熟任务/ })).toContainText("7");
    await expect(cohort.getByRole("row", { name: /^尚未成熟/ })).toContainText("1");
    await expect(cohort.getByRole("row", { name: /^缺完成时间/ })).toContainText("1");
    await expect(cohort.getByRole("row", { name: /^时间异常/ })).toContainText("1");
    const evidence = section.getByTestId("usage-mature-evidence");
    await expect(evidence.getByRole("row", { name: /^已记录使用率/ })).toContainText("40.0% · 4 / 10 · 部分覆盖");
    await expect(evidence.getByRole("row", { name: /^正式采纳率/ })).toContainText("20.0% · 2 / 10 · 部分覆盖");
    await expect(evidence.getByRole("row", { name: /^无法绑定资产的结果/ })).toContainText("4");
    await expect(evidence.getByRole("row", { name: /^客户端下载/ })).toContainText("2");
    await expect(evidence.getByRole("row", { name: /^服务端使用/ })).toContainText("3");
    const costs = section.getByTestId("usage-mature-costs");
    await expect(costs.getByRole("row", { name: /^成熟队列已记账金额/ })).toContainText("¥3.000001 · 部分覆盖");
    await expect(costs.getByRole("row", { name: /^成熟队列已记账金额/ })).toContainText("¥0.000000");
    await expect(costs.getByRole("row", { name: /^每已记录使用结果费用/ })).toContainText("¥0.750000 · 部分覆盖");
    await expect(costs.getByRole("row", { name: /^每已记录使用结果费用/ })).toContainText("不可用");
    await expect(section).toContainText("各证据类别可以重叠，不能相加");
    await expect(section).toContainText("第 8 天撤销不抹掉第 7 天证据");
    await expect(section).toContainText("不是已用图片自身成本或供应商实付");
    await expect(globalRate).toContainText("缺少可比数据");
    await section.screenshot({ path: resolve(output, "mature-wide-light.png"), animations: "disabled" });
    await section.getByRole("combobox", { name: "成熟结果分组", exact: true }).click();
    await section.getByRole("combobox", { name: "成熟结果分组", exact: true }).press("ArrowDown");
    await section.getByRole("combobox", { name: "成熟结果分组", exact: true }).press("Enter");
    await expect(section.getByRole("heading", { name: "有明确编译关联 · 结果与费用", exact: true })).toBeVisible();
    await expect(evidence.getByRole("row", { name: /^已记录使用率/ })).toContainText("75.0% · 3 / 4");
    await expect(costs.getByRole("row", { name: /^每已记录使用结果费用/ })).toContainText("¥0.666667");
    expect(state.reads()).toHaveLength(1);
    expect(state.calls.every((call) => call.method === "GET")).toBe(true);
    expect(
        state.calls.every((call) =>
            ["/api/admin/usage/quality", "/api/admin/usage/options", "/api/admin/usage/mature-results"].includes(
                call.path,
            ),
        ),
    ).toBe(true);
    expect(state.errors).toEqual([]);
});

test("mature results fit 390px dark screens and retain unknown output and missing-settlement semantics", async ({
    page,
    context,
}) => {
    const state = await setup(context, async (route, scope) => {
        const data = matureFixture(scope),
            empty = emptyMatureSummary();
        data.current = {
            from: scope.from,
            to: scope.to,
            cohort: {
                successfulImageTasks: 2,
                matureTasks: 2,
                immatureTasks: 0,
                missingCompletedAtTasks: 0,
                invalidTimelineTasks: 0,
            },
            all: {
                ...empty,
                tasks: 2,
                outputKnownTasks: 1,
                missingOutputTasks: 1,
                generatedResults: 1,
                unknownBindingResults: 1,
                cost: { ...empty.cost, missingSettlementTasks: 2 },
            },
            optimizationGroups: [],
        };
        data.current.optimizationGroups = [
            { key: "explicit_link", summary: emptyMatureSummary() },
            { key: "no_explicit_marker", summary: structuredClone(data.current.all) },
        ];
        return route.fulfill({ json: { code: 0, data } });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}&theme=dark&uCompare=none`);
    const section = page.getByTestId("usage-mature-results");
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect(section.getByTestId("usage-mature-data")).toBeVisible();
    await expect(section).toContainText("未启用对比；不补造对比期。");
    await expect(
        section.getByTestId("usage-mature-evidence").getByRole("row", { name: /^已记录使用率/ }),
    ).toContainText("不可用 · 已记录 0 / 已保存 1");
    await expect(
        section.getByTestId("usage-mature-evidence").getByRole("row", { name: /^缺最终输出的成熟任务/ }),
    ).toContainText("1");
    await expect(
        section.getByTestId("usage-mature-costs").getByRole("row", { name: /^成熟队列已记账金额/ }),
    ).toContainText("不可用");
    await expect(section).not.toContainText("0.0%");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await section.screenshot({ path: resolve(output, "mature-narrow-dark.png"), animations: "disabled" });
    expect(state.reads()).toHaveLength(1);
    expect(state.errors).toEqual([]);
});

test("cancel, applied-scope changes, refresh and role changes discard stale mature data without rereads", async ({
    page,
    context,
}) => {
    let hold = true;
    const releases: Array<() => void> = [];
    const state = await setup(context, async (route, scope) => {
        const data = matureFixture(scope);
        data.meta.notes = ["LATE_MATURE_MARKER"];
        if (hold) await new Promise<void>((resolve) => releases.push(resolve));
        await route.fulfill({ json: { code: 0, data } }).catch(() => undefined);
    });
    await page.goto(base);
    const section = page.getByTestId("usage-mature-results");
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect.poll(() => releases.length).toBe(1);
    await section.getByRole("button", { name: "取消成熟窗读取", exact: true }).click();
    releases[0]!();
    await expect(section).toContainText("已取消本次等待");
    await expect(section.getByTestId("usage-mature-data")).toHaveCount(0);
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect.poll(() => releases.length).toBe(2);
    await page.getByLabel("分析开始日期", { exact: true }).fill("2026-10-02");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(section.getByText("尚未读取 7 日成熟结果。", { exact: true })).toBeVisible();
    releases[1]!();
    await expect(page.getByText("LATE_MATURE_MARKER", { exact: true })).toHaveCount(0);
    expect(state.reads()).toHaveLength(2);
    hold = false;
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect(section.getByTestId("usage-mature-data")).toBeVisible();
    expect(state.reads()[2]?.scope?.from).toBe("2026-10-01T16:00:00.000Z");
    await page.getByRole("button", { name: "刷新读取", exact: true }).click();
    await expect(section.getByText("尚未读取 7 日成熟结果。", { exact: true })).toBeVisible();
    expect(state.reads()).toHaveLength(3);
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect(section.getByTestId("usage-mature-data")).toBeVisible();
    await page.evaluate(async () => {
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        useUserStore.setState({ user: { ...useUserStore.getState().user, role: "designer" } });
    });
    await expect(page.getByText("仅超级管理员可访问使用分析", { exact: true })).toBeVisible();
    await expect(section).toHaveCount(0);
    expect(state.reads()).toHaveLength(4);
    expect(state.errors).toEqual([]);
});

test("invalid and failed mature responses stay hidden, show safe errors and only retry after another click", async ({
    page,
    context,
}) => {
    let mode = "invalid";
    const state = await setup(context, async (route, scope) => {
        if (mode === "failed") return route.fulfill({ status: 422, body: "PRIVATE_PROVIDER_ERROR" });
        const data = matureFixture(scope) as any;
        if (mode === "invalid") data.current.all.prompt = "PRIVATE_PROMPT";
        return route.fulfill({ json: { code: 0, data } });
    });
    await page.goto(base);
    const section = page.getByTestId("usage-mature-results");
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect(section).toContainText("成熟窗响应不完整");
    await expect(section.getByTestId("usage-mature-data")).toHaveCount(0);
    expect(state.reads()).toHaveLength(1);
    mode = "failed";
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect(section).toContainText("超过安全读取上限");
    await expect(section).not.toContainText("PRIVATE_");
    expect(state.reads()).toHaveLength(2);
    mode = "valid";
    await section.getByRole("button", { name: "读取 7 日成熟结果", exact: true }).click();
    await expect(section.getByTestId("usage-mature-data")).toBeVisible();
    expect(state.reads()).toHaveLength(3);
    expect(state.errors).toEqual([]);
});

test("non-superadmins cannot load the mature view or issue any analysis requests", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(`${base}&role=designer`);
    await expect(page.getByText("仅超级管理员可访问使用分析", { exact: true })).toBeVisible();
    await expect(page.getByTestId("usage-mature-results")).toHaveCount(0);
    expect(state.calls).toHaveLength(0);
    expect(state.errors).toEqual([]);
});
