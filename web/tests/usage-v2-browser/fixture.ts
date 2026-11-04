import { metricLabels } from "../../src/pages/admin/usage/format";
import type { UsageV2Metric, UsageV2Metrics, UsageV2Scope } from "../../../shared/usage-analytics-v2";
export const personId = "00000000-0000-4000-8000-000000000001",
    departmentId = "00000000-0000-4000-8000-000000000002",
    modelId = "00000000-0000-4000-8000-000000000003";
export function fixture(url: URL) {
    const scope: UsageV2Scope = {
        from: url.searchParams.get("from") || "2026-09-30T16:00:00.000Z",
        to: url.searchParams.get("to") || "2026-10-07T16:00:00.000Z",
        timezone: "Asia/Shanghai",
        compare: (url.searchParams.get("compare") || "previous_period") as UsageV2Scope["compare"],
        departmentBasis: (url.searchParams.get("departmentBasis") || "at_event") as UsageV2Scope["departmentBasis"],
    };
    for (const key of ["departmentIds", "userIds", "boardKeys", "modelConfigIds", "operationTypes"] as const) {
        if (url.searchParams.has(key)) scope[key] = url.searchParams.get(key)!.split(",");
    }
    const metric = (value: number | null, unit: UsageV2Metric["unit"] = "count", state: UsageV2Metric["state"] = value === null ? "unavailable" : "available"): UsageV2Metric => ({
        value,
        unit,
        state,
        availableCount: value === null ? 0 : 20,
        missingCount: value === null ? 20 : state === "partial" ? 4 : 0,
        definitionId: "isolated-synthetic-v1",
        definition: value === null ? "隔离样例：历史未采集足够的稳定关联，不能反推真实时长或路径。" : "隔离合成测试样例，不代表生产结果。",
        source: "browser_fixture",
        ...(value !== null
            ? { comparison: { value: value * 0.8, absoluteDelta: unit === "ratio" ? value * 0.2 * 100 : value * 0.2, relativeDelta: unit === "ratio" ? null : 0.25, unit: unit === "ratio" ? ("percentage_points" as const) : ("absolute" as const) } }
            : {}),
    });
    const metrics = Object.fromEntries(Object.keys(metricLabels).map((key) => [key, metric(20)])) as UsageV2Metrics;
    Object.assign(metrics, {
        activePeople: metric(2),
        activeDays: metric(5),
        generatedImages: metric(42),
        generationRequests: metric(30),
        succeeded: metric(27),
        failed: metric(3),
        successRate: metric(0.9, "ratio"),
        generationBookedCny: { ...metric(12.6, "CNY"), amount: "12.600000", currency: "CNY", basis: "booked" },
        resultUseRate: metric(0.4, "ratio", "partial"),
        formalAdoptionRate: metric(0.1, "ratio", "partial"),
        totalMsP50: metric(25000, "ms"),
        totalMsP90: metric(90000, "ms"),
        waitMsP50: metric(3000, "ms"),
        runMsP50: metric(22000, "ms"),
        activeSeconds: metric(null, "seconds"),
        revisionRounds: metric(null),
    });
    const from = new Date(scope.from),
        to = new Date(scope.to),
        days = Math.ceil((+to - +from) / 86400000);
    for (const key of ["resultUseRate", "formalAdoptionRate", "costPerUsedImage"] as const)
        metrics[key].comparison = { value: 0.3, absoluteDelta: null, relativeDelta: null, reason: "insufficient_data", unit: key === "costPerUsedImage" ? "absolute" : "percentage_points" };
    metrics.costPerImage = metric(0.3, "CNY");
    metrics.costPerUsedImage = { ...metrics.costPerUsedImage, unit: "CNY", value: 0.74, state: "partial" };
    const priorFrom = new Date(+from - days * 86400000).toISOString();
    const meta = {
        schemaVersion: 2,
        metricVersion: "isolated-fixture-v1",
        scope,
        comparisonScope: scope.compare === "none" ? null : { ...scope, from: priorFrom, to: scope.from },
        asOf: "2026-11-04T04:00:00Z",
        computedThrough: "2026-11-04T02:00:00Z",
        provisional: true,
        dataMode: "persisted_daily_facts",
        lagSeconds: 7500,
        snapshot: { oldestComputedAt: "2026-11-04T02:00:00Z", newestComputedAt: "2026-11-04T04:00:00Z", dayCount: days, mixedSnapshots: true },
        coverage: [
            { metric: "resultUseRate", state: "partial", since: null, eligible: 42, matched: 30, unknown: 12, notes: ["合成样例：部分结果缺少关联。"] },
            { metric: "activeSeconds", state: "unavailable", since: null, eligible: 2, matched: 0, unknown: 2, notes: ["历史时长未采集。"] },
        ],
        notes: ["浏览器隔离验证：所有记录均为合成样例，不连接生产。"],
    };
    const daysRows = (start: number) => Array.from({ length: Math.min(days, 7) }, (_, i) => ({ day: new Date(start + i * 86400000 + 8 * 3600000).toISOString().slice(0, 10), metrics: { ...metrics, generatedImages: metric(3 + i * 2) } }));
    const daily = daysRows(+from),
        comparisonDaily = daysRows(+new Date(priorFrom));
    const hourlyHeatmap = Array.from({ length: 7 * 24 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24, count: i % 24 >= 9 && i % 24 <= 18 ? 1 + (i % 8) : 0 }));
    const dimension = (key: string, label: string) => ({ key, label, metrics });
    const boards = [dimension("canvas", "画布"), dimension("image", "图片生成")],
        models = [dimension(modelId, "隔离图像模型")];
    const person = {
        userId: personId,
        displayName: "测试设计师甲",
        departmentId,
        departmentName: "隔离设计部",
        metrics,
        lastActivityAt: "2026-10-07T02:00:00Z",
        topBoards: [{ key: "canvas", label: "画布", count: 20 }],
        topModels: [{ key: modelId, label: "隔离图像模型", count: 20 }],
    };
    const pagination = { page: Number(url.searchParams.get("page") || 1), pageSize: 20, total: 41 };
    const resultUse = {
        basis: "submitted_cohort_as_of",
        asOf: meta.asOf,
        ruleVersion: "fixture-result-v1",
        generatedImages: 42,
        linkedImages: 30,
        unlinkedImages: 12,
        usedImages: 17,
        formallyAdoptedImages: 4,
        stages: [
            { key: "downloaded", label: "下载开始回执", count: 15, evidence: "client_reported" },
            { key: "project", label: "加入项目", count: 9, evidence: "server_confirmed" },
            { key: "adopted", label: "正式采纳", count: 4, evidence: "server_confirmed" },
        ],
        notes: ["阶段可以跳步，不是单调漏斗；下载回执不证明操作系统落盘。"],
    };
    const parameters = [
        { boardKey: "image", boardLabel: "图片生成", parameter: "quality", value: "high", count: 12, eligible: 20, missing: 4, rate: { ...metric(0.75, "ratio", "partial"), availableCount: 16, missingCount: 4, denominator: 16 } },
        { boardKey: "image", boardLabel: "图片生成", parameter: "quality", value: "low", count: 4, eligible: 20, missing: 4, rate: { ...metric(0.25, "ratio", "partial"), availableCount: 16, missingCount: 4, denominator: 16 } },
        { boardKey: "canvas", boardLabel: "画布", parameter: "aspectRatio", value: null, count: 0, eligible: 10, missing: 10, rate: { ...metric(null, "ratio"), availableCount: 0, missingCount: 10, denominator: 0 } },
    ];
    const common = { meta, metrics, insights: [] };
    const path = url.pathname;
    if (path.endsWith("/options"))
        return {
            departments: [{ id: departmentId, name: "隔离设计部" }],
            people: [{ id: personId, name: "测试设计师甲", departmentId }],
            boards: boards.map(({ key, label }) => ({ key, label })),
            models: [{ id: modelId, name: "隔离图像模型" }],
            operationTypes: ["generate", "edit"],
            peoplePagination: pagination,
            notes: [],
        };
    if (path.endsWith("/overview")) return { ...common, daily, comparisonDaily, hourlyHeatmap, departments: [dimension(departmentId, "隔离设计部")] };
    if (path.endsWith("/people-v2")) return { ...common, people: [person, { ...person, userId: "00000000-0000-4000-8000-000000000004", displayName: "测试设计师乙" }], pagination };
    if (path.endsWith("/profile"))
        return {
            ...common,
            person,
            daily,
            hourlyHeatmap,
            boards,
            models,
            habits: {
                rates: [
                    { key: "batchLinked", label: "批次关联任务占比", eligible: 30, matched: 6, missing: 0, rate: { ...metric(0.2, "ratio"), denominator: 30, definition: "批次ID存在性；一任务多图不等于批量。" } },
                    { key: "optimizedMarked", label: "有优化标记任务占比", eligible: 30, matched: 12, missing: 0, rate: { ...metric(0.4, "ratio"), denominator: 30, definition: "只计算true标记；false不证明未优化。" } },
                    { key: "inpaint", label: "明确局部重绘任务占比", eligible: 26, matched: 3, missing: 2, rate: { ...metric(0.125, "ratio", "partial"), denominator: 24, definition: "明确inpaint / 已知图片操作；非图像操作排除。" } },
                ],
                referenceCounts: { eligible: 24, missing: 4, items: [{ value: 0, count: 8, rate: metric(0.4, "ratio", "partial") }, { value: 2, count: 12, rate: metric(0.6, "ratio", "partial") }] },
                parameters,
                notes: ["合成隔离记录，不推断能力或工时。", "提交的参考项数不去重，不推断不同图片数；非图像操作排除。"],
            },
            activityPage: {
                records: [{ id: "fixture-task-1", kind: "task", occurredAt: "2026-10-07T02:00:00Z", boardKey: "canvas", action: "generate", modelConfigId: modelId, status: "success", generatedImages: 2, bookedCny: "0.600000", totalMs: 25000 }],
                pagination,
            },
        };
    if (path.endsWith("/boards"))
        return {
            ...common,
            boards,
            parameters,
            controlUsage: [{ boardKey: "canvas", controlKey: "submit", label: "提交生成", users: 2, eligibleUsers: 2, rate: metric(1, "ratio") }],
            conversion: metric(null),
            abandonment: metric(null),
        };
    if (path.endsWith("/models"))
        return {
            ...common,
            models: [{ ...models[0], modelConfigId: modelId, operationType: "generate", boardKey: "canvas", latency: { eligible: 20, available: 18, missing: 2, unit: "ms", method: "full_sample_linear_interpolation", min: 1000, q1: 10000, median: 25000, q3: 50000, max: 90000, notes: [] }, failures: [{ category: "provider_timeout", label: "供应商超时", count: 3 }] }],
            costBreakdown: { departments: [dimension(departmentId, "隔离设计部")], people: [dimension(personId, "测试设计师甲")], boards, operations: [dimension("generate", "生成")], models },
            optimizationCosts: {
                executions: 2,
                cacheHits: 1,
                uncertain: 0,
                inputTokens: metric(500),
                outputTokens: metric(200),
                costs: [{ currency: "USD", providerReportedAmount: "0.020000", estimatedAmount: "0.010000", knownCount: 1, estimatedCount: 1, unknownCount: 0 }],
                notes: ["供应商返回金额仍需财务对账；不同币种不相加。"],
            },
            budget: metric(null),
        };
    if (path.endsWith("/quality"))
        return {
            ...common,
            failureRuleVersion: "fixture-v1",
            failures: [{ category: "timeout", label: "供应商超时", count: 3, modelConfigId: modelId, boardKey: "canvas", operationType: "generate" }],
            retries: [
                { attempts: 1, tasks: 27 },
                { attempts: 2, tasks: 3 },
            ],
            resultUse,
            lineage: metric(null),
            optimizationComparison: [
                { modelConfigId: modelId, boardKey: "canvas", operationType: "generate", optimized: true, metrics },
                { modelConfigId: modelId, boardKey: "canvas", operationType: "generate", optimized: false, metrics: { ...metrics, generationRequests: metric(10) } },
            ],
        };
    if (path.endsWith("/flows")) return { ...common, nodes: [], links: [], paths: [], funnels: [], transfers: [], pathCoverage: metric(null), resultUse };
    throw new Error(`Unmocked usage route: ${path}`);
}
