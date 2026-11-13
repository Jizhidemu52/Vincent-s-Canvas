import { displayNotice, useDisplayUiValue, useDisplayConfig  } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, App, Button, DatePicker, Drawer, Input, Select, Space, Table, Tag, Tooltip } from "antd";
import { Download, Pause, Play, RefreshCw, Search, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { saveAs } from "file-saver";
import dayjs from "dayjs";
import { formatBeijingDateTime, formatBeijingTime } from "@/lib/beijing-time";
import { nonFinancialHistoryCsv } from "@/lib/non-financial-history-csv";
import { useWorkbenchField } from "@/hooks/use-workbench-field";
import { useUserStore } from "@/stores/use-user-store";
import { InfiniteLoadMore } from "@/components/infinite-load-more";
import { TaskReconciliationPanel } from "./task-reconciliation-panel";
import { AdminDetails, adminLabel } from "../admin-labels";
import { RecordMedia } from "../assets/components/asset-media";

import {
    availableBatchActions,
    availableTaskActions,
    controlAdminBatch,
    controlAdminTask,
    exportAdminHistory,
    getAdminHistory,
    getAdminTask,
    listAdminBatches,
    listAdminHistory,
    listAdminHistoryOptions,
    listAdminTasks,
    type AdminHistoryFilters,
    type ServerBatch,
    type ServerHistorySummary,
    type ServerTaskSummary,
    type TaskControlAction,
} from "@/services/api/task-history";

const statusColor: Record<string, string> = {
    waiting: "default",
    processing: "blue",
    success: "green",
    partial: "orange",
    failed: "red",
    cancelled: "default",
    paused: "gold",
};
const statusText: Record<string, string> = {
    waiting: "等待中",
    processing: "处理中",
    success: "成功",
    partial: "部分完成",
    failed: "失败",
    cancelled: "已取消",
    paused: "已暂停",
};

export function TaskManagementPanel({ active = true }: { active?: boolean }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const { message, modal } = App.useApp();
    const userId = useUserStore(state => state.user?.id);
    const isSuperAdmin = useUserStore(state => state.user?.role === "super_admin");
    const [detailId, setDetailId] = useState<string | null>(null);
    const [acting, setActing] = useState("");
    const actingRef = useRef("");
    const tasksQuery = useInfiniteQuery({
        queryKey: ["admin-tasks", userId], initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) => listAdminTasks({ cursor: pageParam, limit: 60 }),
        getNextPageParam: page => page.nextCursor ?? undefined,
        enabled: active, retry: false, refetchOnWindowFocus: false,
        refetchInterval: query => document.hidden || query?.state.status === "error" ? false : 10_000,
    });
    const batchesQuery = useInfiniteQuery({
        queryKey: ["admin-batches", userId], initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) => listAdminBatches({ cursor: pageParam, limit: 60 }),
        getNextPageParam: page => page.nextCursor ?? undefined,
        enabled: active, retry: false, refetchOnWindowFocus: false,
        refetchInterval: query => document.hidden || query?.state.status === "error" ? false : 10_000,
    });
    const tasks = tasksQuery.data?.pages.flatMap(page => page.tasks) ?? [];
    const batches = batchesQuery.data?.pages.flatMap(page => page.batches) ?? [];
    const loading = tasksQuery.isPending || batchesQuery.isPending;
    const error = tasksQuery.error?.message || batchesQuery.error?.message || "";
    const lastUpdate = Math.max(tasksQuery.dataUpdatedAt, batchesQuery.dataUpdatedAt);
    const updatedAt = lastUpdate ? formatBeijingTime(lastUpdate) : "";
    const refresh = () => Promise.all([tasksQuery.refetch(), batchesQuery.refetch()]);

    const runBatchAction = async (batch: ServerBatch, action: TaskControlAction) => {
        if (action === "cancel" && !await modal.confirm({ title: staticUiText("确认取消该批次？"), content: staticUiText("{p0}的批次 {p1}，共 {p2} 项。将取消服务端允许取消的任务；已完成结果保留，已交由上游处理的请求不保证停止或退款。", { p0: `${batch.userName}`, p1: `${batch.id}`, p2: `${batch.totalItems}` }), okText: staticUiText("确认取消批次"), cancelText: staticUiText("保留任务"), okButtonProps: { danger: true } })) return;
        const key = `batch:${batch.id}:${action}`;
        if (actingRef.current) return;
        actingRef.current = key;
        setActing(key);
        try {
            const result = await controlAdminBatch(batch.id, action);
            message.success(displayNotice(staticUiText("{p0}成功，影响 {p1} 张图片", { p0: `${actionLabel(action)}`, p1: `${result.changed}` })));
            await refresh();
        } catch (error) {
            message.error(displayNotice(error instanceof Error ? error.message : staticUiText("批量任务操作失败")));
        } finally {
            actingRef.current = "";
            setActing("");
        }
    };

    const runTaskAction = async (task: ServerTaskSummary, action: TaskControlAction) => {
        if (action === "cancel" && !await modal.confirm({ title: staticUiText("确认取消该任务？"), content: staticUiText("{p0}的任务 {p1}。取消后不能恢复本任务；已交由上游处理的请求不保证停止或退款，请以更新后的任务状态为准。", { p0: `${task.userName}`, p1: `${task.id}` }), okText: staticUiText("确认取消任务"), cancelText: staticUiText("保留任务"), okButtonProps: { danger: true } })) return;
        const key = `task:${task.id}:${action}`;
        if (actingRef.current) return;
        actingRef.current = key;
        setActing(key);
        try {
            await controlAdminTask(task.id, action);
            message.success(displayNotice(staticUiText("{p0}成功", { p0: `${actionLabel(action)}` })));
            await refresh();
        } catch (error) {
            message.error(displayNotice(error instanceof Error ? error.message : staticUiText("任务操作失败")));
        } finally {
            actingRef.current = "";
            setActing("");
        }
    };

    return (
        <div className="grid min-w-0 gap-5">
            {isSuperAdmin ? <TaskReconciliationPanel active={active} onResolved={refresh} /> : null}
            <div className="wb-toolbar justify-between">
                <p className="text-sm text-[var(--muted-foreground)]" role="status">{updatedAt ? staticUiText("更新于 {p0}（北京时间）· 当前页每 10 秒自动同步", { p0: `${updatedAt}` }) : staticUiText("正在读取任务状态…")}</p>
                <Button className="!h-10" loading={loading} icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>{staticUiText("刷新")}</Button>
            </div>
            {error ? <Alert type="warning" showIcon title={staticUiText("任务状态暂未更新")} description={displayUi(error)} action={<Button onClick={() => void refresh()} loading={loading}>{staticUiText("重试")}</Button>} /> : null}
            <Table
                className="wb-surface min-w-0 overflow-hidden"
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={batches}
                pagination={false}
                footer={() => <><p>{staticUiText("已载入 ")}{batches.length}{staticUiText(" 条")}</p><InfiniteLoadMore hasMore={Boolean(batchesQuery.hasNextPage)} loading={batchesQuery.isFetching} error={batchesQuery.error}
                    disabled={!active} resetKey={JSON.stringify(["batches", userId])} pageKey={batchesQuery.data?.pages.at(-1)?.nextCursor}
                    label={staticUiText("加载更多批次")} endLabel="没有更多批次" onLoadMore={() => batchesQuery.fetchNextPage({ cancelRefetch: false })} /></>}
                scroll={{ x: 1500 }}
                title={() => staticUiText("批量任务整体进度")}
                columns={displayConfig([
                    { title: staticUiText("设计师"), dataIndex: "userName", fixed: "left", width: 120 },
                    { title: staticUiText("项目"), dataIndex: "projectId", width: 150, ellipsis: true },
                    { title: staticUiText("操作"), dataIndex: "operationType", width: 130, render: adminLabel },
                    { title: staticUiText("模型"), dataIndex: "modelName", width: 140 },
                    {
                        title: staticUiText("进度"),
                        width: 100,
                        render: (_, row: ServerBatch) => `${row.completedItems + row.failedItems + row.cancelledItems}/${row.totalItems}`,
                    },
                    { title: staticUiText("等待"), dataIndex: "waitingItems", width: 70 },
                    { title: staticUiText("处理中"), dataIndex: "processingItems", width: 75 },
                    { title: staticUiText("成功"), dataIndex: "completedItems", width: 70 },
                    { title: staticUiText("失败"), dataIndex: "failedItems", width: 70 },
                    { title: staticUiText("暂停"), dataIndex: "pausedItems", width: 70 },
                    { title: staticUiText("取消"), dataIndex: "cancelledItems", width: 70 },
                    {
                        title: staticUiText("状态"),
                        width: 95,
                        render: (_, row: ServerBatch) => <Tag color={statusColor[row.status]}>{staticUiText(statusText[row.status]) || row.status}</Tag>,
                    },
                    {
                        title: staticUiText("控制"),
                        fixed: "right",
                        width: 130,
                        render: (_, row: ServerBatch) => <TaskControls actions={availableBatchActions(row)} loadingKey={acting} keyPrefix={`batch:${row.id}`} onAction={(action) => void runBatchAction(row, action)} />,
                    },
                ], "columns", batches)}
            />
            <Table
                className="wb-surface min-w-0 overflow-hidden"
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={tasks}
                pagination={false}
                footer={() => <><p>{staticUiText("已载入 ")}{tasks.length}{staticUiText(" 条")}</p><InfiniteLoadMore hasMore={Boolean(tasksQuery.hasNextPage)} loading={tasksQuery.isFetching} error={tasksQuery.error}
                    disabled={!active} resetKey={JSON.stringify(["tasks", userId])} pageKey={tasksQuery.data?.pages.at(-1)?.nextCursor}
                    label={staticUiText("加载更多任务")} endLabel="没有更多任务" onLoadMore={() => tasksQuery.fetchNextPage({ cancelRefetch: false })} /></>}
                scroll={{ x: 1250 }}
                title={() => staticUiText("逐图任务状态")}
                columns={displayConfig([
                    { title: staticUiText("设计师"), dataIndex: "userName", fixed: "left", width: 120 },
                    { title: staticUiText("项目"), dataIndex: "projectId", width: 150, ellipsis: true },
                    { title: staticUiText("操作"), dataIndex: "operationType", width: 130, render: adminLabel },
                    { title: staticUiText("优先级"), dataIndex: "priority", width: 80 },
                    {
                        title: staticUiText("状态"),
                        width: 95,
                        render: (_, row: ServerTaskSummary) => <Tag color={statusColor[row.status]}>{staticUiText(statusText[row.status]) || row.status}</Tag>,
                    },
                    { title: staticUiText("重试"), dataIndex: "attempts", width: 65 },
                    { title: staticUiText("失败原因"), dataIndex: "failureReason", ellipsis: true, width: 180 },
                    { title: staticUiText("排队时间（北京时间）"), dataIndex: "queuedAt", width: 200, render: (value: string) => formatBeijingDateTime(value) },
                    {
                        title: staticUiText("控制"),
                        fixed: "right",
                        width: 130,
                        render: (_, row: ServerTaskSummary) => <TaskControls actions={availableTaskActions(row.status)} loadingKey={acting} keyPrefix={`task:${row.id}`} onAction={(action) => void runTaskAction(row, action)} />,
                    },
                    { title: staticUiText("详情"), width: 70, render: (_, row: ServerTaskSummary) => <Button type="link" onClick={() => setDetailId(row.id)}>{staticUiText("查看")}</Button> },
                ], "columns", tasks)}
            />
            {detailId ? <RecordDetails kind="task" id={detailId} onClose={() => setDetailId(null)} /> : null}
        </div>
    );
}

function TaskControls({ actions, loadingKey, keyPrefix, onAction }: { actions: TaskControlAction[]; loadingKey: string; keyPrefix: string; onAction: (action: TaskControlAction) => void }) {
    useUiLocale();
    if (!actions.length) return <span className="text-xs text-stone-400">{staticUiText("不可操作")}</span>;
    return (
        <Space.Compact size="small">
            {actions.map((action) => (
                <Tooltip key={action} title={actionLabel(action)}>
                    <Button
                        aria-label={actionLabel(action)}
                        danger={action === "cancel"}
                        icon={action === "pause" ? <Pause className="size-4" /> : action === "resume" ? <Play className="size-4" /> : <XCircle className="size-4" />}
                        loading={loadingKey === `${keyPrefix}:${action}`}
                        disabled={Boolean(loadingKey) && loadingKey !== `${keyPrefix}:${action}`}
                        onClick={() => onAction(action)}
                    />
                </Tooltip>
            ))}
        </Space.Compact>
    );
}

function actionLabel(action: TaskControlAction) {
    return action === "pause" ? "暂停" : action === "resume" ? "恢复" : "取消";
}

export function HistoryManagementPanel() {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const { message } = App.useApp();
    const userId = useUserStore(state => state.user?.id);
    const [detailId, setDetailId] = useState<string | null>(null);
    const [designers, setDesigners] = useState<Array<{ value: string; label: string }>>([]);
    const [models, setModels] = useState<Array<{ value: string; label: string }>>([]);
    const [operations, setOperations] = useState<Array<{ value: string; label: string }>>([]);
    const [exporting, setExporting] = useState(false);
    const [filters, setFilters] = useWorkbenchField<AdminHistoryFilters>("history:filters", {});
    const [projectDraft, setProjectDraft] = useWorkbenchField("history:projectDraft", "");
    const historyQuery = useInfiniteQuery({
        queryKey: ["admin-history", userId, filters], initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) => listAdminHistory({ ...filters, cursor: pageParam, limit: 60 }),
        getNextPageParam: page => page.nextCursor ?? undefined,
        retry: false, refetchOnWindowFocus: false,
    });
    const history = historyQuery.data?.pages.flatMap(page => page.history) ?? [];
    const total = historyQuery.data?.pages[0]?.total ?? 0;
    const loading = historyQuery.isPending;

    useEffect(() => {
        let cancelled = false;
        listAdminHistoryOptions()
            .then((result) => {
                if (cancelled) return;
                setDesigners(result.users);
                setModels(result.models);
                setOperations(result.operations);
            })
            .catch((error) => { if (!cancelled) message.error(displayNotice(error instanceof Error ? error.message : staticUiText("筛选选项加载失败"))); });
        return () => { cancelled = true; };
    }, []);

    const updateFilters = (patch: Partial<AdminHistoryFilters>) => {
        setFilters((current) => {
            const next = { ...current, ...patch };
            return Object.fromEntries(Object.entries(next).filter(([, value]) => value)) as AdminHistoryFilters;
        });
    };

    const applyProjectFilter = () => updateFilters({ projectId: projectDraft.trim() || undefined });
    const exportCsv = async () => {
        setExporting(true);
        try {
            const original = await exportAdminHistory(filters);
            saveAs(new Blob([nonFinancialHistoryCsv(await original.text())], { type: "text/csv;charset=utf-8" }), `TruCreate历史-${Date.now()}.csv`);
            message.success(staticUiText("当前筛选结果已导出并写入审计日志"));
        } catch (error) {
            message.error(displayNotice(error instanceof Error ? error.message : staticUiText("历史导出失败")));
        } finally {
            setExporting(false);
        }
    };
    return (
        <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-3">
            <div className="wb-toolbar w-full min-w-0 max-w-full">
                <Select className="w-44" allowClear placeholder={staticUiText("全部设计师")} value={filters.userId} onChange={(value) => updateFilters({ userId: value })} options={displayConfig(designers, "options")} />
                <Select className="w-44" allowClear placeholder={staticUiText("全部模型")} value={filters.modelId} onChange={(value) => updateFilters({ modelId: value })} options={displayConfig(models, "options")} />
                <Select className="w-44" allowClear placeholder={staticUiText("全部操作")} value={filters.operationType} onChange={(value) => updateFilters({ operationType: value })} options={displayConfig(operations, "options")} />
                <Space.Compact className="w-64">
                    <Input
                        allowClear
                        value={projectDraft}
                        onChange={(event) => {
                            setProjectDraft(event.target.value);
                            if (!event.target.value) updateFilters({ projectId: undefined });
                        }}
                        onPressEnter={applyProjectFilter}
                        placeholder={staticUiText("项目 ID")}
                    />
                    <Button aria-label={staticUiText("查询项目")} icon={<Search className="size-4" />} onClick={applyProjectFilter} />
                </Space.Compact>
                <DatePicker.RangePicker
                    value={filters.from && filters.to ? [dayjs(filters.from), dayjs(filters.to)] : null}
                    onChange={(dates) =>
                        updateFilters({
                            from: dates?.[0]?.startOf("day").toISOString(),
                            to: dates?.[1]?.endOf("day").toISOString(),
                        })
                    }
                />
                <Button className="ml-auto !h-10" icon={<Download className="size-4" />} loading={exporting} disabled={!total} onClick={exportCsv}>{staticUiText("导出当前结果")}</Button>
            </div>
            <div className="wb-surface min-w-0 max-w-full overflow-hidden">
                {historyQuery.error ? <Alert type="warning" title={staticUiText("历史加载失败")} description={displayUi(historyQuery.error.message)} action={<Button onClick={() => void historyQuery.refetch()}>{staticUiText("重试")}</Button>} /> : null}
                <Table
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={history}
                    scroll={{ x: 1500 }}
                    pagination={false}
                    footer={() => <><p>{staticUiText("已载入 ")}{history.length} / {total}{staticUiText(" 条")}</p><InfiniteLoadMore hasMore={Boolean(historyQuery.hasNextPage)} loading={historyQuery.isFetching} error={historyQuery.error}
                        resetKey={JSON.stringify([userId, filters])} pageKey={historyQuery.data?.pages.at(-1)?.nextCursor}
                        label={staticUiText("加载更多历史")} endLabel="没有更多历史" onLoadMore={() => historyQuery.fetchNextPage({ cancelRefetch: false })} /></>}
                    columns={displayConfig([
                        { title: staticUiText("时间（北京时间）"), dataIndex: "createdAt", width: 200, render: (value: string) => formatBeijingDateTime(value) },
                        { title: staticUiText("设计师"), dataIndex: "userName", width: 120, fixed: "left" },
                        { title: staticUiText("部门"), dataIndex: "departmentName", width: 120 },
                        { title: staticUiText("项目"), dataIndex: "projectId", width: 160, ellipsis: true },
                        { title: staticUiText("操作"), dataIndex: "operationType", width: 130, render: adminLabel },
                        { title: staticUiText("模型"), dataIndex: "modelName", width: 140 },
                        { title: staticUiText("状态"), width: 90, render: (_, row: ServerHistorySummary) => <Tag color={row.status === "success" ? "green" : "red"}>{staticUiText(statusText[row.status]) || row.status}</Tag> },
                        { title: staticUiText("提示词"), dataIndex: "prompt", width: 220, ellipsis: true },
                        { title: staticUiText("失败原因"), dataIndex: "failureReason", width: 180, ellipsis: true },
                        { title: staticUiText("详情"), width: 70, render: (_, row: ServerHistorySummary) => <Button type="link" onClick={() => setDetailId(row.id)}>{staticUiText("查看")}</Button> },
                    ], "columns", history)}
                />
            </div>
            {detailId ? <RecordDetails kind="history" id={detailId} onClose={() => setDetailId(null)} /> : null}
        </div>
    );
}

function RecordDetails({ kind, id, onClose }: { kind: "task" | "history"; id: string; onClose: () => void }) {
    const displayUi = useDisplayUiValue();
    useUiLocale();
    const userId = useUserStore(state => state.user?.id);
    const query = useQuery({ queryKey: ["admin-record", userId, kind, id], queryFn: async () => kind === "task" ? (await getAdminTask(id)).task : (await getAdminHistory(id)).history, retry: false, refetchOnWindowFocus: false });
    return <Drawer open onClose={onClose} title={kind === "task" ? staticUiText("任务详情") : staticUiText("生成历史详情")} size="large">
        {query.isPending ? <p role="status">{staticUiText("正在读取完整详情…")}</p> : query.error ? <Alert type="error" title={staticUiText("详情加载失败")} description={displayUi(query.error.message)} action={<Button onClick={() => void query.refetch()}>{staticUiText("重试详情")}</Button>} /> : <>
            <p className="mb-3 break-all text-xs text-[var(--muted-foreground)]">{id}</p>
            <h3>{staticUiText("提示词")}</h3><p className="mb-4 whitespace-pre-wrap break-words">{displayUi(query.data?.prompt || staticUiText("（无）"))}</p>
            <h3 className="mb-2">{staticUiText("参数")}</h3><div className="mb-4"><AdminDetails value={query.data?.parameters ?? {}} /></div>
            <h3 className="mb-2">{staticUiText("原图")}</h3><RecordMedia urls={query.data?.sourceUrls ?? []} label={staticUiText("原图")} />
            <h3 className="mb-2 mt-4">{staticUiText("结果")}</h3><RecordMedia urls={query.data?.resultUrls ?? []} label={staticUiText("结果")} />
        </>}
    </Drawer>;
}
