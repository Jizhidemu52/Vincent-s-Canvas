import { describe, expect, test } from "bun:test";
import type { UsageV2Meta, UsageV2Metrics, UsageV2Overview, UsageV2Quality } from "../../shared/usage-analytics-v2";
import { usageV2Metrics } from "../src/usage-analytics-v2";
import { buildUsageV2Report, USAGE_V2_REPORT_LIMITS, type UsageV2ReportInput } from "../src/usage-report-v2";

const secret = "PRIVATE_NAME_张三_prompt_https://private.invalid/image.png";
const uuid = "11111111-1111-4111-8111-111111111111";
function metrics(): UsageV2Metrics {
    const result = usageV2Metrics([]);
    result.generatedImages = { ...result.generatedImages, value: 12, availableCount: 4 };
    result.generationRequests = { ...result.generationRequests, value: 5, availableCount: 5 };
    result.successRate = {
        ...result.successRate,
        value: 0.8,
        numerator: 4,
        denominator: 5,
        state: "available",
        availableCount: 5,
    };
    result.generationBookedCny = {
        ...result.generationBookedCny,
        value: 1.234567,
        amount: "1.234567",
        availableCount: 4,
    };
    return result;
}
function meta(): UsageV2Meta {
    return {
        schemaVersion: 2,
        metricVersion: "existing-facts-v2.1",
        scope: {
            from: "2026-10-01T00:00:00+08:00",
            to: "2026-10-08T00:00:00+08:00",
            timezone: "Asia/Shanghai",
            compare: "none",
            departmentBasis: "at_event",
            userIds: [uuid],
            search: secret,
        },
        comparisonScope: null,
        asOf: "2026-11-04T12:00:00Z",
        computedThrough: "2026-11-04T12:00:00Z",
        provisional: true,
        dataMode: "persisted_daily_facts",
        coverage: [
            {
                metric: "generatedImages",
                state: "partial",
                since: null,
                eligible: 5,
                matched: 4,
                unknown: 1,
                notes: [secret],
            },
        ],
        notes: [secret],
    };
}
function overview(): UsageV2Overview {
    return {
        meta: meta(),
        metrics: metrics(),
        daily: [{ day: "2026-10-01", metrics: metrics() }],
        comparisonDaily: [],
        hourlyHeatmap: [{ weekday: 0, hour: 10, count: 4 }],
        departments: [{ key: uuid, label: secret, metrics: metrics() }],
        insights: [
            {
                ruleId: secret,
                severity: "info",
                text: secret,
                sampleCount: 5,
                evidence: { secret },
                drilldownFilter: { userIds: [uuid] },
            },
        ],
    };
}
function quality(): UsageV2Quality {
    return {
        meta: meta(),
        metrics: metrics(),
        failureRuleVersion: "failure-text-v1",
        failures: [
            {
                category: "provider_timeout",
                label: secret,
                count: 2,
                modelConfigId: uuid,
                boardKey: "image",
                operationType: "image_generation",
            },
        ],
        retries: [{ attempts: 2, tasks: 3 }],
        resultUse: {
            basis: "submitted_cohort_as_of",
            asOf: "2026-11-04T12:00:00Z",
            ruleVersion: "result-use-v1",
            generatedImages: 12,
            linkedImages: 10,
            unlinkedImages: 2,
            usedImages: 4,
            formallyAdoptedImages: 1,
            stages: [{ key: "downloaded", label: secret, count: 4, evidence: "client_reported" }],
            notes: [secret],
        },
        lineage: metrics().revisionRounds,
        optimizationComparison: [
            {
                modelConfigId: uuid,
                boardKey: "image",
                operationType: "image_generation",
                optimized: true,
                metrics: metrics(),
            },
        ],
        insights: [],
    };
}

describe("V2 free aggregate reports", () => {
    test("constructs a whitelist instead of forwarding arbitrary labels, metadata or identities", () => {
        const data = overview();
        Object.assign(data.metrics.generatedImages, {
            definition: secret,
            source: secret,
            definitionId: secret,
            metadata: { secret },
        });
        Object.assign(data, {
            prompt: secret,
            imageUrl: secret,
            rawError: secret,
            metadata: { secret },
            toJSON: () => {
                throw new Error("must not serialize response");
            },
        });
        const report = buildUsageV2Report({ page: "overview", data });
        expect(report.content + report.markdown).not.toContain(secret);
        expect(report.content + report.markdown).not.toContain(uuid);
        expect(JSON.parse(report.content)).toEqual(report.aggregates);
        expect(report.aggregates.metrics.generatedImages.value).toBe(12);
        expect(report.markdown).toContain("| 成功保存图片 | 12 | count |");
        expect(report.markdown).toContain("1.234567");
        expect(report.sampleCount).toBe(0);
        expect(report.includesPromptSamples).toBe(false);
    });

    test("people reports do not even read the person list or pagination", () => {
        const input = {
            meta: meta(),
            metrics: metrics(),
            get people(): never {
                throw new Error("private list read");
            },
            get pagination(): never {
                throw new Error("private pagination read");
            },
        };
        const report = buildUsageV2Report({ page: "people", data: input });
        expect(report.aggregates.metrics.generatedImages.value).toBe(12);
        expect(report.content).not.toContain("displayName");
        expect(report.markdown).toContain("人员页仅使用当前筛选的匿名合计");
    });

    test("null, unavailable, zero denominators and zero comparison baselines are never invented as zero rates", () => {
        const data = overview();
        data.metrics.successRate = { ...data.metrics.successRate, value: 0, denominator: 0 };
        data.metrics.resultUseRate = { ...data.metrics.resultUseRate, value: null, state: "unavailable" };
        data.metrics.generatedImages.comparison = {
            value: 0,
            absoluteDelta: 12,
            relativeDelta: Infinity,
            unit: "absolute",
        };
        data.metrics.generationBookedCny = {
            ...data.metrics.generationBookedCny,
            value: null,
            amount: "0.000000",
            state: "unavailable",
        };
        const report = buildUsageV2Report({ page: "overview", data });
        expect(report.aggregates.metrics.successRate).toMatchObject({
            value: null,
            state: "unavailable",
            denominator: 0,
        });
        expect(report.aggregates.metrics.resultUseRate.value).toBeNull();
        expect(report.aggregates.metrics.generatedImages.comparison).toMatchObject({
            value: 0,
            absoluteDelta: 12,
            relativeDelta: null,
            reason: "zero_baseline",
        });
        expect(report.aggregates.metrics.generationBookedCny.amount).toBeNull();
        expect(report.markdown).toContain("不可用（null）");
        expect(report.markdown).not.toContain("NaN");
        expect(report.markdown).not.toContain("Infinity");
    });

    test("all templates keep actual selected dates and include metric version, evidence, and interpretation limits", () => {
        for (const [period, title] of [
            ["selected", "区间报告"],
            ["week", "周报"],
            ["month", "月报"],
        ] as const) {
            const report = buildUsageV2Report({ page: "overview", data: overview() }, { period });
            expect(report.markdown).toContain(title);
            expect(report.aggregates.scope.from).toBe("2026-09-30T16:00:00.000Z");
            expect(report.aggregates.scope.to).toBe("2026-10-07T16:00:00.000Z");
            expect(report.aggregates.metricVersion).toBe("existing-facts-v2.1");
            for (const section of [
                "团队概况",
                "亮点与可确认事实",
                "问题与覆盖",
                "模型与成本建议",
                "功能推广建议",
                "依据数据表",
                "已记账",
                "不等于供应商实付",
                "不等于正式采纳",
                "不能据此推断因果",
            ])
                expect(report.markdown).toContain(section);
        }
    });

    test("quality evidence preserves numerical facts while excluding source errors and using safe category names", () => {
        const data = quality();
        Object.assign(data.failures[0]!, { failure_reason: secret });
        const report = buildUsageV2Report({ page: "quality", data });
        expect(report.content + report.markdown).not.toContain(secret);
        expect(report.content + report.markdown).not.toContain(uuid);
        expect(report.markdown).toContain("供应商超时");
        expect(report.markdown).toContain("| 下载开始回执 | 4 | client_reported |");
        expect(report.markdown).toContain("| 正式采纳或交付图片 | 1 |");
        expect(report.markdown).toContain("Worker attempts 不是改稿轮次");
    });

    test("hybrid reports label today's live boundary separately from historical daily snapshots", () => {
        const data = overview();
        data.meta.dataMode = "daily_history_live_today";
        data.meta.liveFrom = "2026-11-03T16:00:00.000Z";
        const report = buildUsageV2Report({ page: "overview", data });
        expect(report.aggregates.dataMode).toBe("daily_history_live_today");
        expect(report.aggregates.liveFrom).toBe(data.meta.liveFrom);
        expect(report.markdown).toContain("历史按日投影 + 今日同事务实时读取");
        expect(report.markdown).toContain("实时分界 2026-11-03T16:00:00.000Z");
        expect(report.markdown).toContain("今日部分不是持久日快照");
    });

    test("standalone markdown includes safe filter and comparison scope without identity or search text", () => {
        const data = overview();
        data.meta.scope.compare = "previous_year";
        data.meta.scope.departmentBasis = "current";
        data.meta.comparisonScope = {
            ...data.meta.scope,
            from: "2025-10-01T00:00:00+08:00",
            to: "2025-10-08T00:00:00+08:00",
        };
        data.metrics.successRate.comparison = {
            value: 0.5,
            absoluteDelta: 30,
            relativeDelta: 0.6,
            unit: "percentage_points",
        };
        const report = buildUsageV2Report({ page: "overview", data });
        expect(report.markdown).toContain("比较方式：去年同期");
        expect(report.markdown).toContain("2025-09-30T16:00:00.000Z");
        expect(report.markdown).toContain("人员 ID 筛选 1 项");
        expect(report.markdown).toContain("按员工当前部门");
        expect(report.markdown).toContain("关键字筛选已启用（不含原文）");
        expect(report.markdown).not.toContain(secret);
        expect(report.markdown).not.toContain(uuid);
        expect(report.aggregates.metrics.successRate.comparison).toMatchObject({
            value: 0.5,
            absoluteDelta: 30,
            relativeDelta: null,
        });
        expect(
            report.aggregates.tables
                .find((table) => table.id === "summary")!
                .rows.find((row) => row[0] === "成功率")!
                .slice(-2),
        ).toEqual([4, 5]);
    });

    test("boards, models and flows responses all adapt without transmitting free text", () => {
        const m = metrics(),
            q = quality();
        const parameters = [
            {
                boardKey: "image",
                boardLabel: secret,
                parameter: "quality",
                value: secret,
                count: 5,
                eligible: 10,
                missing: 0,
                rate: m.successRate,
            },
            {
                boardKey: "image",
                boardLabel: secret,
                parameter: "aspectRatio",
                value: "3:4",
                count: 2,
                eligible: 10,
                missing: 0,
                rate: m.successRate,
            },
            {
                boardKey: "canvas",
                boardLabel: secret,
                parameter: "aspectRatio",
                value: "3:4",
                count: 7,
                eligible: 12,
                missing: 0,
                rate: m.successRate,
            },
        ];
        const inputs: UsageV2ReportInput[] = [
            {
                page: "boards",
                data: {
                    meta: meta(),
                    boards: [{ key: "image", label: secret, metrics: m }],
                    parameters,
                    controlUsage: [
                        {
                            boardKey: "image",
                            controlKey: "submit",
                            label: secret,
                            users: 2,
                            eligibleUsers: 4,
                            rate: { ...m.successRate, value: 0.5 },
                        },
                    ],
                    conversion: m.resultUseRate,
                    abandonment: m.resultUseRate,
                    insights: [],
                },
            },
            {
                page: "models",
                data: {
                    meta: meta(),
                    models: [
                        {
                            key: uuid,
                            label: secret,
                            modelConfigId: uuid,
                            boardKey: "image",
                            operationType: "image_generation",
                            metrics: m,
                            latency: { eligible: 0, available: 0, missing: 0, unit: "ms", method: "full_sample_linear_interpolation", min: null, q1: null, median: null, q3: null, max: null, notes: [] },
                            failures: [],
                        },
                    ],
                    costBreakdown: {
                        departments: [{ key: uuid, label: secret, metrics: m }],
                        people: [{ key: uuid, label: secret, metrics: m }],
                        boards: [],
                        operations: [],
                        models: [],
                    },
                    optimizationCosts: {
                        executions: 2,
                        cacheHits: 1,
                        uncertain: 0,
                        inputTokens: m.generationRequests,
                        outputTokens: m.generationRequests,
                        costs: [
                            {
                                currency: "USD",
                                providerReportedAmount: "0.120000",
                                estimatedAmount: "0.030000",
                                knownCount: 1,
                                estimatedCount: 1,
                                unknownCount: 0,
                            },
                        ],
                        notes: [secret],
                    },
                    budget: m.resultUseRate,
                    insights: [],
                },
            },
            {
                page: "flows",
                data: {
                    meta: meta(),
                    nodes: [{ key: secret, label: secret }],
                    links: [],
                    paths: [{ steps: [secret], count: 2 }],
                    funnels: [{ key: secret, label: secret, mode: "stage_coverage", stages: q.resultUse.stages }],
                    transfers: [],
                    pathCoverage: m.resultUseRate,
                    resultUse: q.resultUse,
                    insights: [],
                },
            },
        ];
        for (const input of inputs) {
            const report = buildUsageV2Report(input);
            expect(report.content + report.markdown).not.toContain(secret);
            expect(report.content + report.markdown).not.toContain(uuid);
            expect(report.aggregates.page).toBe(input.page);
            expect(report.aggregates.tables.length).toBeGreaterThan(0);
            expect(report.markdown).toContain("本页未提供整体合计");
            expect(report.markdown).not.toContain("不可用 0 项");
        }
        expect(buildUsageV2Report(inputs[0]!).markdown).toContain("3:4");
        expect(
            buildUsageV2Report(inputs[0]!)
                .aggregates.tables.find((table) => table.id === "parameters")!
                .rows.slice(1),
        ).toEqual([
            ["文生图", "aspectRatio", "3:4", 2],
            ["自由画布总入口", "aspectRatio", "3:4", 7],
        ]);
        expect(buildUsageV2Report(inputs[1]!).markdown).toContain("0.120000");
    });

    test("row limits explicitly disclose omitted groups and never alter the aggregate totals", () => {
        const data = overview();
        data.departments = Array.from({ length: USAGE_V2_REPORT_LIMITS.dimensionRows + 1 }, (_, index) => ({
            key: String(index),
            label: secret,
            metrics: metrics(),
        }));
        const report = buildUsageV2Report({ page: "overview", data });
        expect(report.aggregates.truncation).toContainEqual({
            table: "departments",
            total: USAGE_V2_REPORT_LIMITS.dimensionRows + 1,
            included: USAGE_V2_REPORT_LIMITS.dimensionRows,
            omitted: 1,
        });
        expect(report.aggregates.metrics.generatedImages.value).toBe(12);
        expect(report.markdown).toContain("省略 1 行");
    });

    test("caller budgets cannot bypass the hard cap and oversize reports fail instead of returning partial text", () => {
        for (const maxCharacters of [0, -1, 1.5, Infinity, NaN, USAGE_V2_REPORT_LIMITS.maxCharacters + 1]) {
            expect(() => buildUsageV2Report({ page: "overview", data: overview() }, { maxCharacters })).toThrow();
        }
        expect(() => buildUsageV2Report({ page: "overview", data: overview() }, { maxCharacters: 100 })).toThrow(
            "预览过大",
        );
        const full = buildUsageV2Report({ page: "overview", data: overview() });
        expect(full.estimatedCharacters).toBe(full.content.length);
        expect(() =>
            buildUsageV2Report({ page: "overview", data: overview() }, { maxCharacters: full.content.length - 1 }),
        ).toThrow("预览过大");
    });
});
