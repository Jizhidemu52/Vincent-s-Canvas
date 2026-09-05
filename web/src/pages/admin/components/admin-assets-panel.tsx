import { Alert, Button, Image, Select, Table, Tag } from "antd";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { listAdminServerAssets, listAdminServerProjects, type ServerAsset, type ServerProject } from "@/services/api/server-assets";

export function AdminAssetsPanel() {
    const [assets, setAssets] = useState<ServerAsset[]>([]);
    const [projects, setProjects] = useState<ServerProject[]>([]);
    const [owner, setOwner] = useState("all");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const requestSequence = useRef(0);
    const refreshing = useRef(false);
    const refresh = async () => {
        if (refreshing.current) return;
        refreshing.current = true;
        const sequence = ++requestSequence.current;
        setLoading(true);
        try {
            const results = await Promise.allSettled([listAdminServerAssets(), listAdminServerProjects()]);
            if (sequence !== requestSequence.current) return;
            if (results[0].status === "fulfilled") setAssets(results[0].value.assets);
            if (results[1].status === "fulfilled") setProjects(results[1].value.projects);
            setError(results.flatMap((result, index) => result.status === "rejected" ? [`${index ? "项目" : "素材"}：${result.reason instanceof Error ? result.reason.message : "加载失败"}`] : []).join("；"));
        } finally {
            if (sequence === requestSequence.current) { refreshing.current = false; setLoading(false); }
        }
    };
    useEffect(() => { void refresh(); return () => { requestSequence.current++; refreshing.current = false; }; }, []);
    const rows = assets.filter((asset) => owner === "all" || asset.ownerUserId === owner);
    const owners = Array.from(new Map(assets.map((asset) => [asset.ownerUserId, asset.ownerName])).entries()).map(([value, label]) => ({ value, label }));

    return <div className="grid min-w-0 gap-5">
        <div className="wb-toolbar justify-between"><p className="text-sm text-[var(--muted-foreground)]">查看公司项目与已归档的生成素材。</p><Button className="!h-10" loading={loading} icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>刷新</Button></div>
        {error ? <Alert type="warning" showIcon title="部分项目素材数据暂未更新" description={error} action={<Button loading={loading} onClick={() => void refresh()}>重试</Button>} /> : null}
        <Table className="wb-surface min-w-0 overflow-hidden" rowKey="id" size="small" loading={loading} dataSource={projects} scroll={{ x: 1000 }} pagination={{ pageSize: 10 }} title={() => "公司项目监管"} locale={{ emptyText: "暂无可查看的公司项目" }} columns={[
            { title: "项目", dataIndex: "name", ellipsis: true }, { title: "设计师", dataIndex: "ownerName" }, { title: "部门", dataIndex: "departmentName" },
            { title: "状态", render: (_, project: ServerProject) => <Tag color={project.status === "active" ? "green" : "default"}>{project.status}</Tag> },
            { title: "任务", dataIndex: "taskCount" }, { title: "素材", dataIndex: "assetCount" }, { title: "消耗积分", dataIndex: "credits" }, { title: "更新时间", dataIndex: "updatedAt" },
        ]} />
        <div className="wb-toolbar"><Select aria-label="按设计师筛选素材" className="w-full sm:w-64" showSearch optionFilterProp="label" value={owner} onChange={setOwner} options={[{ value: "all", label: "全部设计师" }, ...owners]} /><span className="text-xs text-[var(--muted-foreground)]">当前 {rows.length} 个素材</span></div>
        <Table className="wb-surface min-w-0 overflow-hidden" rowKey="id" size="small" loading={loading} dataSource={rows} scroll={{ x: 1600 }} pagination={{ pageSize: 20 }} title={() => "公司素材监管"} locale={{ emptyText: "当前筛选下暂无素材" }} columns={[
            { title: "预览", width: 80, render: (_, asset: ServerAsset) => asset.kind === "image" ? <Image width={52} height={52} className="object-cover" loading="lazy" alt={asset.filename} src={`/api/assets/${asset.id}/content`} /> : <Tag>{asset.kind}</Tag> },
            { title: "素材", width: 200, ellipsis: true, render: (_, asset: ServerAsset) => typeof asset.metadata.title === "string" ? asset.metadata.title : asset.filename },
            { title: "设计师", dataIndex: "ownerName" }, { title: "部门", dataIndex: "departmentName" }, { title: "项目", render: (_, asset: ServerAsset) => asset.projectName || String(asset.metadata.projectId || "未归档") },
            { title: "来源", dataIndex: "source" }, { title: "操作", dataIndex: "operationType" }, { title: "模型", dataIndex: "modelName" }, { title: "大小", render: (_, asset: ServerAsset) => `${(asset.byteSize / 1024 / 1024).toFixed(2)} MB` }, { title: "时间", dataIndex: "createdAt" },
            { title: "查看", fixed: "right", width: 100, render: (_, asset: ServerAsset) => <Button type="link" icon={<Download className="size-4" />} href={`/api/assets/${asset.id}/content`} target="_blank" rel="noopener noreferrer">打开</Button> },
        ]} />
    </div>;
}
