import { App, Button, Table } from "antd";
import { useState } from "react";
import { USAGE_PEOPLE_COMPARISON_KEYS, type UsagePeopleComparison } from "@/services/api/usage-people-comparison";
import { metricCoverageText, metricLabels, metricText, snapshotText } from "./format";
import { exportExcel, type ExportRow } from "./exports";
import type { UsageV2Metric } from "@/services/api/usage-analytics-v2";

function comparisonMetric(metric: UsageV2Metric) {
    return <div><div>{metricCoverageText(metric)}</div>{metric.unit === "ratio" && typeof metric.denominator === "number" ? <div className="mt-1 text-xs">分子 {metric.numerator ?? "未提供"} / 分母 {metric.denominator}</div> : null}</div>;
}

export function peopleComparisonExport(data: UsagePeopleComparison): { rows: ExportRow[]; notes: ExportRow[] } {
    const rows: ExportRow[] = [];
    for (const key of USAGE_PEOPLE_COMPARISON_KEYS) {
        for (const [identity, metric] of [["团队合并基线", data.team.metrics[key]], ...data.people.map(person => [person.displayName, person.metrics[key]] as const)] as const)
            rows.push({ 指标: key === "activeDays" ? "个人活跃天数／团队活跃人日" : metricLabels[key], 对象: identity, 值与覆盖: metricCoverageText(metric), 数值: metric.value, 精确金额: metric.amount ?? null, 分子: metric.numerator ?? null, 分母: metric.denominator ?? null, 可用样本: metric.availableCount, 缺失样本: metric.missingCount, 口径: metric.definition });
    }
    for (const [label, metric] of [["按有记录活跃员工人均记账金额", data.team.perActivePersonBookedCny], ["按范围名册人均记账金额", data.team.perRosterPersonBookedCny]] as const)
        rows.push({ 指标: label, 对象: "团队人均", 值与覆盖: metricCoverageText(metric), 数值: metric.value, 精确金额: metric.amount ?? null, 分子: metric.numerator ?? null, 分母: metric.denominator ?? null, 可用样本: metric.availableCount, 缺失样本: metric.missingCount, 口径: metric.definition });
    return { rows, notes: [
        { 项目: "原共享筛选", 说明: JSON.stringify(data.meta.scope) },
        { 项目: "所选人员 ID", 说明: data.selectedUserIds.join(",") },
        { 项目: "范围名册人数", 说明: data.team.rosterPeople },
        { 项目: "本期有记录活跃人数", 说明: data.team.metrics.activePeople.value },
        { 项目: "分母与团队定义", 说明: data.team.populationDefinition },
        { 项目: "数据观察", 说明: snapshotText(data.meta) },
        { 项目: "指标版本", 说明: data.meta.metricVersion },
        { 项目: "限制", 说明: "同一次原共享范围读取；计数/金额是团队合计，率为合并分子/分母，时延为全集原样本分位数。费用是已记账而非供应商实付。无原始提示词、媒体或员工能力结论。" },
    ] };
}

export default function PeopleComparison({ data, onProfile }: { data: UsagePeopleComparison; onProfile: (id: string) => void }) {
    const { message } = App.useApp();
    const [exporting, setExporting] = useState(false);
    const download = async () => {
        if (exporting) return;
        setExporting(true);
        try { const output = peopleComparisonExport(data); await exportExcel(output.rows, "人员与原范围团队对照", output.notes); }
        catch { message.error("对照导出失败，请手动重试。"); }
        finally { setExporting(false); }
    };
    return <section className="wb-surface min-w-0 space-y-3 p-4" data-testid="usage-people-comparison">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">同周期人员与原范围团队对照 · {data.people.length} 人</h3>
            <Button loading={exporting} onClick={() => void download()}>导出人员团队对照 Excel</Button>
        </div>
        <p className="text-sm">范围名册 {data.team.rosterPeople} 人；本期有记录活跃 {metricText(data.team.metrics.activePeople)} 人。团队保留原共享筛选，不只包含所选人员。</p>
        <p className="text-xs leading-5">{data.team.populationDefinition}</p>
        <Table rowKey="key" size="small" pagination={false} scroll={{ x: Math.max(950, 430 + data.people.length * 220) }}
            dataSource={USAGE_PEOPLE_COMPARISON_KEYS.map(key => ({ key, label: key === "activeDays" ? "个人活跃天数／团队活跃人日" : metricLabels[key] }))}
            columns={[
                { title: "指标", dataIndex: "label", width: 180 },
                { title: "原范围团队合并基线（非个人均值）", key: "team", width: 250, render: (_, row) => comparisonMetric(data.team.metrics[row.key]) },
                ...data.people.map(person => ({ title: <Button type="link" className="!p-0" onClick={() => onProfile(person.userId)}>{person.displayName} · 查看画像</Button>, key: person.userId, width: 220, render: (_: unknown, row: { key: typeof USAGE_PEOPLE_COMPARISON_KEYS[number] }) => comparisonMetric(person.metrics[row.key]) })),
            ]} />
        <p className="text-xs">窄屏可在表格内左右滑动查看全部人员；合并比率的分子、分母单列，缺失不补零。</p>
        <div className="grid gap-3 md:grid-cols-2">
            {[["按有记录活跃员工", data.team.perActivePersonBookedCny], ["按范围名册", data.team.perRosterPersonBookedCny]].map(([label, metric]) => {
                const value = metric as UsagePeopleComparison["team"]["perActivePersonBookedCny"];
                return <div key={String(label)} className="text-sm"><p>{String(label)}人均已记账金额：{metricCoverageText(value)}</p><p className="mt-1 text-xs">分母 {value.denominator} 人；{value.definition}</p></div>;
            })}
        </div>
        <p className="text-xs">本表所有人员与团队来自同一次服务端只读事务，不拼接列表旧值。{snapshotText(data.meta)}</p>
    </section>;
}
