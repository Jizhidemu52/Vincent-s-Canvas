import { Button, Table, Tag, Alert } from "antd";
import { useEffect, useRef, useState } from "react";
import { type UsageV2People, type UsageV2PeopleSort, type UsageV2Person, type UsageV2Query } from "@/services/api/usage-analytics-v2";
import { getPeopleTeamComparison, type UsagePeopleComparison } from "@/services/api/usage-people-comparison";
import { MetricCards } from "./components";
import { metricText, metricCoverageText } from "./format";
import PeopleComparison from "./people-comparison";
export default function People({
    data,
    sort,
    order,
    onSort,
    onPage,
    onProfile,
    selectedIds,
    onSelectionChange,
    query,
    refreshVersion,
    disabled,
}: {
    data: UsageV2People;
    sort: UsageV2PeopleSort;
    order: "asc" | "desc";
    onSort: (sort: UsageV2PeopleSort, order: "asc" | "desc") => void;
    onPage: (page: number) => void;
    onProfile: (id: string) => void;
    selectedIds: string[];
    onSelectionChange: (ids: string[]) => void;
    query: UsageV2Query;
    refreshVersion: number;
    disabled: boolean;
}) {
    const [comparison, setComparison] = useState<{ key: string; data: UsagePeopleComparison } | null>(null);
    const [comparing, setComparing] = useState(false),
        [comparisonError, setComparisonError] = useState("");
    const comparisonController = useRef<AbortController | null>(null);
    const comparisonKey = JSON.stringify({ query, selectedIds, refreshVersion, disabled });
    const compared = comparison?.key === comparisonKey && !disabled ? comparison.data : null;
    useEffect(() => {
        comparisonController.current?.abort();
        setComparing(false);
        setComparison(null);
        setComparisonError("");
        return () => comparisonController.current?.abort();
    }, [comparisonKey]);
    const compare = async () => {
        if (disabled || comparing || selectedIds.length < 2 || selectedIds.length > 5) return;
        const abort = new AbortController();
        comparisonController.current?.abort();
        comparisonController.current = abort;
        setComparing(true);
        setComparison(null);
        setComparisonError("");
        try {
            const response = await getPeopleTeamComparison(query, selectedIds, abort.signal);
            if (!abort.signal.aborted) setComparison({ key: comparisonKey, data: response });
        } catch (failure) {
            if (!abort.signal.aborted) setComparisonError(failure instanceof Error ? failure.message : "人员对比读取失败，请手动重试。");
        } finally {
            if (!abort.signal.aborted) setComparing(false);
        }
    };
    const sorting = (key: UsageV2PeopleSort) => ({ key, sorter: true, sortOrder: sort === key ? (order === "asc" ? ("ascend" as const) : ("descend" as const)) : null });
    return (
        <div className="space-y-4">
            <Alert type="info" showIcon title="用记录了解使用方式，不评价个人能力或绩效" description="按服务端全量排序与分页；无记录和未采集指标不会被当作负面表现。可跨页选择 2–5 人，再一次性读取同口径指标；不拼接各页旧数据。" />
            <MetricCards metrics={data.metrics} keys={["activePeople", "generatedImages", "generationBookedCny", "resultUseRate"]} />
            <section className="wb-surface min-w-0 p-4 sm:p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">人员明细 · 共 {data.pagination.total} 人</h3>
                    <Tag>点击姓名查看个人画像</Tag>
                </div>
                <Table<UsageV2Person>
                    size="small"
                    rowKey="userId"
                    dataSource={data.people}
                    scroll={{ x: 1540 }}
                    rowSelection={{
                        selectedRowKeys: selectedIds,
                        preserveSelectedRowKeys: true,
                        hideSelectAll: true,
                        onChange: (keys) => onSelectionChange(keys.map(String).slice(0, 5)),
                        getCheckboxProps: (row) => ({ "aria-label": `对比选择 ${row.displayName}`, disabled: disabled || (selectedIds.length >= 5 && !selectedIds.includes(row.userId)) }),
                    }}
                    pagination={{
                        current: data.pagination.page,
                        pageSize: data.pagination.pageSize,
                        total: data.pagination.total,
                        showSizeChanger: false,
                        onChange: onPage,
                    }}
                    onChange={(_, __, sorter, extra) => {
                        if (extra.action !== "sort") return;
                        const active = Array.isArray(sorter) ? sorter[0] : sorter;
                        onSort((active.columnKey || "lastActivity") as UsageV2PeopleSort, active.order === "ascend" ? "asc" : "desc");
                    }}
                    columns={[
                        {
                            title: "姓名",
                            dataIndex: "displayName",
                            width: 130,
                            render: (name, row) => (
                                <Button type="link" className="!p-0" onClick={() => onProfile(row.userId)}>
                                    {name}
                                </Button>
                            ),
                        },
                        { title: "当前部门", dataIndex: "departmentName", render: (value) => value || "未分配" },
                        { title: "活跃天数", ...sorting("activeDays"), render: (_, row) => metricText(row.metrics.activeDays) },
                        { title: "可见活跃时长", render: (_, row) => metricText(row.metrics.activeSeconds) },
                        { title: "成功出图", ...sorting("generatedImages"), render: (_, row) => metricText(row.metrics.generatedImages) },
                        { title: "已记账金额", ...sorting("generationBookedCny"), render: (_, row) => metricText(row.metrics.generationBookedCny) },
                        { title: "成功率", ...sorting("successRate"), render: (_, row) => metricText(row.metrics.successRate) },
                        { title: "结果使用率", ...sorting("resultUseRate"), render: (_, row) => metricText(row.metrics.resultUseRate) },
                        { title: "正式采纳率", render: (_, row) => metricText(row.metrics.formalAdoptionRate) },
                        { title: "单张已使用图成本", render: (_, row) => metricCoverageText(row.metrics.costPerUsedImage) },
                        { title: "可验证编辑链长度", render: (_, row) => metricText(row.metrics.revisionRounds) },
                        {
                            title: "常用板块",
                            width: 180,
                            render: (_, row) =>
                                row.topBoards
                                    .slice(0, 3)
                                    .map((item) => item.label)
                                    .join(" / ") || "无记录",
                        },
                        {
                            title: "常用模型",
                            width: 180,
                            render: (_, row) =>
                                row.topModels
                                    .slice(0, 3)
                                    .map((item) => item.label)
                                    .join(" / ") || "无记录",
                        },
                        { title: "最近记录", ...sorting("lastActivity"), width: 180, render: (_, row) => (row.lastActivityAt ? new Date(row.lastActivityAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "无记录") },
                    ]}
                />
                <p className="mt-3 text-xs text-[var(--muted-foreground)]">时长不是工时；“不可用”表示缺少采集或可靠关联。当前部门用于人员识别，统计归属使用顶部所选口径。</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span>跨页已选 {selectedIds.length} / 5 人</span>
                    <Button disabled={disabled || selectedIds.length < 2} loading={comparing} onClick={() => void compare()}>
                        读取所选人员对比
                    </Button>
                    <Button disabled={disabled || !selectedIds.length} onClick={() => onSelectionChange([])}>
                        清空对比选择
                    </Button>
                </div>
                {comparisonError ? <Alert className="mt-3" type="warning" title={comparisonError} /> : null}
            </section>
            {compared ? (
                <PeopleComparison key={comparisonKey} data={compared} onProfile={onProfile} />
            ) : null}
        </div>
    );
}
