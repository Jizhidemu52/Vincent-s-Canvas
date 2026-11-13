import { useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, Table } from "antd";
import type { UsageV2Flows } from "@/services/api/usage-analytics-v2";
import { barOption, ChartPanel, Insights, NotAvailable, type Drilldown } from "./components";
export default function Flows({ data, onDrilldown }: { data: UsageV2Flows; onDrilldown: Drilldown }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const stages = data.resultUse.stages;
    return (
        <div className="space-y-4">
            <Insights items={data.insights} onDrilldown={onDrilldown} fallback={staticUiText("先看可靠的结果去向覆盖。没有显式会话 / 结果链时，不把相邻时间戳拼接成员工路径。")} />
            {data.pathCoverage.state === "unavailable" ? (
                <NotAvailable title={staticUiText("完整操作路径与有序漏斗")} reason={data.pathCoverage.definition} />
            ) : (
                <ChartPanel
                    title={staticUiText("已关联操作路径")}
                    description={staticUiText("仅含显式关联的操作，不包含未关联历史记录。")}
                    option={data.links.length ? { series: [{ type: "sankey", data: data.nodes.map((node) => ({ name: node.key })), links: data.links.map((link) => ({ source: link.source, target: link.target, value: link.count })) }] } : undefined}
                />
            )}
            <Alert type="info" showIcon title={staticUiText("阶段覆盖不是有序漏斗")} description={staticUiText("同一结果可以跳过下载直接进入项目；阶段之间不必单调递减，不能把这些数量解释为逐步转化率。")} />
            <ChartPanel
                title={staticUiText("生成结果去向 · 阶段覆盖")}
                description={staticUiText("本期提交队列，截至 {p0}。宽口径使用与正式采纳分列。", { p0: `${new Date(data.resultUse.asOf).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` })}
                option={barOption(
                    stages.map((stage) => ({ label: stage.label, value: stage.count })),
                    "去重结果数",
                )}
            />
            <section className="wb-surface min-w-0 p-4">
                <h3 className="mb-3 font-semibold">{staticUiText("结果关联与证据明细")}</h3>
                <p className="mb-3 text-sm">{staticUiText("生成图片 ")}{data.resultUse.generatedImages}{staticUiText(" · 已关联 ")}{data.resultUse.linkedImages}{staticUiText(" · 未关联 ")}{data.resultUse.unlinkedImages}{staticUiText(" · 已使用 ")}{data.resultUse.usedImages}{staticUiText(" · 正式采纳 ")}{data.resultUse.formallyAdoptedImages}
                </p>
                <Table
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={stages}
                    columns={displayConfig([
                        { title: staticUiText("阶段"), dataIndex: "label" },
                        { title: staticUiText("去重结果"), dataIndex: "count" },
                        { title: staticUiText("证据来源"), dataIndex: "evidence", render: (value) => staticUiText(({ server_confirmed: "服务端确认", client_reported: "客户端回执", mixed: "混合来源" })[value as "mixed"]) },
                    ], "columns", stages)}
                />
                {data.resultUse.notes.map((note, index) => (
                    <p key={index} className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">
                        {displayUi(note)}
                    </p>
                ))}
            </section>
            {data.transfers.length ? (
                <section className="wb-surface p-4">
                    <h3 className="mb-3 font-semibold">{staticUiText("有显式来源的跨板块流转")}</h3>
                    <Table
                        rowKey={(row) => `${row.source}:${row.target}`}
                        dataSource={data.transfers}
                        pagination={false}
                        columns={displayConfig([
                            { title: staticUiText("来源"), dataIndex: "source" },
                            { title: staticUiText("目标"), dataIndex: "target" },
                            { title: staticUiText("次数"), dataIndex: "count" },
                        ], "columns", data.transfers)}
                    />
                </section>
            ) : (
                <NotAvailable title={staticUiText("跨板块流转")} reason="当前没有足够的显式来源关联。不会用跨页面访问顺序或相近发生时间猜测流转。" />
            )}
        </div>
    );
}
