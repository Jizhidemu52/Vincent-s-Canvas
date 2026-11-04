import { Table } from "antd";
import type { UsageV2Parameter } from "@/services/api/usage-analytics-v2";
import { metricText } from "../format";

const labels: Record<string, string> = { size: "尺寸", resolution: "分辨率", quality: "画质", aspectRatio: "比例" };
export default function ParameterDistribution({ rows, title }: { rows: UsageV2Parameter[]; title: string }) {
    const boards = [...new Map(rows.map((row) => [row.boardKey, row.boardLabel])).entries()];
    return (
        <section className="wb-surface min-w-0 p-4" data-testid="usage-parameters" aria-label={title}>
            <h3 className="mb-3 font-semibold">{title}</h3>
            <p className="mb-3 text-xs leading-5 text-[var(--muted-foreground)]">各板块独立分母，不跨板块合并；占比仅在该参数有有效值的任务中计算。缺失或不适用另列，尺寸不会推算成比例。</p>
            <Table
                rowKey={(row) => JSON.stringify([row.boardKey, row.parameter, row.value])}
                dataSource={rows}
                size="small"
                scroll={{ x: 900 }}
                pagination={{ pageSize: 10, hideOnSinglePage: true }}
                locale={{ emptyText: "当前范围没有任务参数记录" }}
                columns={[
                    { title: "板块", dataIndex: "boardLabel", filters: boards.map(([value, text]) => ({ text, value })), onFilter: (value, row) => row.boardKey === value },
                    { title: "参数", dataIndex: "parameter", render: (value: string) => `${labels[value] || value}（${value}）`, filters: [...new Set(rows.map((row) => row.parameter))].map((value) => ({ text: labels[value] || value, value })), onFilter: (value, row) => row.parameter === value },
                    { title: "记录的值", dataIndex: "value", render: (value: string | null) => value ?? "未记录 / 无有效值" },
                    { title: "选项任务数", dataIndex: "count", sorter: (a, b) => a.count - b.count },
                    { title: "同板块任务", dataIndex: "eligible" },
                    { title: "有值任务", render: (_, row) => row.rate.denominator ?? "未提供" },
                    { title: "缺失 / 不适用", dataIndex: "missing" },
                    { title: "占有值任务", render: (_, row) => <span>{metricText(row.rate)}{row.rate.state === "partial" ? "（部分覆盖）" : ""}</span> },
                ]}
            />
        </section>
    );
}
