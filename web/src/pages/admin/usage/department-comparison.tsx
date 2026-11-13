import { DisplayText, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { App, Button, Select, Table } from "antd";
import { useState } from "react";
import type { UsageV2Dimension, UsageV2Meta, UsageV2Metric, UsageV2MetricKey } from "@/services/api/usage-analytics-v2";
import { exportExcel } from "./exports";
import { metricCoverageText, metricLabels, metricText, perActivePersonCost, snapshotText } from "./format";

/** Same-scope difference, never a causal or performance judgment. Partial coverage is not comparable. */
export function departmentDifference(a: UsageV2Metric, b: UsageV2Metric): string {
    if (a.state !== "available" || b.state !== "available" || a.value === null || b.value === null || !Number.isFinite(a.value) || !Number.isFinite(b.value) || a.missingCount > 0 || b.missingCount > 0) return "覆盖不完整，不计算差异";
    if (a.unit !== b.unit || a.definitionId !== b.definitionId) return "口径不同，不计算差异";
    const delta = a.value - b.value;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
    if (a.unit === "ratio") return `${sign}${(Math.abs(delta) * 100).toFixed(1)} 个百分点`;
    const absolute = metricText({ ...a, value: Math.abs(delta), amount: undefined });
    return `${sign}${absolute}；${b.value === 0 ? "B 为 0，不计算相对差异" : `相对 B ${delta > 0 ? "+" : ""}${((delta / b.value) * 100).toFixed(1)}%`}`;
}

const keys: UsageV2MetricKey[] = ["activePeople", "generationRequests", "generatedImages", "generationBookedCny", "successRate", "resultUseRate", "formalAdoptionRate", "totalMsP50", "totalMsP90", "costPerUsedImage"];
export function departmentComparisonRows(a: UsageV2Dimension, b: UsageV2Dimension) {
    return [...keys.map((key) => ({ key, label: metricLabels[key], a: a.metrics[key], b: b.metrics[key] })), { key: "perActivePerson", label: "每位有记录活跃员工的已记账金额", a: perActivePersonCost(a.metrics), b: perActivePersonCost(b.metrics) }].map(
        (row) => ({ ...row, difference: departmentDifference(row.a, row.b) }),
    );
}

export default function DepartmentComparison({ departments, meta }: { departments: UsageV2Dimension[]; meta: UsageV2Meta }) {
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const { message } = App.useApp();
    const [selected, setSelected] = useState<[string, string] | null>(null);
    const [exporting, setExporting] = useState(false);
    const candidates = departments.filter((row) => row.key !== "unassigned" && !row.key.startsWith("unknown"));
    const a = candidates.find((row) => row.key === selected?.[0]) || candidates[0];
    const b = candidates.find((row) => row.key === selected?.[1] && row.key !== a?.key) || candidates.find((row) => row.key !== a?.key);
    if (!a || !b) return <p className="text-sm text-[var(--muted-foreground)]">{staticUiText("部门 A/B 对照需要当前筛选中至少两个有记录的已知部门；未记录与未知归属不补零、不猜配。")}</p>;
    const rows = departmentComparisonRows(a, b);
    const download = async () => {
        if (exporting) return;
        setExporting(true);
        try {
            await exportExcel(
                rows.map((row) => ({
                    指标: row.label,
                    A部门: a.label,
                    A值与覆盖: metricCoverageText(row.a),
                    A分子: row.a.numerator ?? null,
                    A分母: row.a.denominator ?? null,
                    B部门: b.label,
                    B值与覆盖: metricCoverageText(row.b),
                    B分子: row.b.numerator ?? null,
                    B分母: row.b.denominator ?? null,
                    "差异 A−B": row.difference,
                })),
                "部门同周期对照",
                [
                    { 项目: "统计范围", 说明: JSON.stringify(meta.scope) },
                    { 项目: "数据观察", 说明: snapshotText(meta) },
                    { 项目: "对照口径", 说明: "同范围、同归属口径；率使用各部门合并分子分母，不平均个人率。人均费用分母是有记录活跃员工，不是编制人数。差异不是能力、效率或因果结论。" },
                ],
            );
        } catch {
            message.error(staticUiText("对照表导出失败，请手动重试。"));
        } finally {
            setExporting(false);
        }
    };
    const renderMetric = (value: UsageV2Metric) => (
        <div>
            <div><DisplayText text={metricCoverageText(value)} /></div>
            {typeof value.denominator === "number" ? (
                <div className="text-xs text-[var(--muted-foreground)]">{staticUiText("分子 ")}{value.numerator ?? staticUiText("未提供")}{staticUiText(" / 分母 ")}{value.denominator}
                </div>
            ) : null}
        </div>
    );
    return (
        <section className="wb-surface min-w-0 space-y-3 p-4" data-testid="usage-department-comparison">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{staticUiText("部门 A/B 同周期对照")}</h3>
                <Button loading={exporting} onClick={() => void download()}>{staticUiText("导出部门对照 Excel")}</Button>
            </div>
            <p className="text-sm">{staticUiText("部门率按各自合并分子 / 分母计算，不平均个人百分比。人均金额按有记录活跃人数，不按编制人数；差异不表示人员能力或效率。")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
                <Select aria-label={staticUiText("对照部门 A")} value={a.key} options={displayConfig(candidates.map((row) => ({ value: row.key, label: `A · ${row.label}` })), "options")} onChange={(value) => setSelected([value, b.key])} />
                <Select aria-label={staticUiText("对照部门 B")} value={b.key} options={displayConfig(candidates.filter((row) => row.key !== a.key).map((row) => ({ value: row.key, label: `B · ${row.label}` })), "options")} onChange={(value) => setSelected([a.key, value])} />
            </div>
            <Table
                rowKey="key"
                size="small"
                pagination={false}
                scroll={{ x: 900 }}
                dataSource={rows}
                columns={displayConfig([
                    { title: staticUiText("指标"), dataIndex: "label", width: 180 },
                    { title: `A · ${a.label}`, dataIndex: "a", render: renderMetric },
                    { title: `B · ${b.label}`, dataIndex: "b", render: renderMetric },
                    { title: staticUiText("差异 A − B"), dataIndex: "difference", width: 220, render: value => <DisplayText text={value} /> },
                ], "columns", rows)}
            />
            <p className="text-xs text-[var(--muted-foreground)]"><DisplayText text={snapshotText(meta)} />{staticUiText(" 同期结果观察可能来自不同刷新时点，不据此推断变化原因。")}</p>
        </section>
    );
}
