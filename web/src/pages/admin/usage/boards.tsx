import { DisplayText, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Table } from "antd";
import type { UsageV2Boards } from "@/services/api/usage-analytics-v2";
import { barOption, ChartPanel, DimensionTable, Insights, NotAvailable, type Drilldown } from "./components";
import { metricText } from "./format";
import ParameterDistribution from "./components/parameter-distribution";
export default function Boards({ data, onDrilldown }: { data: UsageV2Boards; onDrilldown: Drilldown }) {
    const displayConfig = useDisplayConfig();
    useUiLocale();
    return (
        <div className="space-y-4">
            <Insights items={data.insights} onDrilldown={onDrilldown} fallback={staticUiText("板块数据用于定位功能使用与采集缺口。没有会话关联时，不把访问次数除以任务数冒充转化率。")} />
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <ChartPanel
                    title={staticUiText("板块生成任务")}
                    description={staticUiText("点击板块将同一筛选应用到全部页签与明细。")}
                    option={barOption(
                        data.boards.map((row) => ({ label: row.label, value: row.metrics.generationRequests.value })),
                        "生成任务",
                    )}
                    onSelect={(index) => {
                        if (data.boards[index]) onDrilldown({ boardKeys: [data.boards[index].key] });
                    }}
                />
                <ChartPanel
                    title={staticUiText("功能触达人次覆盖")}
                    description={staticUiText("至少操作一次该控件的人数占所在板块符合条件人数；不是点击次数占比。")}
                    option={barOption(
                        data.controlUsage.slice(0, 15).map((row) => ({ label: row.label, value: row.rate.value === null ? null : row.rate.value * 100 })),
                        "使用人员占比 %",
                    )}
                    onSelect={(index) => {
                        if (data.controlUsage[index]) onDrilldown({ boardKeys: [data.controlUsage[index].boardKey] });
                    }}
                />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
                <NotAvailable title={staticUiText("访问 → 提交的会话转化")} reason={data.conversion.definition} />
                <NotAvailable title={staticUiText("离开前放弃点")} reason={data.abandonment.definition} />
            </div>
            <DimensionTable rows={data.boards} label={staticUiText("板块")} onSelect={(row) => onDrilldown({ boardKeys: [row.key] })} />
            <section className="wb-surface min-w-0 p-4">
                <h3 className="mb-3 font-semibold">{staticUiText("功能使用明细")}</h3>
                <Table
                    rowKey={(row) => `${row.boardKey}:${row.controlKey}`}
                    dataSource={data.controlUsage}
                    size="small"
                    scroll={{ x: 650 }}
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    columns={displayConfig([
                        { title: staticUiText("板块"), dataIndex: "boardKey" },
                        { title: staticUiText("控件"), dataIndex: "label" },
                        { title: staticUiText("使用人数"), dataIndex: "users", sorter: (a, b) => a.users - b.users },
                        { title: staticUiText("可比人数"), dataIndex: "eligibleUsers" },
                        { title: staticUiText("人员覆盖率"), render: (_, row) => <DisplayText text={metricText(row.rate)} /> },
                    ], "columns", data.controlUsage)}
                />
            </section>
            <ParameterDistribution rows={data.parameters} title={staticUiText("已记录参数分布 · 按板块")} />
        </div>
    );
}
