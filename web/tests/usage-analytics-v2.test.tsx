import { afterEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readUsageLocation, writeUsageLocation, usageQuery, legacyUsageScope, datePreset } from "../src/pages/admin/usage/filters";
import { comparisonText, excelSafeCell, metricText, alignDailyTrend, perActivePersonCost, snapshotText, pairOptimizationGroups } from "../src/pages/admin/usage/format";
import { MetricCards, Trend } from "../src/pages/admin/usage/components";
import {
    getUsageV2Overview,
    getUsageV2People,
    usageV2QueryString,
    recomputeUsageRollups,
    validUsageRollupJob,
    getUsageV2PeopleComparison,
    type UsageV2Metric,
    type UsageV2Metrics,
    type UsageRollupJob,
    type UsageV2Overview,
    type UsageV2Models,
    type UsageV2Quality,
} from "../src/services/api/usage-analytics-v2";
import { rollupRangeError, comparisonDayRange } from "../src/pages/admin/usage/rollup-state";
import Overview from "../src/pages/admin/usage/overview";
import Models from "../src/pages/admin/usage/models";
import Quality from "../src/pages/admin/usage/quality";
import { fixture } from "./usage-v2-browser/fixture";
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});
const metric: UsageV2Metric = { value: 0.4, unit: "ratio", state: "partial", availableCount: 5, missingCount: 2, definitionId: "test", definition: "合成测试口径", source: "fixture" };

test("all six views restore one exact shared scope while retaining parent routing parameters", () => {
    const source = new URLSearchParams("tab=usage-analysis&unrelated=retained&uTab=models&uFrom=2026-10-01&uTo=2026-10-31&uCompare=previous_year&uBasis=current&uDepartments=d1,d2&uUsers=p1&uBoards=canvas-image,image&uModels=m1&uOperations=generate");
    const state = readUsageLocation(source);
    const written = writeUsageLocation(source, state.filters, "people", "p1");
    expect(written.get("unrelated")).toBe("retained");
    expect(readUsageLocation(written)).toEqual({ filters: state.filters, tab: "people", personId: "p1" });
    expect(usageQuery(state.filters)).toMatchObject({
        from: "2026-09-30T16:00:00.000Z",
        to: "2026-10-31T16:00:00.000Z",
        compare: "previous_year",
        departmentBasis: "current",
        departmentIds: ["d1", "d2"],
        boardKeys: ["canvas-image", "image"],
        operationTypes: ["generate"],
    });
});
test("Beijing date boundaries, leap days and invalid ranges are explicit", () => {
    const base = readUsageLocation(new URLSearchParams(), new Date("2026-11-03T17:00:00Z")).filters;
    expect(datePreset(1, new Date("2026-11-03T17:00:00Z"))).toEqual({ from: "2026-11-04", to: "2026-11-04" });
    for (const change of [{ from: "2026-02-30" }, { from: "2026-11-31" }, { from: "2026-12-01", to: "2026-11-01" }, { from: "" }]) expect(() => usageQuery({ ...base, ...change })).toThrow();
    expect(usageQuery({ ...base, from: "2024-02-29", to: "2024-02-29" }).to).toBe("2024-02-29T16:00:00.000Z");
});
test("legacy export / AI never silently drop unsupported filters", () => {
    const query = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z", userIds: ["p1"], boardKeys: ["image"], modelConfigIds: ["m1"] };
    expect(legacyUsageScope(query).filters).toEqual({ from: query.from, to: query.to, userIds: ["p1"], boardKey: "image", modelConfigId: "m1" });
    for (const extra of [{ departmentIds: ["d1"] }, { boardKeys: ["image", "canvas-image"] }, { modelConfigIds: ["m1", "m2"] }, { operationTypes: ["generate"] }]) expect(legacyUsageScope({ ...query, ...extra }).filters).toBeNull();
});
test("missing, exact monetary values and ratio percentage points are not misrepresented", () => {
    expect(metricText({ ...metric, value: null, state: "unavailable" })).toBe("不可用");
    expect(metricText(metric)).toBe("40.0%");
    expect(metricText({ ...metric, unit: "CNY", value: 0.1, amount: "0.100001" })).toBe("¥0.100001");
    expect(comparisonText({ ...metric, comparison: { value: 0.34, absoluteDelta: 6, relativeDelta: null, unit: "percentage_points" } })).toBe("较对比期 +6.0 个百分点");
    expect(comparisonText({ ...metric, comparison: { value: 0, absoluteDelta: 2, relativeDelta: null, unit: "absolute", reason: "zero_baseline" } })).toContain("对比期为 0");
});
test("sparse daily comparison uses calendar offsets, preserving gaps as null", () => {
    const metrics = { generatedImages: metric } as UsageV2Metrics;
    const rows = alignDailyTrend(
        [
            { day: "2026-11-01", metrics },
            { day: "2026-11-03", metrics },
        ],
        [
            { day: "2026-10-29", metrics },
            { day: "2026-10-31", metrics },
        ],
        "2026-10-31T16:00:00Z",
        "2026-11-03T16:00:00Z",
        "2026-10-28T16:00:00Z",
    );
    expect(rows.map((row) => row.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(rows[1]!.current).toBeUndefined();
    expect(rows[1]!.previous).toBeUndefined();
    expect(rows[2]!.previous?.day).toBe("2026-10-31");
});
test("Excel strings are formula-injection safe without altering numeric values", () => {
    for (const value of ['=HYPERLINK("https://invalid")', "+SUM(A1)", "-1+2", "@SUM(A1)", " \t=cmd", "\r\n=1", "\u0001=1"]) expect(String(excelSafeCell(value))).toStartWith("'");
    expect(excelSafeCell(-12.5)).toBe(-12.5);
    expect(excelSafeCell("设计一部")).toBe("设计一部");
    expect(excelSafeCell(null)).toBe("不可用");
});
test("a comparison-only period still renders the trend instead of discarding historical data", () => {
    const html = renderToStaticMarkup(
        <Trend daily={[]} comparisonDaily={[{ day: "2026-10-31", metrics: { generatedImages: metric } as UsageV2Metrics }]} from="2026-10-31T16:00:00Z" to="2026-11-01T16:00:00Z" comparisonFrom="2026-10-30T16:00:00Z" onDrilldown={() => undefined} />,
    );
    expect(html).not.toContain("当前筛选没有可展示记录");
    expect(html).toContain("data-usage-chart-loading");
});
test("metric component displays missing coverage and keeps formal adoption separate", () => {
    const html = renderToStaticMarkup(
        <MetricCards metrics={{ resultUseRate: metric, formalAdoptionRate: { ...metric, value: 0.1 }, activeSeconds: { ...metric, value: null, state: "unavailable" } } as UsageV2Metrics} keys={["resultUseRate", "formalAdoptionRate", "activeSeconds"]} />,
    );
    expect(html).toContain("结果使用率");
    expect(html).toContain("正式采纳率");
    expect(html).toContain("40.0%");
    expect(html).toContain("10.0%");
    expect(html).toContain("不可用");
    expect(html).toContain("部分覆盖");
    expect(html).not.toContain("0 分钟");
});
test("v2 reads apply arrays, server pagination and sorting with no-store credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return Response.json({ code: 0, data: { ok: true } });
    }) as typeof fetch;
    await getUsageV2People({ departmentIds: ["d1", "d2"], userIds: ["p1"], boardKeys: ["image"], modelConfigIds: ["m1"], page: 2, pageSize: 20, sort: "activeDays", order: "asc", compare: "previous_year" });
    expect(Object.fromEntries(new URL(calls[0]!.url, "https://localhost").searchParams)).toMatchObject({
        departmentIds: "d1,d2",
        userIds: "p1",
        boardKeys: "image",
        modelConfigIds: "m1",
        page: "2",
        sort: "activeDays",
        order: "asc",
        compare: "previous_year",
    });
    expect(calls[0]!.init).toMatchObject({ credentials: "include", cache: "no-store" });
    expect(usageV2QueryString({ userIds: [] })).toBe("");
});
test("oversized scope is actionable and raw server errors never leak", async () => {
    globalThis.fetch = (async () => Response.json({ error: "PRIVATE_SECRET" }, { status: 422 })) as typeof fetch;
    await expect(getUsageV2Overview({})).rejects.toThrow("缩短日期");
    globalThis.fetch = (async () => Response.json({ error: "PRIVATE_SECRET" }, { status: 503 })) as typeof fetch;
    await expect(getUsageV2Overview({})).rejects.toThrow("使用分析暂不可用");
});

const job: UsageRollupJob = {
    jobId: "00000000-0000-4000-8000-000000000010",
    status: "queued",
    fromDay: "2026-10-01",
    toDay: "2026-10-02",
    completedDays: [],
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    completedAt: null,
    failureCode: null,
};
test("rollup accepts at most 31 real past/current Beijing dates, never silently truncates", () => {
    const now = new Date("2026-11-03T17:00:00Z");
    expect(rollupRangeError({ fromDay: "2026-10-01", toDay: "2026-10-31" }, now)).toBe("");
    expect(rollupRangeError({ fromDay: "2026-10-01", toDay: "2026-11-01" }, now)).toContain("31 天");
    expect(rollupRangeError({ fromDay: "2026-11-04", toDay: "2026-11-04" }, now)).toBe("");
    expect(rollupRangeError({ fromDay: "2026-11-04", toDay: "2026-11-05" }, now)).toContain("未来");
    expect(rollupRangeError({ fromDay: "2026-02-30", toDay: "2026-03-01" }, now)).toContain("有效");
    const filters = readUsageLocation(new URLSearchParams("uFrom=2024-02-29&uTo=2024-02-29&uCompare=previous_year")).filters;
    expect(comparisonDayRange(filters)).toEqual({ fromDay: "2023-02-28", toDay: "2023-02-28" });
    expect(comparisonDayRange({ ...filters, from: "2026-10-01", to: "2026-10-07", compare: "previous_period" })).toEqual({ fromDay: "2026-09-24", toDay: "2026-09-30" });
});
test("rollup receipt validation refuses incomplete completion, malformed IDs and duplicate days", () => {
    expect(validUsageRollupJob(job)).toBe(true);
    expect(validUsageRollupJob({ ...job, status: "completed", completedDays: [job.fromDay], completedAt: job.updatedAt })).toBe(false);
    expect(validUsageRollupJob({ ...job, status: "completed", completedDays: [job.fromDay, job.toDay], completedAt: job.updatedAt })).toBe(true);
    expect(validUsageRollupJob({ ...job, jobId: "-".repeat(36) })).toBe(false);
    expect(validUsageRollupJob({ ...job, completedDays: [job.fromDay, job.fromDay] })).toBe(false);
    expect(validUsageRollupJob({ ...job, completedDays: ["2026-09-30"] })).toBe(false);
});
test("rollup POST reuses exactly the supplied request key and validates returned dates", async () => {
    const request = { fromDay: job.fromDay, toDay: job.toDay, idempotencyKey: "00000000-0000-4000-8000-000000000011" };
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_, init) => {
        expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "include" });
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ code: 0, data: job }, { status: 202 });
    }) as typeof fetch;
    await recomputeUsageRollups(request);
    await recomputeUsageRollups(request);
    expect(bodies).toEqual([request, request]);
    globalThis.fetch = (async () => Response.json({ code: 0, data: { ...job, toDay: "2026-10-03" } })) as typeof fetch;
    await expect(recomputeUsageRollups(request)).rejects.toThrow("日期不匹配");
});
test("missing daily facts retain the typed 409 code without exposing arbitrary server messages", async () => {
    globalThis.fetch = (async () => Response.json({ code: "USAGE_ROLLUP_REFRESH_REQUIRED", msg: "PRIVATE_SECRET" }, { status: 409 })) as typeof fetch;
    await expect(getUsageV2Overview({})).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED", status: 409 });
    await expect(getUsageV2Overview({})).rejects.toThrow("待回填");
});

test("disabled rollup keeps its explicit no-new-job code without exposing server text", async () => {
    const request = { fromDay: job.fromDay, toDay: job.toDay, idempotencyKey: "00000000-0000-4000-8000-000000000011" };
    globalThis.fetch = (async () => Response.json({ code: "USAGE_ROLLUP_NOT_ENABLED", msg: "PRIVATE_SECRET" }, { status: 503 })) as typeof fetch;
    await expect(recomputeUsageRollups(request)).rejects.toMatchObject({ code: "USAGE_ROLLUP_NOT_ENABLED", status: 503, message: "统计刷新尚未启用；未创建刷新任务。请等待运维启用后，再明确发起刷新。" });
    globalThis.fetch = (async () => Response.json({ code: "UNKNOWN_503", msg: "PRIVATE_SECRET" }, { status: 503 })) as typeof fetch;
    await expect(recomputeUsageRollups(request)).rejects.toMatchObject({ code: "V2_REQUEST_FAILED", status: 503 });
});
test("person comparison fetches exact IDs once, retains scope, rejects absent people and never fills zero", async () => {
    const query = { from: "2026-09-30T16:00:00.000Z", to: "2026-10-07T16:00:00.000Z", compare: "none" as const, departmentBasis: "at_event" as const, boardKeys: ["canvas"] };
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000004"];
    const urls: URL[] = [];
    globalThis.fetch = (async (input) => {
        const url = new URL(String(input), "http://localhost");
        urls.push(url);
        const data = fixture(url) as any;
        data.pagination = { page: 1, pageSize: 5, total: 2 };
        return Response.json({ code: 0, data });
    }) as typeof fetch;
    const result = await getUsageV2PeopleComparison(query, ids);
    expect(urls).toHaveLength(1);
    expect(result.people.map((p) => p.userId)).toEqual(ids);
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({ boardKeys: "canvas", userIds: ids.join(","), pageSize: "5", page: "1" });
    globalThis.fetch = (async () => Response.json({ code: 0, data: { ...result, people: result.people.slice(0, 1), pagination: { page: 1, pageSize: 5, total: 1 } } })) as typeof fetch;
    await expect(getUsageV2PeopleComparison(query, ids)).rejects.toThrow("未完整返回");
    await expect(getUsageV2PeopleComparison({ ...query, userIds: [ids[0]!] }, ids)).rejects.toThrow("当前筛选范围");
});
test("department denominator and multi-day freshness are explicit and missing denominators are not zero", () => {
    const data = fixture(new URL("http://localhost/api/admin/usage/overview")) as UsageV2Overview;
    expect(perActivePersonCost(data.metrics)).toMatchObject({ value: 6.3, denominator: 2 });
    expect(perActivePersonCost({ ...data.metrics, activePeople: { ...data.metrics.activePeople, value: 0 } })).toMatchObject({ value: null, state: "unavailable" });
    expect(snapshotText(data.meta)).toContain("混合刷新时点，不是统一观察快照");
    expect(snapshotText(data.meta)).toContain("7,500 秒");
    const html = renderToStaticMarkup(<Overview data={data} onDrilldown={() => undefined} />);
    for (const label of ["首次处理等待 P50", "首次处理到完成 P50", "提交到完成 P90", "单张已使用图成本", "不是部门编制人数"]) expect(html).toContain(label);
});
test("hybrid freshness separates transaction-observed today from historical daily snapshots", () => {
    const data = fixture(new URL("http://localhost/api/admin/usage/overview")) as UsageV2Overview;
    data.meta = { ...data.meta, dataMode: "daily_history_live_today", liveFrom: "2026-11-03T16:00:00.000Z", asOf: "2026-11-04T03:00:00.000Z" };
    const mixed = snapshotText(data.meta);
    expect(mixed).toContain("今日实时");
    expect(mixed).toContain("历史日事实");
    expect(mixed).toContain("7,500 秒");
    expect(mixed).toContain("混合刷新时点，不是统一观察快照");
    const todayOnly = snapshotText({ ...data.meta, snapshot: undefined, lagSeconds: 0 });
    expect(todayOnly).toContain("未包含历史日");
    expect(todayOnly).not.toContain("最旧快照");
});
test("model and optimization quality expose tokens, adoption, timing and paired sample counts", () => {
    const models = fixture(new URL("http://localhost/api/admin/usage/models")) as UsageV2Models;
    const modelHtml = renderToStaticMarkup(<Models data={models} onDrilldown={() => undefined} />);
    for (const label of ["优化输入 Token", "优化输出 Token", "正式采纳率", "提交到完成 P90", "模型气泡横轴", "模型气泡纵轴"]) expect(modelHtml).toContain(label);
    const quality = fixture(new URL("http://localhost/api/admin/usage/quality")) as UsageV2Quality;
    const paired = pairOptimizationGroups(quality.optimizationComparison);
    expect(paired).toHaveLength(1);
    expect(paired[0]?.optimized?.generationRequests.value).toBe(30);
    expect(paired[0]?.unmarked?.generationRequests.value).toBe(10);
    const html = renderToStaticMarkup(<Quality data={quality} onDrilldown={() => undefined} />);
    for (const label of ["有优化关联组", "无优化标记组", "任务样本", "正式采纳率", "不代表优化产生了因果效果"]) expect(html).toContain(label);
});
