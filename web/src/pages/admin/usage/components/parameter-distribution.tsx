import { DisplayText, useDisplayUiValue, useDisplayConfig } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Table } from "antd";
import type { UsageV2Parameter } from "@/services/api/usage-analytics-v2";
import { metricText } from "../format";

const labels: Record<string, string> = { size: "尺寸", resolution: "分辨率", quality: "画质", aspectRatio: "比例" };
export default function ParameterDistribution({ rows, title }: { rows: UsageV2Parameter[]; title: string }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const boards = [...new Map(rows.map((row) => [row.boardKey, row.boardLabel])).entries()];
    return (
        <section className="wb-surface min-w-0 p-4" data-testid="usage-parameters" aria-label={displayUi(title)}>
            <h3 className="mb-3 font-semibold">{displayUi(title)}</h3>
            <p className="mb-3 text-xs leading-5 text-[var(--muted-foreground)]">{staticUiText("各板块独立分母，不跨板块合并；占比仅在该参数有有效值的任务中计算。缺失或不适用另列，尺寸不会推算成比例。")}</p>
            <Table
                rowKey={(row) => JSON.stringify([row.boardKey, row.parameter, row.value])}
                dataSource={rows}
                size="small"
                scroll={{ x: 900 }}
                pagination={{ pageSize: 10, hideOnSinglePage: true }}
                locale={{ emptyText: staticUiText("当前范围没有任务参数记录") }}
                columns={displayConfig([
                    { title: staticUiText("板块"), dataIndex: "boardLabel", render: value => <DisplayText text={value} />, filters: boards.map(([value, text]) => ({ text: <DisplayText text={text} />, value })), onFilter: (value, row) => row.boardKey === value },
                    { title: staticUiText("参数"), dataIndex: "parameter", render: (value: string) => `${staticUiText(labels[value]) || value}（${value}）`, filters: [...new Set(rows.map((row) => row.parameter))].map((value) => ({ text: staticUiText(labels[value]) || value, value })), onFilter: (value, row) => row.parameter === value },
                    { title: staticUiText("记录的值"), dataIndex: "value", render: (value: string | null) => value ?? staticUiText("未记录 / 无有效值") },
                    { title: staticUiText("选项任务数"), dataIndex: "count", sorter: (a, b) => a.count - b.count },
                    { title: staticUiText("同板块任务"), dataIndex: "eligible" },
                    { title: staticUiText("有值任务"), render: (_, row) => row.rate.denominator ?? staticUiText("未提供") },
                    { title: staticUiText("缺失 / 不适用"), dataIndex: "missing" },
                    { title: staticUiText("占有值任务"), render: (_, row) => <span><DisplayText text={metricText(row.rate)} />{row.rate.state === "partial" ? staticUiText("（部分覆盖）") : ""}</span> },
                ], "columns", rows)}
            />
        </section>
    );
}
