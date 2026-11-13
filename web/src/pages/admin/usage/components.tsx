import { DisplayText, DisplayTranslationScope, useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Alert, Button, Empty, Table, Tag, Tooltip } from "antd";
import type { EChartsOption } from "echarts";
import type { UsageV2Daily, UsageV2Dimension, UsageV2Heatmap, UsageV2Insight, UsageV2Meta, UsageV2Metric, UsageV2MetricKey, UsageV2Metrics, UsageV2Scope } from "@/services/api/usage-analytics-v2";
import { metricLabels, metricText, comparisonText, alignDailyTrend, snapshotText } from "./format";
import type { UsageReleaseAnnotation } from "../../../../../shared/usage-release-context";
import { publicationMarkLine } from "./release-marks";
const Chart = lazy(() => import("./chart"));
export type Drilldown = (filter: Partial<UsageV2Scope>) => void;
export function ChartPanel({ title, description, option, children, onSelect }: { title: string; description: string; option?: EChartsOption; children?: ReactNode; onSelect?: (index: number, name: string) => void }) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    return (
        <section className="wb-surface min-w-0 p-4 sm:p-5" aria-label={displayUi(title)}>
            <h3 className="font-semibold">{displayUi(title)}</h3>
            <p className="mb-4 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">{displayUi(description)}</p>
            {option ? (
                <Suspense
                    fallback={
                        <div className="flex h-72 items-center justify-center text-sm" role="status" data-usage-chart-loading>{staticUiText("正在加载图表…")}</div>
                    }
                >
                    <Chart option={option} label={displayUi(title)} onSelect={onSelect} />
                </Suspense>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={staticUiText("当前筛选没有可展示记录")} />
            )}
            {children}
        </section>
    );
}
export function MetricCards({ metrics, keys }: { metrics: UsageV2Metrics; keys: UsageV2MetricKey[] }) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    return (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={staticUiText("核心指标")}>
            {keys.map((key) => {
                const item = metrics[key];
                return (
                    <section
                        key={key}
                        className="wb-surface min-w-0 p-4"
                        data-usage-metric={`${metricLabels[key]}：${metricText(item)}${item.state === "partial" ? "（部分覆盖）" : item.state === "unavailable" ? "（未采集 / 缺少关联）" : ""}${comparisonText(item) ? ` · ${comparisonText(item)}` : ""}`}
                    >
                        <Tooltip
                            title={
                                <div>
                                    {displayUi(item.definition)}
                                    <br />{staticUiText("来源：")}{displayUi(item.source)}
                                    <br />{staticUiText("可用 ")}{item.availableCount}{staticUiText(" · 缺失 ")}{item.missingCount}
                                </div>
                            }
                        >
                            <h3 className="text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText(metricLabels[key])}</h3>
                        </Tooltip>
                        <p className="mb-1 mt-2 break-all text-2xl font-semibold tabular-nums">{displayUi(metricText(item))}</p>
                        {item.state !== "available" ? <Tag>{item.state === "partial" ? staticUiText("部分覆盖") : staticUiText("未采集 / 缺少关联")}</Tag> : null}
                        <p className="mt-1 min-h-5 text-xs leading-5 text-[var(--muted-foreground)]">{displayUi(comparisonText(item))}</p>
                    </section>
                );
            })}
        </div>
    );
}
export function Insights({ items, onDrilldown, fallback }: { items: UsageV2Insight[]; onDrilldown: Drilldown; fallback: string }) {
    const displayUi = useDisplayUiValue();
    const [openedEvidence, setOpenedEvidence] = useState<Record<string, boolean>>({});
    useUiLocale();
    return (
        <section className="wb-surface border-l-4 border-l-[var(--primary)] p-4 sm:p-5" aria-label={staticUiText("可核对结论")}>
            <h3 className="mb-2 font-semibold">{staticUiText("本页观察")}</h3>
            {items.length ? (
                items.map((item) => (
                    <div key={`${item.ruleId}:${JSON.stringify(item.drilldownFilter)}`} className="mt-2 text-sm leading-6">
                        <span>
                            {item.severity === "warning" ? staticUiText("注意 · ") : staticUiText("观察 · ")}
                            {displayUi(item.text)}
                        </span>
                        <details className="mt-1 text-xs text-[var(--muted-foreground)]" onToggle={event => {
                            const open = event.currentTarget.open;
                            setOpenedEvidence(current => ({ ...current, [`${item.ruleId}:${JSON.stringify(item.drilldownFilter)}`]: open }));
                        }}>
                            <summary className="cursor-pointer">{staticUiText("查看依据 · ")}{item.sampleCount}{staticUiText(" 个样本")}</summary>
                            <p className="mt-2">{staticUiText("规则：")}{item.ruleId}</p>
                            <DisplayTranslationScope visible={Boolean(openedEvidence[`${item.ruleId}:${JSON.stringify(item.drilldownFilter)}`])}><ul className="list-inside list-disc">
                                {Object.entries(item.evidence).map(([key, value]) => (
                                    <li key={key}>
                                        {key}：{typeof value === "string" ? <DisplayText text={value} /> : value ?? staticUiText("不可用")}
                                    </li>
                                ))}
                            </ul></DisplayTranslationScope>
                            {Object.keys(item.drilldownFilter).length ? (
                                <Button className="mt-2" size="small" onClick={() => onDrilldown(item.drilldownFilter)}>{staticUiText("按此依据下钻")}</Button>
                            ) : null}
                        </details>
                    </div>
                ))
            ) : (
                <p className="text-sm leading-6 text-[var(--muted-foreground)]">{displayUi(fallback)}</p>
            )}
        </section>
    );
}
export function Coverage({ meta }: { meta: UsageV2Meta }) {
    const displayUi = useDisplayUiValue();
    const [open, setOpen] = useState(false);
    useUiLocale();
    const unavailable = meta.coverage.filter((item) => item.state !== "available");
    return (
        <section className="wb-surface px-4 py-3 text-xs leading-6">
            <p data-testid="usage-snapshot">{displayUi(snapshotText(meta))}</p>
            <details className="mt-2" onToggle={event => setOpen(event.currentTarget.open)}>
                <summary className="cursor-pointer">{staticUiText("口径与数据覆盖 · ")}{unavailable.length ? staticUiText("{p0} 项存在缺口", { p0: `${unavailable.length}` }) : staticUiText("查看来源")} · {meta.dataMode === "daily_history_live_today" ? staticUiText("历史日事实 + 今日实时") : meta.dataMode === "persisted_daily_facts" ? staticUiText("读取已落库日事实") : staticUiText("实时读取现有事实")}
                </summary>
                <DisplayTranslationScope visible={open}><div className="mt-3 space-y-2">
                    <p>{staticUiText("指标版本 ")}{meta.metricVersion}{staticUiText("。迟来结果或撤销可能使对应日期待补算；多日混合快照不代表同一观察时刻。缺汇总时不会静默回源或显示过期结果。")}</p>
                    <p>{staticUiText("费用是历史已记账金额，不是供应商实付或财务对账；结果使用信号不等于正式采纳。零记录不代表没有使用。")}</p>
                    {meta.comparisonScope ? (
                        <p>{staticUiText("比较范围：")}{new Date(meta.comparisonScope.from).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}{staticUiText(" 至")}{" "}
                            {new Date(new Date(meta.comparisonScope.to).getTime() - 1).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}。
                        </p>
                    ) : null}
                    {meta.notes.map((note, i) => (
                        <p key={i}><DisplayText text={note} /></p>
                    ))}
                    {meta.coverage.map((item) => (
                        <div key={item.metric}>
                            <Tag>{item.state === "available" ? staticUiText("可用") : item.state === "partial" ? staticUiText("部分覆盖") : staticUiText("不可用")}</Tag>
                            {staticUiText(metricLabels[item.metric as UsageV2MetricKey]) || item.metric}{staticUiText("：匹配 ")}{item.matched}{staticUiText(" / 应有 ")}{item.eligible}{staticUiText("，未知 ")}{item.unknown}
                            {item.since ? staticUiText("；自 {p0}", { p0: `${item.since}` }) : ""}。<DisplayText text={item.notes.join("；")} />
                        </div>
                    ))}
                </div></DisplayTranslationScope>
            </details>
        </section>
    );
}
export function NotAvailable({ title, reason }: { title: string; reason: string }) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    return <Alert type="info" showIcon title={staticUiText("{p0} · 暂不可用", { p0: `${title}` })} description={displayUi(reason)} />;
}
export function DimensionTable({
    rows,
    label,
    onSelect,
    keys = ["activePeople", "generationRequests", "generatedImages", "successRate", "generationBookedCny", "resultUseRate", "formalAdoptionRate"],
    additionalMetrics = [],
}: {
    rows: UsageV2Dimension[];
    label: string;
    onSelect?: (row: UsageV2Dimension) => void;
    keys?: UsageV2MetricKey[];
    additionalMetrics?: Array<{ key: string; label: string; getMetric: (row: UsageV2Dimension) => UsageV2Metric }>;
}) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    return (
        <section className="wb-surface min-w-0 p-4 sm:p-5">
            <h3 className="mb-3 font-semibold">{displayUi(label)}{staticUiText("明细")}</h3>
            <Table<UsageV2Dimension>
                size="small"
                rowKey="key"
                dataSource={rows}
                scroll={{ x: 960 }}
                pagination={{ pageSize: 15, hideOnSinglePage: true, showSizeChanger: false }}
                columns={displayConfig([
                    {
                        title: label,
                        dataIndex: "label",
                        width: 170,
                        render: (value, row) =>
                            onSelect ? (
                                <Button type="link" className="!h-auto !whitespace-normal !p-0 !text-left" onClick={() => onSelect(row)}>
                                    <DisplayText text={value} />
                                </Button>
                            ) : (
                                value
                            ),
                    },
                    ...keys.map((key) => ({
                        title: staticUiText(metricLabels[key]),
                        key,
                        align: "right" as const,
                        sorter: (a: UsageV2Dimension, b: UsageV2Dimension) => (a.metrics[key].value ?? -Infinity) - (b.metrics[key].value ?? -Infinity),
                        render: (_: unknown, row: UsageV2Dimension) => (
                            <Tooltip title={<DisplayText text={row.metrics[key].definition} />}>
                                <span className="tabular-nums">
                                    <DisplayText text={metricText(row.metrics[key])} />
                                    {row.metrics[key].state === "partial" ? " *" : ""}
                                </span>
                            </Tooltip>
                        ),
                    })),
                    ...additionalMetrics.map(({ key, label, getMetric }) => ({
                        title: label,
                        key,
                        align: "right" as const,
                        sorter: (a: UsageV2Dimension, b: UsageV2Dimension) => (getMetric(a).value ?? -Infinity) - (getMetric(b).value ?? -Infinity),
                        render: (_: unknown, row: UsageV2Dimension) => {
                            const metric = getMetric(row);
                            return (
                                <Tooltip title={<DisplayText text={staticUiText("{p0} 分母：{p1} 人", { p0: `${metric.definition}`, p1: `${metric.denominator ?? staticUiText("不可用")}` })} />}>
                                    <span className="tabular-nums">
                                        <DisplayText text={metricText(metric)} />
                                        {metric.state === "partial" ? " *" : ""}
                                    </span>
                                </Tooltip>
                            );
                        },
                    })),
                ], "columns", rows)}
            />
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">{staticUiText("* 部分覆盖；不可用不是 0。排序仅用于查阅记录，不代表人员或作品评价。")}</p>
        </section>
    );
}
export function barOption(rows: Array<{ label: string; value: number | null }>, name: string): EChartsOption | undefined {
    if (!rows.length || rows.every((row) => row.value === null)) return undefined;
    return {
        grid: { left: 12, right: 24, top: 15, bottom: 10, containLabel: true },
        xAxis: { type: "value" },
        yAxis: { type: "category", data: rows.map((row) => row.label), inverse: true, axisLabel: { width: 110, overflow: "truncate" } },
        series: [{ name, type: "bar", data: rows.map((row) => row.value), barMaxWidth: 22 }],
    };
}
export function Trend({
    daily,
    comparisonDaily = [],
    from,
    to,
    comparisonFrom,
    onDrilldown,
    metric = "generatedImages",
    title = "每日出图趋势",
    publications,
}: {
    daily: UsageV2Daily[];
    comparisonDaily?: UsageV2Daily[];
    from: string;
    to: string;
    comparisonFrom?: string;
    onDrilldown: Drilldown;
    metric?: UsageV2MetricKey;
    title?: string;
    publications?: UsageReleaseAnnotation[];
}) {
    const displayUi = useDisplayUiValue();
    const [detailsOpen, setDetailsOpen] = useState(false);
    useUiLocale();
    const points = alignDailyTrend(daily, comparisonDaily, from, to, comparisonFrom);
    const option: EChartsOption | undefined =
        daily.length || comparisonDaily.length || publications?.length
            ? {
                  tooltip: { trigger: "axis", renderMode: "richText" },
                  legend: { bottom: 0 },
                  grid: { left: 10, right: 20, top: 20, bottom: 45, containLabel: true },
                  xAxis: { type: "category", data: points.map((row) => row.day) },
                  yAxis: { type: "value" },
                  series: [
                      { name: "本期", type: "line", data: points.map((row) => row.current?.metrics[metric].value ?? null), showSymbol: true, connectNulls: false, markLine: publicationMarkLine(publications) },
                      ...(comparisonDaily.length ? [{ name: "对比期（按周期第 N 天对齐）", type: "line" as const, data: points.map((row) => row.previous?.metrics[metric].value ?? null), lineStyle: { type: "dashed" as const }, connectNulls: false }] : []),
                  ],
              }
            : undefined;
    return (
        <ChartPanel
            title={displayUi(title)}
            description={staticUiText("{p0}；点击日期收窄所有页签。空缺不补零，对比线按周期中的相同序号对齐。", { p0: `${staticUiText(metricLabels[metric])}` })}
            option={option}
            onSelect={(index) => {
                const day = points[index]?.day;
                if (day) onDrilldown({ from: `${day}T00:00:00+08:00`, to: new Date(new Date(`${day}T00:00:00+08:00`).getTime() + 86400000).toISOString() });
            }}
        >
            <details className="mt-2 text-xs" onToggle={event => setDetailsOpen(event.currentTarget.open)}>
                <summary className="cursor-pointer">{staticUiText("日期准确值与键盘下钻")}</summary>
                <DisplayTranslationScope visible={detailsOpen}><div className="mt-2 max-h-48 overflow-auto">
                    {daily.map((row) => (
                        <div key={row.day} className="flex items-center justify-between">
                            <Button size="small" type="link" onClick={() => onDrilldown({ from: `${row.day}T00:00:00+08:00`, to: new Date(new Date(`${row.day}T00:00:00+08:00`).getTime() + 86400000).toISOString() })}>
                                {row.day}
                            </Button>
                            <span><DisplayText text={metricText(row.metrics[metric])} /></span>
                        </div>
                    ))}
                </div></DisplayTranslationScope>
            </details>
        </ChartPanel>
    );
}
export function Heatmap({ rows }: { rows: UsageV2Heatmap[] }) {
    useUiLocale();
    return (
        <ChartPanel
            title={staticUiText("使用时段分布")}
            description={staticUiText("北京时间 · 已记录操作 / 任务数量，不是使用时长。色深反映记录数量，不反映工作强度。")}
            option={
                rows.length
                    ? {
                          grid: { left: 45, right: 15, top: 15, bottom: 65 },
                          xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => `${i}时`), splitArea: { show: true } },
                          yAxis: { type: "category", data: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"], splitArea: { show: true } },
                          visualMap: { min: 0, max: Math.max(1, ...rows.map((row) => row.count)), calculable: false, orient: "horizontal", left: "center", bottom: 0 },
                          series: [{ type: "heatmap", data: rows.map((row) => [row.hour, row.weekday, row.count]) }],
                      }
                    : undefined
            }
        >
            <details className="mt-2 text-xs">
                <summary className="cursor-pointer">{staticUiText("查看时段记录数")}</summary>
                <div className="mt-2 max-h-40 overflow-auto">
                    {rows.map((row) => (
                        <p key={`${row.weekday}-${row.hour}`}>{staticUiText(["周一", "周二", "周三", "周四", "周五", "周六", "周日"][row.weekday])} {row.hour}:00 · {row.count}{staticUiText(" 条记录")}</p>
                    ))}
                </div>
            </details>
        </ChartPanel>
    );
}
