import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Pagination, Skeleton, Table } from "antd";
import { getDesignLibraryStats } from "@/services/api/design-library";
import type { DesignLibraryEntry, DesignLibraryStats } from "@/types/design-library";

const metrics = [["view", "作品浏览"], ["download", "原图下载"], ["reuse", "画布复用"], ["prompt_copy", "提示词复制"]] as const;
const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

export function StatsDrawer({ entry, admin, onClose }: { entry: DesignLibraryEntry; admin: boolean; onClose: () => void }) {
    const [stats, setStats] = useState<DesignLibraryStats | null>(null);
    const [page, setPage] = useState(1);
    const [revision, setRevision] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true); setError("");
        void getDesignLibraryStats(entry.id, page, admin, controller.signal).then(value => { if (!controller.signal.aborted) setStats(value); }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "统计加载失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [entry.id, page, admin, revision]);
    return <Drawer open onClose={onClose} title={`使用统计 · ${entry.title}`} size={860}>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">仅作者与有管理权限的管理员可见。人数按员工去重；作者本人操作不计入。下载代表浏览器已获取原图并触发下载，不代表文件已落盘或在站外使用。</p>
        {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => setRevision(value => value + 1)}>重试</Button>} />}
        {loading && !stats ? <Skeleton active paragraph={{ rows: 8 }} /> : stats && <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">{metrics.map(([key, label]) => <div key={key} className="rounded-xl border border-border p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums">{stats.totals[key].count}<span className="ml-1 text-xs font-normal">次</span></div><div className="mt-1 text-sm text-muted-foreground">{stats.totals[key].people} 人</div></div>)}</div>
            <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">逐张图片</h3><Button size="small" loading={loading} onClick={() => setRevision(value => value + 1)}>刷新统计</Button></div>
            <Table size="small" rowKey="imageId" dataSource={stats.images} pagination={false} scroll={{ x: 560 }} columns={[
                { title: "图片", dataIndex: "filename", width: 220, ellipsis: true },
                ...metrics.slice(0, 3).map(([key, label]) => ({ title: key === "view" ? "图片观看" : label, key, render: (_: unknown, row: DesignLibraryStats["images"][number]) => `${row.counts[key].count} 次 / ${row.counts[key].people} 人` })),
            ]} locale={{ emptyText: "此作品没有图片" }} />
            <h3 className="mb-2 mt-7 font-semibold">谁下载、复用了图片</h3>
            <p className="mb-3 text-xs text-muted-foreground">只展示应用内下载和加入画布记录；不展示浏览者名单、目标画布或创作内容。</p>
            <Table size="small" rowKey="id" dataSource={stats.activity} loading={loading} pagination={false} scroll={{ x: 650 }} columns={[
                { title: "同事", key: "actor", render: (_: unknown, row: DesignLibraryStats["activity"][number]) => <div>{row.actor.name}<div className="text-xs text-muted-foreground">{row.actor.departmentName || "部门未设置"}</div></div> },
                { title: "操作", dataIndex: "action", render: (action: string) => action === "download" ? "下载原图" : "加入自己的画布" },
                { title: "图片", dataIndex: "filename", ellipsis: true },
                { title: "时间", dataIndex: "createdAt", render: dateLabel },
            ]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有下载或复用记录" /> }} />
            {stats.activityTotal > stats.pageSize && <Pagination className="mt-4" current={page} pageSize={stats.pageSize} total={stats.activityTotal} onChange={setPage} showSizeChanger={false} />}
        </>}
    </Drawer>;
}
