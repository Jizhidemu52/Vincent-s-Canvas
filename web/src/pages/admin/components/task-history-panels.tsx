import { App, Button, DatePicker, Input, Select, Space, Table, Tag, Tooltip } from "antd";
import { Download, Pause, Play, RefreshCw, Search, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { saveAs } from "file-saver";

import {
    availableBatchActions,
    availableTaskActions,
    controlAdminBatch,
    controlAdminTask,
    exportAdminHistory,
    listAdminBatches,
    listAdminHistory,
    listAdminHistoryOptions,
    listAdminTasks,
    type AdminHistoryFilters,
    type ServerBatch,
    type ServerHistory,
    type ServerTask,
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

export function TaskManagementPanel() {
    const { message } = App.useApp();
    const [tasks, setTasks] = useState<ServerTask[]>([]);
    const [batches, setBatches] = useState<ServerBatch[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState("");

    const refresh = async () => {
        setLoading(true);
        try {
            const [taskResult, batchResult] = await Promise.all([listAdminTasks(), listAdminBatches()]);
            setTasks(taskResult.tasks);
            setBatches(batchResult.batches);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务加载失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), 10_000);
        return () => window.clearInterval(timer);
    }, []);

    const runBatchAction = async (batch: ServerBatch, action: TaskControlAction) => {
        const key = `batch:${batch.id}:${action}`;
        setActing(key);
        try {
            const result = await controlAdminBatch(batch.id, action);
            message.success(`${actionLabel(action)}成功，影响 ${result.changed} 张图片`);
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量任务操作失败");
        } finally {
            setActing("");
        }
    };

    const runTaskAction = async (task: ServerTask, action: TaskControlAction) => {
        const key = `task:${task.id}:${action}`;
        setActing(key);
        try {
            await controlAdminTask(task.id, action);
            message.success(`${actionLabel(action)}成功`);
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务操作失败");
        } finally {
            setActing("");
        }
    };

    return (
        <div className="grid gap-5">
            <div className="flex justify-end">
                <Button icon={<RefreshCw className="size-4" />} onClick={refresh}>
                    刷新
                </Button>
            </div>
            <Table
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={batches}
                scroll={{ x: 1500 }}
                title={() => "批量任务整体进度"}
                columns={[
                    { title: "设计师", dataIndex: "userName", fixed: "left", width: 120 },
                    { title: "项目", dataIndex: "projectId", width: 150, ellipsis: true },
                    { title: "操作", dataIndex: "operationType", width: 130 },
                    { title: "模型", dataIndex: "modelName", width: 140 },
                    {
                        title: "进度",
                        width: 100,
                        render: (_, row: ServerBatch) => `${row.completedItems + row.failedItems + row.cancelledItems}/${row.totalItems}`,
                    },
                    { title: "等待", dataIndex: "waitingItems", width: 70 },
                    { title: "处理中", dataIndex: "processingItems", width: 75 },
                    { title: "成功", dataIndex: "completedItems", width: 70 },
                    { title: "失败", dataIndex: "failedItems", width: 70 },
                    { title: "暂停", dataIndex: "pausedItems", width: 70 },
                    { title: "取消", dataIndex: "cancelledItems", width: 70 },
                    {
                        title: "积分",
                        width: 105,
                        render: (_, row: ServerBatch) => `${row.consumedCredits}/${row.plannedCredits}`,
                    },
                    {
                        title: "成本",
                        width: 100,
                        render: (_, row: ServerBatch) => `￥${row.consumedRmbCost.toFixed(4)}`,
                    },
                    {
                        title: "状态",
                        width: 95,
                        render: (_, row: ServerBatch) => <Tag color={statusColor[row.status]}>{statusText[row.status] || row.status}</Tag>,
                    },
                    {
                        title: "控制",
                        fixed: "right",
                        width: 130,
                        render: (_, row: ServerBatch) => <TaskControls actions={availableBatchActions(row)} loadingKey={acting} keyPrefix={`batch:${row.id}`} onAction={(action) => void runBatchAction(row, action)} />,
                    },
                ]}
            />
            <Table
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={tasks}
                scroll={{ x: 1250 }}
                title={() => "逐图任务状态"}
                columns={[
                    { title: "设计师", dataIndex: "userName", fixed: "left", width: 120 },
                    { title: "项目", dataIndex: "projectId", width: 150, ellipsis: true },
                    { title: "操作", dataIndex: "operationType", width: 130 },
                    { title: "优先级", dataIndex: "priority", width: 80 },
                    {
                        title: "状态",
                        width: 95,
                        render: (_, row: ServerTask) => <Tag color={statusColor[row.status]}>{statusText[row.status] || row.status}</Tag>,
                    },
                    { title: "积分", dataIndex: "credits", width: 70 },
                    { title: "重试", dataIndex: "attempts", width: 65 },
                    { title: "失败原因", dataIndex: "failureReason", ellipsis: true, width: 180 },
                    { title: "排队时间", dataIndex: "queuedAt", width: 180 },
                    {
                        title: "控制",
                        fixed: "right",
                        width: 130,
                        render: (_, row: ServerTask) => <TaskControls actions={availableTaskActions(row.status)} loadingKey={acting} keyPrefix={`task:${row.id}`} onAction={(action) => void runTaskAction(row, action)} />,
                    },
                ]}
            />
        </div>
    );
}

function TaskControls({ actions, loadingKey, keyPrefix, onAction }: { actions: TaskControlAction[]; loadingKey: string; keyPrefix: string; onAction: (action: TaskControlAction) => void }) {
    if (!actions.length) return <span className="text-xs text-stone-400">不可操作</span>;
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
    const { message } = App.useApp();
    const [history, setHistory] = useState<ServerHistory[]>([]);
    const [designers, setDesigners] = useState<Array<{ value: string; label: string }>>([]);
    const [models, setModels] = useState<Array<{ value: string; label: string }>>([]);
    const [operations, setOperations] = useState<Array<{ value: string; label: string }>>([]);
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [filters, setFilters] = useState<AdminHistoryFilters>({});
    const [projectDraft, setProjectDraft] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const [total, setTotal] = useState(0);
    const requestSequence = useRef(0);

    const refresh = async (nextFilters = filters, nextPage = page, nextPageSize = pageSize) => {
        const sequence = ++requestSequence.current;
        setLoading(true);
        try {
            const result = await listAdminHistory({ ...nextFilters, page: nextPage, pageSize: nextPageSize });
            if (sequence !== requestSequence.current) return;
            setHistory(result.history);
            setTotal(result.total);
            setPage(result.page);
            setPageSize(result.pageSize);
        } catch (error) {
            if (sequence !== requestSequence.current) return;
            message.error(error instanceof Error ? error.message : "历史加载失败");
        } finally {
            if (sequence === requestSequence.current) setLoading(false);
        }
    };
    useEffect(() => {
        void refresh(filters, page, pageSize);
    }, [filters, page, pageSize]);

    useEffect(() => {
        listAdminHistoryOptions()
            .then((result) => {
                setDesigners(result.users);
                setModels(result.models);
                setOperations(result.operations);
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "筛选选项加载失败"));
    }, []);

    const updateFilters = (patch: Partial<AdminHistoryFilters>) => {
        setPage(1);
        setFilters((current) => {
            const next = { ...current, ...patch };
            return Object.fromEntries(Object.entries(next).filter(([, value]) => value)) as AdminHistoryFilters;
        });
    };

    const applyProjectFilter = () => updateFilters({ projectId: projectDraft.trim() || undefined });
    const exportCsv = async () => {
        setExporting(true);
        try {
            saveAs(await exportAdminHistory(filters), `无线画布历史-${Date.now()}.csv`);
            message.success("当前筛选结果已导出并写入审计日志");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "历史导出失败");
        } finally {
            setExporting(false);
        }
    };
    return (
        <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-3">
            <div className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-2">
                <Select className="w-44" allowClear placeholder="全部设计师" value={filters.userId} onChange={(value) => updateFilters({ userId: value })} options={designers} />
                <Select className="w-44" allowClear placeholder="全部模型" value={filters.modelId} onChange={(value) => updateFilters({ modelId: value })} options={models} />
                <Select className="w-44" allowClear placeholder="全部操作" value={filters.operationType} onChange={(value) => updateFilters({ operationType: value })} options={operations} />
                <Space.Compact className="w-64">
                    <Input
                        allowClear
                        value={projectDraft}
                        onChange={(event) => {
                            setProjectDraft(event.target.value);
                            if (!event.target.value) updateFilters({ projectId: undefined });
                        }}
                        onPressEnter={applyProjectFilter}
                        placeholder="项目 ID"
                    />
                    <Button aria-label="查询项目" icon={<Search className="size-4" />} onClick={applyProjectFilter} />
                </Space.Compact>
                <DatePicker.RangePicker
                    onChange={(dates) =>
                        updateFilters({
                            from: dates?.[0]?.startOf("day").toISOString(),
                            to: dates?.[1]?.endOf("day").toISOString(),
                        })
                    }
                />
                <Button className="ml-auto" icon={<Download className="size-4" />} loading={exporting} disabled={!total} onClick={exportCsv}>
                    导出当前结果
                </Button>
            </div>
            <div className="min-w-0 max-w-full overflow-hidden">
                <Table
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={history}
                    scroll={{ x: 1500 }}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [20, 50, 100, 200],
                        showTotal: (value) => `共 ${value} 条`,
                        onChange: (nextPage, nextPageSize) => {
                            setPage(nextPageSize === pageSize ? nextPage : 1);
                            setPageSize(nextPageSize);
                        },
                    }}
                    columns={[
                        { title: "时间", dataIndex: "createdAt", width: 180 },
                        { title: "设计师", dataIndex: "userName", width: 120, fixed: "left" },
                        { title: "部门", dataIndex: "departmentName", width: 120 },
                        { title: "项目", dataIndex: "projectId", width: 160, ellipsis: true },
                        { title: "操作", dataIndex: "operationType", width: 130 },
                        { title: "模型", dataIndex: "modelName", width: 140 },
                        { title: "积分", dataIndex: "credits", width: 70 },
                        { title: "成本", width: 100, render: (_, row: ServerHistory) => `￥${row.rmbCost.toFixed(4)}` },
                        { title: "状态", width: 90, render: (_, row: ServerHistory) => <Tag color={row.status === "success" ? "green" : "red"}>{statusText[row.status] || row.status}</Tag> },
                        { title: "提示词", dataIndex: "prompt", width: 220, ellipsis: true },
                        { title: "失败原因", dataIndex: "failureReason", width: 180, ellipsis: true },
                    ]}
                />
            </div>
        </div>
    );
}
