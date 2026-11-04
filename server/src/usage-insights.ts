import type {
    UsageV2Insight,
    UsageV2Metrics,
    UsageV2Dimension,
    UsageV2Heatmap,
    UsageV2Metric,
} from "../../shared/usage-analytics-v2";
type InsightContext = {
    models?: UsageV2Dimension[];
    boards?: UsageV2Dimension[];
    hourly?: UsageV2Heatmap[];
    collectionGaps?: { current: number; previous: number | null };
    spend?: {
        targetDay: string;
        baselineFrom: string;
        baselineDays: 30;
        people: Array<{ userId: string; name: string; current: UsageV2Metric; baseline: UsageV2Metric }>;
    };
};
const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Neutral, deterministic, aggregated evidence only. No employee capability/performance inference. */
export function usageInsights(metrics: UsageV2Metrics, context: InsightContext = {}): UsageV2Insight[] {
    const insights: UsageV2Insight[] = [];
    const requests = metrics.generationRequests.value ?? 0;
    const success = metrics.successRate;
    if ((success.denominator ?? 0) >= 20 && success.value !== null && success.value < 0.8)
        insights.push({
            ruleId: "terminal-success-below-80-v1",
            severity: "warning",
            text: "已确定成功或失败的请求中，成功率低于 80%；请结合原因分类核查。",
            sampleCount: success.denominator!,
            evidence: {
                succeeded: success.numerator ?? 0,
                terminalRequests: success.denominator!,
                successRate: success.value,
            },
            drilldownFilter: {},
        });
    const images = metrics.generatedImages;
    if (
        requests >= 20 &&
        (images.comparison?.value ?? 0) >= 20 &&
        images.comparison?.relativeDelta != null &&
        Math.abs(images.comparison.relativeDelta) >= 0.15
    )
        insights.push({
            ruleId: "image-count-change-15-v1",
            severity: "info",
            text: `本期已保存图片数量较对比期${images.comparison.relativeDelta > 0 ? "增加" : "减少"}，这是软件记录数量变化，不是人员效率评价。`,
            sampleCount: requests,
            evidence: {
                current: images.value,
                previous: images.comparison.value,
                relativeDelta: images.comparison.relativeDelta,
            },
            drilldownFilter: {},
        });
    if (metrics.generationBookedCny.missingCount > 0)
        insights.push({
            ruleId: "missing-booked-history-v1",
            severity: "warning",
            text: "部分成功任务缺少成功结算历史；显示金额仅为已知记账部分，不按当前价格补估。",
            sampleCount: metrics.generationBookedCny.availableCount + metrics.generationBookedCny.missingCount,
            evidence: {
                known: metrics.generationBookedCny.availableCount,
                missing: metrics.generationBookedCny.missingCount,
            },
            drilldownFilter: {},
        });
    let modelAlerts = 0;
    for (const row of context.models ?? []) {
        const currentSuccess = row.metrics.succeeded.value,
            currentFailed = row.metrics.failed.value;
        const comparisonSuccess = row.metrics.succeeded.comparison?.value,
            comparisonFailed = row.metrics.failed.comparison?.value;
        if (
            modelAlerts >= 5 ||
            row.key === "unknown" ||
            row.metrics.successRate.state !== "available" ||
            row.metrics.successRate.comparison?.reason === "insufficient_data" ||
            !count(currentSuccess) ||
            !count(currentFailed) ||
            !count(comparisonSuccess) ||
            !count(comparisonFailed)
        )
            continue;
        const currentTerminal = currentSuccess + currentFailed,
            comparisonTerminal = comparisonSuccess + comparisonFailed;
        if (currentTerminal < 20 || comparisonTerminal < 20 || currentFailed < 5 || comparisonFailed === 0) continue;
        const currentFailureRate = currentFailed / currentTerminal,
            comparisonFailureRate = comparisonFailed / comparisonTerminal;
        if (currentFailureRate < comparisonFailureRate * 2 || currentFailureRate - comparisonFailureRate < 0.1)
            continue;
        insights.push({
            ruleId: "model-terminal-failure-double-v1",
            severity: "warning",
            text: `${row.label} 的终态请求失败率至少为所选对比期的 2 倍，且增加至少 10 个百分点；请下钻核对失败类别及样本组成。`,
            sampleCount: currentTerminal,
            evidence: {
                currentFailed,
                currentTerminal,
                comparisonFailed,
                comparisonTerminal,
                currentFailureRate,
                comparisonFailureRate,
                thresholdRatio: 2,
                minimumDifferencePoints: 10,
            },
            drilldownFilter: { modelConfigIds: [row.key] },
        });
        modelAlerts++;
    }
    let boardAlerts = 0;
    for (const row of context.boards ?? []) {
        const visits = row.metrics.visits,
            tasks = row.metrics.generationRequests;
        if (
            boardAlerts >= 3 ||
            row.key === "unknown" ||
            visits.state !== "available" ||
            tasks.state !== "available" ||
            !count(visits.value) ||
            !count(tasks.value) ||
            visits.value < 100 ||
            tasks.value > visits.value * 0.05
        )
            continue;
        insights.push({
            ruleId: "visits-many-tasks-few-v1",
            severity: "info",
            text: `${row.label} 已记录访问较多、生成任务较少；两类记录没有逐次会话关联，不是访问转化率，也不能据此认定功能不好用。`,
            sampleCount: visits.value,
            evidence: {
                visits: visits.value,
                generationTasks: tasks.value,
                minimumVisits: 100,
                taskPerVisitRecordThreshold: 0.05,
            },
            drilldownFilter: { boardKeys: [row.key] },
        });
        boardAlerts++;
    }
    const gaps = context.collectionGaps;
    if (
        gaps &&
        count(gaps.current) &&
        count(gaps.previous) &&
        gaps.previous >= 5 &&
        gaps.current >= gaps.previous * 2
    ) {
        insights.push({
            ruleId: "reported-gap-increase-v1",
            severity: "warning",
            text: "本期客户端已报告的丢弃数量至少为对比期的 2 倍；仅反映已上报部分，不代表全部缺口，也不是数据丢失率。",
            sampleCount: gaps.current + gaps.previous,
            evidence: {
                currentReported: gaps.current,
                comparisonReported: gaps.previous,
                thresholdRatio: 2,
                minimumComparisonReported: 5,
            },
            drilldownFilter: {},
        });
    }
    const hours = (context.hourly ?? []).filter(
        (row) => count(row.weekday) && row.weekday <= 6 && count(row.hour) && row.hour <= 23 && count(row.count),
    );
    const total = hours.reduce((sum, row) => sum + row.count, 0);
    const peak = [...hours].sort((a, b) => b.count - a.count || a.weekday - b.weekday || a.hour - b.hour)[0];
    if (peak && total >= 100 && peak.count / total >= 0.15)
        insights.push({
            ruleId: "recorded-activity-peak-v1",
            severity: "info",
            text: `本范围记录最集中的时段为周${["一", "二", "三", "四", "五", "六", "日"][peak.weekday]} ${String(peak.hour).padStart(2, "0")}:00–${String(peak.hour).padStart(2, "0")}:59（北京时间）；这是已记录活动分布，不是持续使用时长。`,
            sampleCount: total,
            evidence: {
                weekdayMondayZero: peak.weekday,
                hourBeijing: peak.hour,
                peakRecords: peak.count,
                totalRecords: total,
                recordShare: peak.count / total,
            },
            drilldownFilter: {},
        });
    const money = (value: string | undefined) => {
        if (!value || !/^\d{1,30}(?:\.\d{1,6})?$/.test(value)) return null;
        const [whole, fraction = ""] = value.split(".");
        return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
    };
    let spendAlerts = 0;
    for (const row of context.spend?.people ?? []) {
        if (
            spendAlerts >= 3 ||
            row.current.state !== "available" ||
            row.baseline.state !== "available" ||
            row.current.missingCount ||
            row.baseline.missingCount ||
            row.current.availableCount < 1 ||
            row.baseline.availableCount < 10
        )
            continue;
        const current = money(row.current.amount),
            baseline = money(row.baseline.amount);
        if (current === null || baseline === null || baseline <= 0n || current * 30n < baseline * 3n) continue;
        insights.push({
            ruleId: "personal-booked-day-above-30-day-mean-v1",
            severity: "info",
            text: `${row.name} 在 ${context.spend!.targetDay} 的已记账生成金额至少为此前 30 个完整自然日日均值的 3 倍。仅核对同一筛选内按提交日归属的成功任务账本，不据此评价人员表现。`,
            sampleCount: row.current.availableCount,
            evidence: {
                targetDay: context.spend!.targetDay,
                baselineFrom: context.spend!.baselineFrom,
                baselineDays: 30,
                currentBookedCny: row.current.amount!,
                baselineBookedCny: row.baseline.amount!,
                currentKnownTasks: row.current.availableCount,
                baselineKnownTasks: row.baseline.availableCount,
                thresholdRatio: 3,
            },
            drilldownFilter: { userIds: [row.userId] },
        });
        spendAlerts++;
    }
    return insights;
}
