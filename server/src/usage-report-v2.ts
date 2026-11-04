import type {
    UsageV2Boards,
    UsageV2Flows,
    UsageV2Metric,
    UsageV2Metrics,
    UsageV2Models,
    UsageV2Overview,
    UsageV2People,
    UsageV2Quality,
    UsageV2ResultUse,
    UsageV2Scope,
} from "../../shared/usage-analytics-v2";
import { USAGE_CONTROLS } from "../../shared/usage-analytics";
import { UsageError, usageBoardLabels, usageControlLabel } from "./usage-analytics";
import { usageFailureLabels } from "./usage-failure-reasons";
import { usageV2ReportAnonymousScope, type UsageV2ReportPeriod } from "../../shared/usage-report-v2";

export type { UsageV2ReportPeriod } from "../../shared/usage-report-v2";
export type UsageV2ReportInput =
    | { page: "overview"; data: UsageV2Overview }
    | { page: "people"; data: UsageV2People }
    | { page: "boards"; data: UsageV2Boards }
    | { page: "models"; data: UsageV2Models }
    | { page: "quality"; data: UsageV2Quality }
    | { page: "flows"; data: UsageV2Flows };
export const USAGE_V2_REPORT_LIMITS = Object.freeze({
    maxCharacters: 32_000,
    dimensionRows: 12,
    dailyRows: 31,
    detailRows: 24,
    heatmapRows: 168,
    coverageRows: 40,
});

// These definitions are authored here, never copied from query result free text.
const specs = {
    activePeople: ["活跃人数", "count"],
    activeDays: ["活跃人日", "count"],
    generationRequests: ["生成任务数", "count"],
    chatRequests: ["文字请求数", "count"],
    succeeded: ["成功请求", "count"],
    failed: ["明确失败", "count"],
    cancelled: ["用户取消", "count"],
    paused: ["暂停", "count"],
    interrupted: ["请求中断", "count"],
    uncertain: ["结果待核查", "count"],
    pending: ["进行中", "count"],
    generatedImages: ["成功保存图片", "count"],
    visits: ["已记录访问", "count"],
    interactions: ["已记录操作", "count"],
    successRate: ["成功率", "ratio"],
    generationBookedCny: ["生成已记账金额", "CNY"],
    imageBookedCny: ["图片已记账金额", "CNY"],
    costPerImage: ["每张保存图片记账成本", "CNY"],
    resultUseRate: ["结果使用率", "ratio"],
    formalAdoptionRate: ["正式采纳率", "ratio"],
    costPerUsedImage: ["每张有使用证据图片记账成本", "CNY"],
    waitMsP50: ["提交至首次处理 P50", "ms"],
    runMsP50: ["首次处理至完成 P50", "ms"],
    totalMsP50: ["提交至完成 P50", "ms"],
    totalMsP90: ["提交至完成 P90", "ms"],
    activeSeconds: ["可见活跃时长", "seconds"],
    revisionRounds: ["改稿轮次", "count"],
} as const;
const pageLabels = {
    overview: "总览",
    people: "人员匿名合计",
    boards: "板块与功能",
    models: "模型与成本",
    quality: "生成质量",
    flows: "流程分析",
} as const;
const periodLabels = { selected: "区间报告", week: "周报", month: "月报" } as const;
const operations: Record<string, string> = {
    image_generation: "图片生成",
    inpaint: "局部重绘",
    upscale: "放大",
    batch_image: "批量图片",
    seamless_stitch: "无缝拼接",
    remove_background: "去背景",
    video_generation: "视频生成",
    audio_generation: "音频生成",
    chat: "文字对话",
};
const stages: Record<string, string> = {
    downloaded: "下载开始回执",
    exported: "导出回执",
    project: "加入项目",
    reused: "再次复用",
    adopted: "正式采纳或交付",
    delivered: "正式交付",
};
const warnings = [
    "本报告由固定模板免费生成，未调用模型；若后续发送模型，须沿用预览、明确确认及一次性发送流程。",
    "仅发送白名单聚合值；不包含员工姓名、用户 ID、提示词、图片 URL、原始错误、任意元数据或个人排名。模型和部门使用本报告内匿名组号，不能跨报告匹配。",
    "已记账金额不等于供应商实付；不覆盖全部文字、失败或未知调用费用，优化费用按原币种单列，不并入生成金额。",
    "结果使用不等于正式采纳，也不代表图片质量；下载或导出回执不证明系统已落盘。阶段覆盖可跳步，不是有序漏斗。",
    "null 明确表示不可用，不得当作 0；没有记录不能推断为没有使用。覆盖数量按各指标自己的样本单位，不可跨指标相加。",
    "优化与未优化、模型或板块之间的观察差异不能据此推断因果；队列结果使用观察时长可能不同，不作人员能力或绩效评价。",
    "任务按提交期归队列，状态是读取时当前状态；未知、暂停等可能重叠，不可简单相加。历史时长及路径缺口不能补造，Worker attempts 不是改稿轮次。",
    "本期与对比期含起不含终，以北京时间解释；模板名称不会改动实际查询范围。部分覆盖与不同快照时点会限制比较。",
];

type Cell = string | number | null;
type Table = { id: string; title: string; columns: string[]; rows: Cell[][] };
type SafeMetric = {
    value: number | null;
    unit: UsageV2Metric["unit"];
    state: UsageV2Metric["state"];
    availableCount: number | null;
    missingCount: number | null;
    numerator?: number | null;
    denominator?: number | null;
    amount?: string | null;
    comparison?: {
        value: number | null;
        absoluteDelta: number | null;
        relativeDelta: number | null;
        reason: "zero_baseline" | "insufficient_data" | null;
        unit: "absolute" | "percentage_points";
    };
};
const number = (value: unknown, signed = false): number | null =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
    (signed || value >= 0)
        ? value
        : null;
const count = (value: unknown) => {
    const parsed = number(value);
    return parsed !== null && Number.isInteger(parsed) ? parsed : null;
};
const decimal = (value: unknown): string | null =>
    typeof value === "string" && /^\d{1,16}(?:\.\d{1,6})?$/.test(value) ? value : null;
const stamp = (value: unknown): string | null => {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    )
        return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const calendarDay = (value: unknown): string | null => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
};
const board = (key: unknown) =>
    typeof key === "string" && Object.hasOwn(usageBoardLabels, key) ? usageBoardLabels[key]! : "未记录板块";
const operation = (key: unknown) =>
    typeof key === "string" && Object.hasOwn(operations, key) ? operations[key]! : "未记录操作";
const state = (value: unknown): UsageV2Metric["state"] =>
    value === "available" || value === "partial" ? value : "unavailable";
const boundedVersion = (value: unknown, prefix: string) =>
    typeof value === "string" && new RegExp(`^${prefix}-v\\d{1,3}(?:\\.\\d{1,3}){0,2}$`).test(value) ? value : null;

function metric(input: UsageV2Metric | undefined, unit: UsageV2Metric["unit"]): SafeMetric {
    let value = number(input?.value);
    let availability = state(input?.state);
    const availableCount = count(input?.availableCount),
        missingCount = count(input?.missingCount);
    const numerator = number(input?.numerator),
        denominator = number(input?.denominator);
    if (
        availability === "unavailable" ||
        (unit === "ratio" && value !== null && value > 1) ||
        (input?.denominator !== undefined && (denominator === null || denominator === 0))
    )
        value = null;
    if (value === null) availability = "unavailable";
    else if (missingCount !== null && missingCount > 0) availability = "partial";
    const result: SafeMetric = { value, unit, state: availability, availableCount, missingCount };
    if (input?.numerator !== undefined) result.numerator = numerator;
    if (input?.denominator !== undefined) result.denominator = denominator;
    if (unit === "CNY" && input?.amount !== undefined) result.amount = value === null ? null : decimal(input.amount);
    if (input?.comparison) {
        const previous = number(input.comparison.value);
        const insufficient =
            value === null ||
            previous === null ||
            availability !== "available" ||
            input.comparison.reason === "insufficient_data";
        result.comparison = {
            value: previous,
            absoluteDelta: insufficient ? null : number(input.comparison.absoluteDelta, true),
            relativeDelta:
                insufficient || previous === 0 || unit === "ratio"
                    ? null
                    : number(input.comparison.relativeDelta, true),
            reason: insufficient ? "insufficient_data" : previous === 0 && unit !== "ratio" ? "zero_baseline" : null,
            unit: unit === "ratio" ? "percentage_points" : "absolute",
        };
    }
    return result;
}
function allMetrics(input: UsageV2Metrics): Record<string, SafeMetric> {
    return Object.fromEntries(
        Object.entries(specs).map(([key, [, unit]]) => [key, metric(input[key as keyof UsageV2Metrics], unit)]),
    );
}
function scope(input: UsageV2Scope) {
    const from = stamp(input.from),
        to = stamp(input.to);
    if (!from || !to || from >= to || input.timezone !== "Asia/Shanghai")
        throw new UsageError("USAGE_REPORT_INVALID", "报告日期范围无效", 422);
    const result = usageV2ReportAnonymousScope(input);
    result.compare = ["none", "previous_period", "previous_year"].includes(input.compare) ? input.compare : null;
    result.departmentBasis =
        input.departmentBasis === "at_event" || input.departmentBasis === "current" ? input.departmentBasis : null;
    return result;
}

/** Pure free adapter: it performs no query, write, model request or paid-call confirmation.
 * Only the object built below may be serialized. Raw responses, labels, notes and insights are untrusted. */
export function buildUsageV2Report(
    input: UsageV2ReportInput,
    options: { period?: UsageV2ReportPeriod; maxCharacters?: number } = {},
) {
    const period = options.period ?? "selected",
        maxCharacters = options.maxCharacters ?? USAGE_V2_REPORT_LIMITS.maxCharacters;
    if (
        !Object.hasOwn(periodLabels, period) ||
        !Object.hasOwn(pageLabels, input.page) ||
        !Number.isSafeInteger(maxCharacters) ||
        maxCharacters <= 0 ||
        maxCharacters > USAGE_V2_REPORT_LIMITS.maxCharacters
    )
        throw new UsageError("USAGE_REPORT_INVALID", "报告模板或字符预算无效", 422);
    const meta = input.data.meta;
    if (meta.schemaVersion !== 2) throw new UsageError("USAGE_REPORT_INVALID", "报告数据版本无效", 422);
    const tables: Table[] = [];
    const truncation: Array<{ table: string; total: number; included: number; omitted: number }> = [];
    function table<T>(
        id: string,
        title: string,
        columns: string[],
        rows: T[],
        project: (row: T, index: number) => Cell[],
        limit: number = USAGE_V2_REPORT_LIMITS.dimensionRows,
    ) {
        const selected = rows.slice(0, limit);
        tables.push({ id, title, columns, rows: selected.map(project) });
        if (rows.length > selected.length)
            truncation.push({
                table: id,
                total: rows.length,
                included: selected.length,
                omitted: rows.length - selected.length,
            });
    }
    const selectedMetrics = "metrics" in input.data ? allMetrics(input.data.metrics) : {};
    const metricRows = (values: Record<string, SafeMetric>) =>
        Object.entries(values).map(
            ([key, value]) =>
                [
                    Object.hasOwn(specs, key) ? specs[key as keyof typeof specs][0] : key,
                    value.amount ?? value.value,
                    value.unit,
                    value.state,
                    value.availableCount,
                    value.missingCount,
                    value.comparison?.value ?? null,
                    value.comparison?.absoluteDelta ?? null,
                    value.comparison?.relativeDelta ?? null,
                    value.numerator ?? null,
                    value.denominator ?? null,
                ] satisfies Cell[],
        );
    if (Object.keys(selectedMetrics).length)
        table(
            "summary",
            "当前筛选匿名合计",
            [
                "指标",
                "数值",
                "单位",
                "状态",
                "已知样本",
                "缺失样本",
                "对比值",
                "差值或百分点",
                "相对变化（0–1）",
                "分子",
                "分母",
            ],
            metricRows(selectedMetrics),
            (row) => row,
            40,
        );
    const coverage = meta.coverage.slice(0, USAGE_V2_REPORT_LIMITS.coverageRows).flatMap((row) =>
        Object.hasOwn(specs, row.metric) || row.metric === "reportedCollectionGaps"
            ? [
                  {
                      metric: row.metric,
                      state: state(row.state),
                      since: stamp(row.since),
                      eligible: count(row.eligible),
                      matched: count(row.matched),
                      unknown: count(row.unknown),
                  },
              ]
            : [],
    );
    table(
        "coverage",
        "采集与关联覆盖",
        ["指标", "状态", "自何时可用", "适用样本", "已匹配", "未知"],
        coverage,
        (row) => [
            Object.hasOwn(specs, row.metric) ? specs[row.metric as keyof typeof specs][0] : "客户端已报告采集缺口",
            row.state,
            row.since,
            row.eligible,
            row.matched,
            row.unknown,
        ],
        USAGE_V2_REPORT_LIMITS.coverageRows,
    );
    if (meta.coverage.length > USAGE_V2_REPORT_LIMITS.coverageRows)
        truncation.push({
            table: "coverage",
            total: meta.coverage.length,
            included: coverage.length,
            omitted: meta.coverage.length - coverage.length,
        });
    function dimensionRows<T extends { metrics: UsageV2Metrics }>(
        id: string,
        title: string,
        rows: T[],
        label: (row: T, index: number) => string,
    ) {
        table(
            id,
            title,
            [
                "匿名分组或板块",
                "生成任务",
                "保存图片",
                "图片状态",
                "成功率（0–1）",
                "成功率状态",
                "已记账 CNY",
                "费用状态",
                "结果使用率（0–1）",
                "使用率状态",
                "耗时 P90（ms）",
                "耗时状态",
            ],
            rows,
            (row, index) => {
                const metrics = allMetrics(row.metrics);
                return [
                    label(row, index),
                    metrics.generationRequests!.value,
                    metrics.generatedImages!.value,
                    metrics.generatedImages!.state,
                    metrics.successRate!.value,
                    metrics.successRate!.state,
                    metrics.generationBookedCny!.amount ?? metrics.generationBookedCny!.value,
                    metrics.generationBookedCny!.state,
                    metrics.resultUseRate!.value,
                    metrics.resultUseRate!.state,
                    metrics.totalMsP90!.value,
                    metrics.totalMsP90!.state,
                ];
            },
        );
    }
    function singleMetric(id: string, title: string, source: UsageV2Metric, unit: UsageV2Metric["unit"]) {
        const clean = metric(source, unit);
        table(id, title, ["数值", "单位", "状态", "已知样本", "缺失样本"], [clean], (row) => [
            row.value,
            row.unit,
            row.state,
            row.availableCount,
            row.missingCount,
        ]);
    }
    function resultUse(source: UsageV2ResultUse) {
        table(
            "result-use",
            "同提交队列结果使用证据（非质量评分）",
            ["指标", "图片数"],
            [
                ["成功保存图片", count(source.generatedImages)],
                ["已关联图片", count(source.linkedImages)],
                ["未关联图片", count(source.unlinkedImages)],
                ["有使用证据图片", count(source.usedImages)],
                ["正式采纳或交付图片", count(source.formallyAdoptedImages)],
            ] as Cell[][],
            (row) => row,
        );
        table("result-stages", "结果阶段覆盖（非有序漏斗）", ["阶段", "图片数", "证据类型"], source.stages, (row) => [
            Object.hasOwn(stages, row.key) ? stages[row.key]! : "未识别阶段",
            count(row.count),
            ["server_confirmed", "client_reported", "mixed"].includes(row.evidence) ? row.evidence : null,
        ]);
    }
    switch (input.page) {
        case "overview": {
            const daily = (id: string, title: string, rows: UsageV2Overview["daily"]) =>
                table(
                    id,
                    title,
                    ["北京时间日期", "活跃人数", "保存图片", "图片状态", "已记账 CNY", "金额状态"],
                    rows,
                    (row) => {
                        const money = metric(row.metrics.generationBookedCny, "CNY");
                        return [
                            calendarDay(row.day),
                            metric(row.metrics.activePeople, "count").value,
                            metric(row.metrics.generatedImages, "count").value,
                            metric(row.metrics.generatedImages, "count").state,
                            money.amount ?? money.value,
                            money.state,
                        ];
                    },
                    USAGE_V2_REPORT_LIMITS.dailyRows,
                );
            daily("daily", "本期每日事实", input.data.daily);
            daily("comparison-daily", "对比期每日事实", input.data.comparisonDaily);
            table(
                "heatmap",
                "已记录动作时段（非时长）",
                ["周一=0", "北京时间小时", "已记录次数"],
                input.data.hourlyHeatmap,
                (row) => [
                    Number.isInteger(row.weekday) && row.weekday >= 0 && row.weekday <= 6 ? row.weekday : null,
                    Number.isInteger(row.hour) && row.hour >= 0 && row.hour <= 23 ? row.hour : null,
                    count(row.count),
                ],
                USAGE_V2_REPORT_LIMITS.heatmapRows,
            );
            dimensionRows(
                "departments",
                "部门匿名组（组号仅本报告内有效）",
                input.data.departments,
                (_row, index) => `部门组 ${index + 1}`,
            );
            break;
        }
        case "people":
            // Deliberately do not read people, pagination, topModels or topBoards.
            break;
        case "boards": {
            dimensionRows("boards", "板块事实", input.data.boards, (row) => board(row.key));
            table(
                "parameters",
                "允许的参数桶",
                ["板块", "参数", "允许的值", "次数"],
                input.data.parameters,
                (row) => {
                    const key = ["size", "resolution", "quality", "aspectRatio"].includes(row.parameter)
                        ? row.parameter
                        : null;
                    const value =
                        typeof row.value === "string" &&
                        /^(?:\d{1,4}[:xX]\d{1,4}|[1248][kK]|\d{3,4}p|auto|low|medium|high|standard|hd)$/.test(row.value)
                            ? row.value
                            : null;
                    return [board(row.boardKey), key, value, count(row.count)];
                },
                USAGE_V2_REPORT_LIMITS.detailRows,
            );
            table(
                "controls",
                "板块控件触达（非转化率）",
                ["板块", "控件", "有操作人数", "适用人数", "触达率（0–1）", "状态"],
                input.data.controlUsage,
                (row, index) => {
                    const rate = metric(row.rate, "ratio");
                    return [
                        board(row.boardKey),
                        (USAGE_CONTROLS as readonly string[]).includes(row.controlKey)
                            ? usageControlLabel(row.controlKey)
                            : `匿名控件 ${index + 1}`,
                        count(row.users),
                        count(row.eligibleUsers),
                        rate.value,
                        rate.state,
                    ];
                },
                USAGE_V2_REPORT_LIMITS.detailRows,
            );
            singleMetric("conversion", "访问至提交转化", input.data.conversion, "ratio");
            singleMetric("abandonment", "放弃率", input.data.abandonment, "ratio");
            break;
        }
        case "models": {
            dimensionRows(
                "models",
                "模型匿名配置组（组号仅本报告内有效）",
                input.data.models,
                (row, index) => `模型组 ${index + 1} · ${board(row.boardKey)} · ${operation(row.operationType)}`,
            );
            dimensionRows(
                "cost-departments",
                "按匿名部门组的记账成本",
                input.data.costBreakdown.departments,
                (_row, index) => `部门组 ${index + 1}`,
            );
            dimensionRows("cost-boards", "按板块的记账成本", input.data.costBreakdown.boards, (row) => board(row.key));
            dimensionRows("cost-operations", "按操作的记账成本", input.data.costBreakdown.operations, (row) =>
                operation(row.key),
            );
            // costBreakdown.people is intentionally excluded, even as pseudonymous rows.
            const costs = input.data.optimizationCosts;
            table(
                "optimization-executions",
                "独立提示词编译（不含未提交任务的优化）",
                ["执行次数", "缓存命中", "待核查", "输入 Token", "输入状态", "输出 Token", "输出状态"],
                [costs],
                (row) => [
                    count(row.executions),
                    count(row.cacheHits),
                    count(row.uncertain),
                    metric(row.inputTokens, "count").value,
                    metric(row.inputTokens, "count").state,
                    metric(row.outputTokens, "count").value,
                    metric(row.outputTokens, "count").state,
                ],
            );
            table(
                "optimization-costs",
                "优化费用按原币种分列（非财务对账）",
                ["币种", "供应商返回金额", "估算金额", "已知数", "估算数", "未知数"],
                costs.costs,
                (row) => [
                    typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null,
                    decimal(row.providerReportedAmount),
                    decimal(row.estimatedAmount),
                    count(row.knownCount),
                    count(row.estimatedCount),
                    count(row.unknownCount),
                ],
            );
            singleMetric("budget", "人民币预算（积分额度不是现金预算）", input.data.budget, "CNY");
            break;
        }
        case "quality": {
            table(
                "failures",
                "分类异常状态（含非失败状态，不可直接相加为失败率）",
                ["分类", "数量", "板块", "操作"],
                input.data.failures,
                (row) => [
                    Object.hasOwn(usageFailureLabels, row.category) ? usageFailureLabels[row.category]! : "未分类原因",
                    count(row.count),
                    board(row.boardKey),
                    operation(row.operationType),
                ],
                USAGE_V2_REPORT_LIMITS.detailRows,
            );
            table(
                "retries",
                "Worker attempts 分布（不是设计师改稿轮次）",
                ["Worker attempts", "任务数"],
                input.data.retries,
                (row) => [count(row.attempts), count(row.tasks)],
                USAGE_V2_REPORT_LIMITS.detailRows,
            );
            resultUse(input.data.resultUse);
            singleMetric("lineage", "可核验的编辑血缘", input.data.lineage, "count");
            table(
                "optimization-comparison",
                "优化使用观察（非因果或效果实验）",
                ["匿名分组", "板块", "操作", "已优化", "任务数", "成功率（0–1）", "状态"],
                input.data.optimizationComparison,
                (row, index) => {
                    const rate = metric(row.metrics.successRate, "ratio");
                    return [
                        `配置组 ${index + 1}`,
                        board(row.boardKey),
                        operation(row.operationType),
                        row.optimized === true ? "是" : row.optimized === false ? "否" : null,
                        metric(row.metrics.generationRequests, "count").value,
                        rate.value,
                        rate.state,
                    ];
                },
            );
            break;
        }
        case "flows":
            singleMetric("path-coverage", "可核验路径覆盖", input.data.pathCoverage, "count");
            resultUse(input.data.resultUse);
            // Existing-facts V2 has no reliable linked paths. Never serialize raw nodes/steps.
            break;
    }
    const resultSource = input.page === "quality" || input.page === "flows" ? input.data.resultUse : null;
    const aggregates = {
        schemaVersion: 2,
        reportVersion: "usage-report-v2.1",
        page: input.page,
        period,
        metricVersion: boundedVersion(meta.metricVersion, "existing-facts"),
        scope: scope(meta.scope),
        comparisonScope: meta.comparisonScope ? scope(meta.comparisonScope) : null,
        asOf: stamp(meta.asOf),
        computedThrough: stamp(meta.computedThrough),
        provisional: meta.provisional === true,
        dataMode:
            meta.dataMode === "live_existing_facts" ||
            meta.dataMode === "persisted_daily_facts" ||
            meta.dataMode === "daily_history_live_today"
                ? meta.dataMode
                : null,
        liveFrom: stamp(meta.liveFrom),
        lagSeconds: count(meta.lagSeconds),
        snapshot: meta.snapshot
            ? {
                  oldestComputedAt: stamp(meta.snapshot.oldestComputedAt),
                  newestComputedAt: stamp(meta.snapshot.newestComputedAt),
                  dayCount: count(meta.snapshot.dayCount),
                  mixedSnapshots: meta.snapshot.mixedSnapshots === true,
              }
            : null,
        resultUseBasis: resultSource
            ? {
                  basis: resultSource.basis === "submitted_cohort_as_of" ? "submitted_cohort_as_of" : null,
                  asOf: stamp(resultSource.asOf),
                  ruleVersion: boundedVersion(resultSource.ruleVersion, "result-use"),
              }
            : null,
        failureRuleVersion:
            input.page === "quality" ? boundedVersion(input.data.failureRuleVersion, "failure-text") : null,
        metrics: selectedMetrics,
        coverage,
        tables,
        truncation,
        limits: { ...USAGE_V2_REPORT_LIMITS },
        excluded: [
            "personRows",
            "names",
            "userIds",
            "modelConfigIds",
            "rawLabels",
            "prompts",
            "imageUrls",
            "rawErrors",
            "metadata",
            "rawInsights",
            "rawPaths",
        ],
        instructions:
            "按团队概况、亮点与可确认事实、问题与覆盖、模型与成本建议、功能推广建议、依据数据表输出中文报告；仅依据下列数值，引用表名，分清事实、推测和缺失，不作人员评价。",
        warnings: [
            ...warnings,
            ...(input.page === "people" ? ["人员页仅使用当前筛选的匿名合计；不读取或发送个人列表。"] : []),
            ...(input.page === "flows"
                ? ["当前适配器仅报告可核验覆盖和结果阶段，不输出原始路径、节点、跨板块流转或自由文本。"]
                : []),
        ],
    };
    // Serialization is intentionally limited to the fresh allowlisted projection.
    const content = JSON.stringify(aggregates);
    const show = (value: Cell) => (value === null ? "不可用（null）" : String(value));
    const render = (item: Table) =>
        `### ${item.title}\n\n| ${item.columns.join(" | ")} |\n| ${item.columns.map(() => "---").join(" | ")} |\n${item.rows.map((row) => `| ${row.map(show).join(" | ")} |`).join("\n") || "（本表无记录；不能推断未使用。）"}`;
    const unavailable = Object.values(selectedMetrics).filter((value) => value.state === "unavailable").length;
    const partial = Object.values(selectedMetrics).filter((value) => value.state === "partial").length;
    const filterSummary = (selected: ReturnType<typeof scope>) =>
        `人员 ID 筛选 ${selected.filters.selectedPeopleCount === null ? "未设置" : `${selected.filters.selectedPeopleCount} 项`}；部门筛选 ${selected.filters.selectedDepartmentCount === null ? "未设置" : `${selected.filters.selectedDepartmentCount} 项`}；模型筛选 ${selected.filters.selectedModelCount === null ? "未设置" : `${selected.filters.selectedModelCount} 项`}；板块 ${selected.filters.boards.join("、") || "未筛选"}；操作 ${selected.filters.operations.join("、") || "未筛选"}；关键字筛选${selected.filters.searchApplied ? "已启用（不含原文）" : "未启用"}；部门归属${selected.departmentBasis === "at_event" ? "按事件时快照" : selected.departmentBasis === "current" ? "按员工当前部门" : "不可用（null）"}`;
    const markdown = [
        `# 使用分析${periodLabels[period]} · ${pageLabels[input.page]}`,
        `实际范围：[${aggregates.scope.from}, ${aggregates.scope.to})（边界以 UTC ISO 表示）；统计时区 Asia/Shanghai（北京时间）。模板仅改变标题，不自动选择自然周或自然月。`,
        `筛选范围：${filterSummary(aggregates.scope)}。`,
        `比较方式：${aggregates.scope.compare === "previous_period" ? "上一周期" : aggregates.scope.compare === "previous_year" ? "去年同期" : aggregates.scope.compare === "none" ? "不比较" : "不可用（null）"}。`,
        aggregates.comparisonScope
            ? `对比范围：[${aggregates.comparisonScope.from}, ${aggregates.comparisonScope.to})；${filterSummary(aggregates.comparisonScope)}。`
            : "对比范围：未提供对比期。",
        `指标版本：${aggregates.metricVersion ?? "不可用（null）"}；数据截至：${aggregates.asOf ?? "不可用（null）"}；最早计算时点：${aggregates.computedThrough ?? "不可用（null）"}；暂定数据。`,
        aggregates.dataMode === "daily_history_live_today"
            ? `数据模式：历史按日投影 + 今日同事务实时读取；实时分界 ${aggregates.liveFrom ?? "不可用（null）"}。今日部分不是持久日快照，多历史日仍可能来自不同刷新时点。`
            : aggregates.dataMode === "live_existing_facts"
              ? "数据模式：现有事实实时读取，不是持久日快照。"
              : "数据模式：历史按日事实投影；多日可能来自不同刷新时点，不是统一历史观察快照。",
        "## 团队概况",
        input.page === "people"
            ? "人员页仅使用当前筛选的匿名合计，不呈现姓名、个人行或排名。"
            : "报告仅覆盖当前筛选和本页可见的聚合事实；无全团队合计的页面不从分组重复求和。",
        "## 亮点与可确认事实",
        Object.hasOwn(selectedMetrics, "generatedImages")
            ? `本范围成功保存图片：${show(selectedMetrics.generatedImages!.value)}；生成任务：${show(selectedMetrics.generationRequests!.value)}。请结合依据表中的状态与缺失样本解释。`
            : "可确认的分组数值见本页依据表；表中组号为本报告内匿名索引，不表示排名。",
        "## 问题与覆盖",
        Object.keys(selectedMetrics).length
            ? `本页合计指标中不可用 ${unavailable} 项、部分覆盖 ${partial} 项；null 不是 0。各维度的缺失情况见覆盖表。`
            : "本页未提供整体合计，不能据此统计整体不可用或部分覆盖项数；请核对覆盖表及各分组状态。null 不是 0。",
        "## 模型与成本建议",
        "已记账金额不等于供应商实付；先核对覆盖、币种、任务范围和观察时间，再比较工具成本。未提供足够证据时不评选最划算模型。",
        "## 功能推广建议",
        "已记录访问、控件触达和结果使用不等于正式采纳；结合真实业务反馈核对使用障碍，不能据此推断因果、能力或绩效。",
        "## 依据数据表",
        "比例按 0–1 展示；比较差值的比例单位为百分点。分组表按输入顺序限量展示，不是完整排行；匿名组号不可跨表或跨报告关联。",
        ...tables.map(render),
        ...truncation.map(
            (item) =>
                `表 ${item.table} 共 ${item.total} 行，展示 ${item.included} 行，省略 ${item.omitted} 行；未改写合计指标，不得将显示行之和当作完整总量。`,
        ),
        "## 口径与限制",
        ...aggregates.warnings.map((value) => `- ${value}`),
    ].join("\n\n");
    if (content.length > maxCharacters || markdown.length > maxCharacters)
        throw new UsageError("USAGE_PREVIEW_TOO_LARGE", "统计预览过大，请缩小范围；未返回截断报告", 422);
    return {
        content,
        markdown,
        aggregates,
        estimatedCharacters: content.length,
        sampleCount: 0 as const,
        includesPromptSamples: false as const,
        warnings: aggregates.warnings,
    };
}
