import { App, Button, Input, Select, Space, Table, Tag, Tooltip } from "antd";
import { Download, Pause, Play, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { saveAs } from "file-saver";
import Papa from "papaparse";

import {
    availableBatchActions,
    availableTaskActions,
    controlAdminBatch,
    controlAdminTask,
    listAdminBatches,
    listAdminHistory,
    listAdminTasks,
    recordHistoryExport,
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
    const [loading, setLoading] = useState(true);
    const [userId, setUserId] = useState("all");
    const [operation, setOperation] = useState("all");
    const [search, setSearch] = useState("");
    const refresh = async () => {
        setLoading(true);
        try {
            setHistory((await listAdminHistory()).history);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "历史加载失败");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void refresh();
    }, []);
    const rows = useMemo(
        () =>
            history.filter(
                (row) => (userId === "all" || row.userId === userId) && (operation === "all" || row.operationType === operation) && (!search || `${row.projectId} ${row.prompt} ${row.modelName || ""}`.toLowerCase().includes(search.toLowerCase())),
            ),
        [history, operation, search, userId],
    );
    const exportCsv = async () => {
        const csv = Papa.unparse(
            rows.map((row) => ({
                时间: row.createdAt,
                设计师: row.userName,
                部门: row.departmentName || "",
                项目: row.projectId,
                操作: row.operationType,
                模型: row.modelName || "",
                提示词: row.prompt,
                积分: row.credits,
                人民币成本: row.rmbCost,
                状态: row.status,
                失败原因: row.failureReason || "",
                原图: row.sourceUrls.join(" "),
                结果图: row.resultUrls.join(" "),
            })),
        );
        await recordHistoryExport({ userId, operation, search }, rows.length);
        saveAs(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `无线画布历史-${Date.now()}.csv`);
    };
    const users = Array.from(new Map(history.map((row) => [row.userId, row.userName])).entries()).map(([value, label]) => ({ value, label }));
    const operations = Array.from(new Set(history.map((row) => row.operationType))).map((value) => ({ value, label: value }));
    return (
        <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Select className="w-44" value={userId} onChange={setUserId} options={[{ value: "all", label: "全部设计师" }, ...users]} />
                <Select className="w-44" value={operation} onChange={setOperation} options={[{ value: "all", label: "全部操作" }, ...operations]} />
                <Input className="max-w-sm" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目、模型或提示词" />
                <Button className="ml-auto" icon={<Download className="size-4" />} onClick={exportCsv}>
                    导出当前结果
                </Button>
            </div>
            <Table
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={rows}
                columns={[
                    { title: "时间", dataIndex: "createdAt" },
                    { title: "设计师", dataIndex: "userName" },
                    { title: "部门", dataIndex: "departmentName" },
                    { title: "项目", dataIndex: "projectId" },
                    { title: "操作", dataIndex: "operationType" },
                    { title: "模型", dataIndex: "modelName" },
                    { title: "积分", dataIndex: "credits" },
                    { title: "成本", render: (_, row: ServerHistory) => `￥${row.rmbCost.toFixed(4)}` },
                    { title: "状态", render: (_, row: ServerHistory) => <Tag color={row.status === "success" ? "green" : "red"}>{row.status}</Tag> },
                    { title: "提示词", dataIndex: "prompt", ellipsis: true },
                    { title: "失败原因", dataIndex: "failureReason", ellipsis: true },
                ]}
            />
        </div>
    );
}
