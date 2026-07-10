import { App, Button, Input, Select, Space, Table, Tag } from "antd";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { saveAs } from "file-saver";
import Papa from "papaparse";

import { listAdminBatches, listAdminHistory, listAdminTasks, recordHistoryExport, type ServerBatch, type ServerHistory, type ServerTask } from "@/services/api/task-history";

const statusColor: Record<string, string> = { waiting: "default", processing: "blue", success: "green", partial: "orange", failed: "red", cancelled: "default", paused: "gold" };

export function TaskManagementPanel() {
    const { message } = App.useApp(); const [tasks, setTasks] = useState<ServerTask[]>([]); const [batches, setBatches] = useState<ServerBatch[]>([]); const [loading, setLoading] = useState(true);
    const refresh = async () => { setLoading(true); try { const [taskResult, batchResult] = await Promise.all([listAdminTasks(), listAdminBatches()]); setTasks(taskResult.tasks); setBatches(batchResult.batches); } catch (error) { message.error(error instanceof Error ? error.message : "任务加载失败"); } finally { setLoading(false); } };
    useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 10_000); return () => window.clearInterval(timer); }, []);
    return <div className="grid gap-5"><div className="flex justify-end"><Button icon={<RefreshCw className="size-4" />} onClick={refresh}>刷新</Button></div>
        <Table rowKey="id" size="small" loading={loading} dataSource={batches} title={() => "批量任务整体进度"} columns={[
            { title: "设计师", dataIndex: "userName" }, { title: "项目", dataIndex: "projectId" }, { title: "操作", dataIndex: "operationType" }, { title: "模型", dataIndex: "modelName" },
            { title: "进度", render: (_, row: ServerBatch) => `${row.completedItems + row.failedItems}/${row.totalItems}` }, { title: "成功", dataIndex: "completedItems" }, { title: "失败", dataIndex: "failedItems" },
            { title: "状态", render: (_, row: ServerBatch) => <Tag color={statusColor[row.status]}>{row.status}</Tag> }, { title: "时间", dataIndex: "createdAt" },
        ]} />
        <Table rowKey="id" size="small" loading={loading} dataSource={tasks} title={() => "逐图任务状态"} columns={[
            { title: "设计师", dataIndex: "userName" }, { title: "项目", dataIndex: "projectId" }, { title: "操作", dataIndex: "operationType" }, { title: "优先级", dataIndex: "priority" },
            { title: "状态", render: (_, row: ServerTask) => <Tag color={statusColor[row.status]}>{row.status}</Tag> }, { title: "积分", dataIndex: "credits" }, { title: "重试", dataIndex: "attempts" },
            { title: "失败原因", dataIndex: "failureReason", ellipsis: true }, { title: "排队时间", dataIndex: "queuedAt" },
        ]} />
    </div>;
}

export function HistoryManagementPanel() {
    const { message } = App.useApp(); const [history, setHistory] = useState<ServerHistory[]>([]); const [loading, setLoading] = useState(true); const [userId, setUserId] = useState("all"); const [operation, setOperation] = useState("all"); const [search, setSearch] = useState("");
    const refresh = async () => { setLoading(true); try { setHistory((await listAdminHistory()).history); } catch (error) { message.error(error instanceof Error ? error.message : "历史加载失败"); } finally { setLoading(false); } };
    useEffect(() => { void refresh(); }, []);
    const rows = useMemo(() => history.filter((row) => (userId === "all" || row.userId === userId) && (operation === "all" || row.operationType === operation) && (!search || `${row.projectId} ${row.prompt} ${row.modelName || ""}`.toLowerCase().includes(search.toLowerCase()))), [history, operation, search, userId]);
    const exportCsv = async () => { const csv = Papa.unparse(rows.map((row) => ({ 时间: row.createdAt, 设计师: row.userName, 部门: row.departmentName || "", 项目: row.projectId, 操作: row.operationType, 模型: row.modelName || "", 提示词: row.prompt, 积分: row.credits, 人民币成本: row.rmbCost, 状态: row.status, 失败原因: row.failureReason || "", 原图: row.sourceUrls.join(" "), 结果图: row.resultUrls.join(" ") }))); await recordHistoryExport({ userId, operation, search }, rows.length); saveAs(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `无线画布历史-${Date.now()}.csv`); };
    const users = Array.from(new Map(history.map((row) => [row.userId, row.userName])).entries()).map(([value, label]) => ({ value, label })); const operations = Array.from(new Set(history.map((row) => row.operationType))).map((value) => ({ value, label: value }));
    return <div className="grid gap-3"><div className="flex flex-wrap items-center gap-2"><Select className="w-44" value={userId} onChange={setUserId} options={[{ value: "all", label: "全部设计师" }, ...users]} /><Select className="w-44" value={operation} onChange={setOperation} options={[{ value: "all", label: "全部操作" }, ...operations]} /><Input className="max-w-sm" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目、模型或提示词" /><Button className="ml-auto" icon={<Download className="size-4" />} onClick={exportCsv}>导出当前结果</Button></div>
        <Table rowKey="id" size="small" loading={loading} dataSource={rows} columns={[
            { title: "时间", dataIndex: "createdAt" }, { title: "设计师", dataIndex: "userName" }, { title: "部门", dataIndex: "departmentName" }, { title: "项目", dataIndex: "projectId" }, { title: "操作", dataIndex: "operationType" }, { title: "模型", dataIndex: "modelName" },
            { title: "积分", dataIndex: "credits" }, { title: "成本", render: (_, row: ServerHistory) => `￥${row.rmbCost.toFixed(4)}` }, { title: "状态", render: (_, row: ServerHistory) => <Tag color={row.status === "success" ? "green" : "red"}>{row.status}</Tag> }, { title: "提示词", dataIndex: "prompt", ellipsis: true }, { title: "失败原因", dataIndex: "failureReason", ellipsis: true },
        ]} />
    </div>;
}
