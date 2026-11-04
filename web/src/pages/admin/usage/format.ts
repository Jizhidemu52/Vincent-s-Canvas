import type { UsageV2Daily, UsageV2Meta, UsageV2Metric, UsageV2MetricKey, UsageV2Metrics, UsageV2Quality } from "@/services/api/usage-analytics-v2";
import { beijingDay } from "./filters";
export const metricLabels: Record<UsageV2MetricKey, string> = {
    activePeople: "活跃人数",
    activeDays: "活跃天数",
    generationRequests: "生成任务",
    chatRequests: "文字请求",
    succeeded: "成功请求",
    failed: "失败请求",
    cancelled: "已取消",
    paused: "已暂停",
    interrupted: "已中断",
    uncertain: "结果待核查",
    pending: "未完成",
    generatedImages: "成功出图",
    visits: "访问记录",
    interactions: "交互记录",
    successRate: "终态请求成功率",
    generationBookedCny: "已记账生成金额",
    imageBookedCny: "图片已记账金额",
    costPerImage: "单张图片已记账成本",
    resultUseRate: "结果使用率",
    formalAdoptionRate: "正式采纳率",
    costPerUsedImage: "单张已使用图成本",
    waitMsP50: "首次处理等待 P50",
    runMsP50: "首次处理到完成 P50",
    totalMsP50: "提交到完成 P50",
    totalMsP90: "提交到完成 P90",
    activeSeconds: "本软件可见活跃时长（近似）",
    revisionRounds: "可验证编辑链长度",
};
export function metricText(metric?: UsageV2Metric): string {
    if (!metric || metric.value === null || metric.state === "unavailable") return "不可用";
    if (metric.unit === "CNY") return `¥${metric.amount ?? metric.value.toFixed(6)}`;
    if (metric.unit === "ratio") return `${(metric.value * 100).toFixed(1)}%`;
    if (metric.unit === "ms") return metric.value < 1000 ? `${metric.value.toFixed(0)} ms` : `${(metric.value / 1000).toFixed(1)} 秒`;
    if (metric.unit === "seconds") return `${(metric.value / 60).toFixed(1)} 分钟`;
    return metric.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
export function comparisonText(metric: UsageV2Metric) {
    const comparison = metric.comparison;
    if (!comparison) return "";
    if (comparison.reason === "zero_baseline") return "对比期为 0，不计算涨跌幅";
    if (comparison.reason || comparison.value === null) return "缺少可比数据";
    if (comparison.unit === "percentage_points") return `较对比期 ${(comparison.absoluteDelta ?? 0) >= 0 ? "+" : ""}${(comparison.absoluteDelta ?? 0).toFixed(1)} 个百分点`;
    if (comparison.relativeDelta === null) return "缺少可比数据";
    return `较对比期 ${comparison.relativeDelta >= 0 ? "+" : ""}${(comparison.relativeDelta * 100).toFixed(1)}%`;
}
export function metricCoverageText(metric: UsageV2Metric) {
    return `${metricText(metric)}${metric.state === "partial" ? "（部分覆盖）" : ""}；可用样本 ${metric.availableCount}，缺失 ${metric.missingCount}`;
}
export function perActivePersonCost(metrics: UsageV2Metrics): UsageV2Metric {
    const cost = metrics.generationBookedCny,
        people = metrics.activePeople;
    const available = cost.value !== null && people.value !== null && people.value > 0 && cost.state !== "unavailable" && people.state !== "unavailable";
    return {
        value: available ? cost.value! / people.value! : null,
        unit: "CNY",
        currency: "CNY",
        basis: "booked",
        state: !available ? "unavailable" : cost.state === "partial" || people.state === "partial" ? "partial" : "available",
        numerator: cost.value ?? undefined,
        denominator: people.value ?? undefined,
        availableCount: cost.availableCount,
        missingCount: cost.missingCount + people.missingCount,
        definitionId: "booked-per-recorded-active-person-v1",
        definition: "同一部门、范围及归属口径的已记账生成金额 / 至少有一条已记录业务活动的去重员工；不是部门编制人数，不是人员效率。",
        source: "generationBookedCny / activePeople",
    };
}
export function snapshotText(meta: UsageV2Meta) {
    const date = (value: string) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知");
    if (meta.dataMode === "live_existing_facts") return `实时只读事务快照：${date(meta.asOf)}（北京时间）；迟来结果或撤销会改变下次读取。`;
    const snapshot = meta.snapshot;
    const live = `今日实时 · 北京时间边界 ${meta.liveFrom ? date(meta.liveFrom) : "未提供"}；本次只读事务观察 ${date(meta.asOf)}（北京时间）；迟来结果或撤销会改变下次读取。`;
    if (meta.dataMode === "daily_history_live_today" && !snapshot) return `${live} 本期及对比期未包含历史日。`;
    const lag = typeof meta.lagSeconds === "number" && Number.isFinite(meta.lagSeconds) && meta.lagSeconds >= 0 ? `${Math.ceil(meta.lagSeconds).toLocaleString("zh-CN")} 秒` : "未提供";
    const history = `日事实快照 · ${snapshot ? `${snapshot.dayCount} 日；${snapshot.mixedSnapshots ? "混合刷新时点，不是统一观察快照" : "所选日刷新时点一致"}` : "快照日数 / 混合状态未提供"}；最旧 ${date(snapshot?.oldestComputedAt || meta.computedThrough)}；最新 ${date(snapshot?.newestComputedAt || meta.asOf)}（北京时间）。最旧快照距本次读取 ${lag}（服务端值，不是页面当前时间）。`;
    return meta.dataMode === "daily_history_live_today" ? `${live} 历史${history} 历史与今天不是统一历史观察快照。` : history;
}
export function pairOptimizationGroups(rows: UsageV2Quality["optimizationComparison"]) {
    const groups = new Map<string, { key: string; modelConfigId: string | null; boardKey: string | null; operationType: string; optimized?: UsageV2Metrics; unmarked?: UsageV2Metrics }>();
    for (const row of rows) {
        const key = JSON.stringify([row.modelConfigId, row.boardKey, row.operationType]);
        const group = groups.get(key) || { key, modelConfigId: row.modelConfigId, boardKey: row.boardKey, operationType: row.operationType };
        group[row.optimized ? "optimized" : "unmarked"] = row.metrics;
        groups.set(key, group);
    }
    return [...groups.values()];
}
/** User-controlled strings must never become spreadsheet formulas, including whitespace prefixes. */
export function excelSafeCell(value: unknown): string | number | boolean {
    if (typeof value === "number") return Number.isFinite(value) ? value : "不可用";
    if (typeof value === "boolean") return value;
    const text = value == null ? "不可用" : String(value);
    return /^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text;
}

/** Calendar offsets, not positions in sparse result arrays, define comparable days. */
export function alignDailyTrend(daily: UsageV2Daily[], comparison: UsageV2Daily[], from: string, to: string, comparisonFrom?: string) {
    const start = +new Date(from),
        end = +new Date(to),
        prior = comparisonFrom ? +new Date(comparisonFrom) : NaN;
    const currentByDay = new Map(daily.map((row) => [row.day, row]));
    const previousByDay = new Map(comparison.map((row) => [row.day, row]));
    const days = Math.min(366, Math.max(0, Math.ceil((end - start) / 86400000)));
    return Array.from({ length: days }, (_, index) => {
        const day = beijingDay(new Date(start + index * 86400000));
        return { day, current: currentByDay.get(day), previous: Number.isFinite(prior) ? previousByDay.get(beijingDay(new Date(prior + index * 86400000))) : undefined };
    });
}
