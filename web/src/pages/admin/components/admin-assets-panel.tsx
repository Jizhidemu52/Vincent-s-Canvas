import { Alert, Button, DatePicker, Empty, Input, Segmented, Select, Space, Table, Tag } from "antd";
import { Grid2X2, List, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { useUserStore } from "@/stores/use-user-store";
import { InfiniteLoadMore } from "@/components/infinite-load-more";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { adminLabel } from "../admin-labels";
import { clearAssetFilters, patchAssetFilters, readAssetFilters, type AssetFilterKey } from "../assets/asset-filters";
import { assetMediaUrls, assetTitle, resultStatusLabels } from "../assets/asset-media";
import { AssetDetail } from "../assets/components/asset-detail";
import { AssetImage } from "../assets/components/asset-media";

import { listAdminAssetOwners, listAdminServerAssets, listAdminServerProjects, type ServerAsset, type ServerProject } from "@/services/api/server-assets";

export function AdminAssetsPanel() {
    const userId = useUserStore(state => state.user?.id);
    const [searchParams, setSearchParams] = useSearchParams();
    const { view, from, to, query: filters } = readAssetFilters(searchParams);
    const filterKey = JSON.stringify(filters);
    const [searchDraft, setSearchDraft] = useState(filters.q || "");
    const [tagDraft, setTagDraft] = useState(filters.tag || "");
    const [detail, setDetail] = useState<{ id: string; userId: string; filterKey: string } | null>(null);
    const previousUser = useRef(userId);
    const refreshing = useRef(false);
    const assetsQuery = useInfiniteQuery({
        queryKey: ["admin-assets", userId, filters], initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) => listAdminServerAssets({ ...filters, cursor: pageParam, limit: 60 }, signal),
        getNextPageParam: page => page.nextCursor ?? undefined,
        enabled: Boolean(userId), retry: false, refetchOnWindowFocus: false,
    });
    const projectsQuery = useQuery({ queryKey: ["admin-asset-projects", userId], queryFn: listAdminServerProjects,
        enabled: Boolean(userId), retry: false, refetchOnWindowFocus: false });
    const ownersQuery = useQuery({ queryKey: ["admin-asset-owners", userId], queryFn: ({ signal }) => listAdminAssetOwners(signal),
        enabled: Boolean(userId), retry: false, refetchOnWindowFocus: false });
    const assets = assetsQuery.data?.pages.flatMap(page => page.assets) ?? [];
    const projects = projectsQuery.data?.projects ?? [];
    const owners = ownersQuery.data?.owners ?? [];
    const loading = assetsQuery.isFetching || projectsQuery.isFetching || ownersQuery.isFetching;
    const error = [["素材", assetsQuery.error], ["项目", projectsQuery.error], ["设计师选项", ownersQuery.error]]
        .flatMap(([label, failure]) => failure ? [`${label}：${failure instanceof Error ? failure.message : "加载失败"}`] : []).join("；");
    const refresh = async () => {
        if (refreshing.current) return;
        refreshing.current = true;
        try {
            await Promise.all([assetsQuery.refetch({ cancelRefetch: false }), projectsQuery.refetch({ cancelRefetch: false }), ownersQuery.refetch({ cancelRefetch: false })]);
        } finally { refreshing.current = false; }
    };
    const updateFilters = (patch: Partial<Record<AssetFilterKey, string | undefined>>) => {
        setDetail(null);
        setSearchParams(current => patchAssetFilters(current, patch), { replace: true });
    };
    const resetFilters = () => { setDetail(null); setSearchParams(current => clearAssetFilters(current), { replace: true }); };
    const openDetail = (asset: ServerAsset) => { if (userId) setDetail({ id: asset.id, userId, filterKey }); };
    useEffect(() => { setSearchDraft(filters.q || ""); }, [filters.q]);
    useEffect(() => { setTagDraft(filters.tag || ""); }, [filters.tag]);
    useEffect(() => {
        if (previousUser.current !== userId) { previousUser.current = userId; setDetail(null); setSearchParams(current => clearAssetFilters(current), { replace: true }); }
    }, [userId, setSearchParams]);

    return <div className="grid min-w-0 gap-5">
        <div className="wb-toolbar justify-between"><p className="text-sm text-[var(--muted-foreground)]">查看当前管理范围内的项目与素材；图片墙包含生成结果及上传图片，不改变共享权限。</p><Button className="!h-10" loading={loading} icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>刷新</Button></div>
        {error ? <Alert type="warning" showIcon title="部分项目素材数据暂未更新" description={error} action={<Button loading={loading} onClick={() => void refresh()}>重试</Button>} /> : null}
        <Table className="wb-surface min-w-0 overflow-hidden" rowKey="id" size="small" loading={projectsQuery.isFetching} dataSource={projects} scroll={{ x: 1100 }} pagination={{ pageSize: 10 }} title={() => "公司项目监管"} locale={{ emptyText: "暂无可查看的公司项目" }} columns={[
            { title: "项目", dataIndex: "name", ellipsis: true }, { title: "设计师", dataIndex: "ownerName" }, { title: "部门", dataIndex: "departmentName" },
            { title: "状态", render: (_, project: ServerProject) => <Tag color={project.status === "active" ? "green" : "default"}>{adminLabel(project.status)}</Tag> },
            { title: "任务", dataIndex: "taskCount" }, { title: "素材", dataIndex: "assetCount" }, { title: "消耗积分", dataIndex: "credits" }, { title: "更新时间（北京时间）", dataIndex: "updatedAt", render: formatBeijingDateTime },
            { title: "操作", width: 100, fixed: "right", render: (_, project: ServerProject) => <Button type="link" onClick={() => { setDetail(null); setSearchParams(current => patchAssetFilters(clearAssetFilters(current), { assetProject: project.id }), { replace: true }); }}>查看素材</Button> },
        ]} />
        <section aria-label="素材筛选" className="wb-surface grid min-w-0 gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><Segmented aria-label="素材视图" value={view} onChange={value => updateFilters({ assetView: value === "list" ? "list" : undefined, assetKind: undefined })} options={[{ value: "wall", label: "图片墙", icon: <Grid2X2 className="inline size-4" /> }, { value: "list", label: "全部素材列表", icon: <List className="inline size-4" /> }]} /><span className="text-xs text-[var(--muted-foreground)]" role="status">已加载 {assets.length} 个{view === "wall" ? "图片素材" : "素材"}，不是全部总数</span></div>
            <div className="flex min-w-0 flex-wrap gap-2">
                <Space.Compact className="w-full sm:w-72"><Input aria-label="素材关键词" placeholder="搜索提示词、文件名或标题" maxLength={200} allowClear value={searchDraft} onChange={event => { setSearchDraft(event.target.value); if (!event.target.value) updateFilters({ assetQ: undefined }); }} onPressEnter={() => updateFilters({ assetQ: searchDraft.trim() || undefined })} /><Button aria-label="搜索素材" icon={<Search className="size-4" />} onClick={() => updateFilters({ assetQ: searchDraft.trim() || undefined })} /></Space.Compact>
                <Select aria-label="按设计师筛选素材" className="w-full sm:w-48" showSearch allowClear placeholder="全部设计师" optionFilterProp="label" value={filters.ownerUserId} onChange={value => updateFilters({ assetOwner: value })} options={owners} />
                <Select aria-label="按项目筛选素材" className="w-full sm:w-48" showSearch allowClear placeholder="全部项目" optionFilterProp="label" value={filters.projectId} onChange={value => updateFilters({ assetProject: value })} options={projects.map(project => ({ value: project.id, label: project.name }))} />
                <Space.Compact className="w-full sm:w-48"><Input aria-label="素材标签" placeholder="精确标签" maxLength={100} allowClear value={tagDraft} onChange={event => { setTagDraft(event.target.value); if (!event.target.value) updateFilters({ assetTag: undefined }); }} onPressEnter={() => updateFilters({ assetTag: tagDraft.trim() || undefined })} /><Button aria-label="筛选标签" icon={<Search className="size-4" />} onClick={() => updateFilters({ assetTag: tagDraft.trim() || undefined })} /></Space.Compact>
                <DatePicker.RangePicker className="w-full sm:w-auto" aria-label="素材日期范围（北京时间）" value={from && to ? [dayjs(from), dayjs(to)] : null} onChange={(_dates, dateStrings) => updateFilters({ assetFrom: dateStrings[0] || undefined, assetTo: dateStrings[1] || undefined })} />
                <Select aria-label="素材时间排序" className="w-32" value={filters.sort} onChange={value => updateFilters({ assetSort: value === "oldest" ? value : undefined })} options={[{ value: "newest", label: "最新在前" }, { value: "oldest", label: "最早在前" }]} />
                {view === "list" ? <Select aria-label="素材类型" className="w-32" allowClear placeholder="全部类型" value={filters.kind} onChange={value => updateFilters({ assetKind: value })} options={[{ value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "text", label: "文字" }, { value: "other", label: "其他" }]} /> : null}
                <Button onClick={resetFilters}>重置筛选</Button>
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">日期按北京时间整日筛选；打开详情才读取完整提示词和参数。</p>
        </section>
        {view === "wall" ? <section aria-label="素材图片墙" aria-busy={assetsQuery.isFetching}>
            {!assets.length ? (assetsQuery.isFetching ? <p role="status" className="p-6 text-center text-sm">正在读取图片素材…</p> : assetsQuery.error ? null : <Empty description="当前筛选下暂无图片素材" />) : <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {assets.map(asset => {
                    const media = asset.status === "ready" && asset.kind === "image" ? assetMediaUrls(asset.id) : null;
                    return <button type="button" key={asset.id} aria-label={`查看素材：${assetTitle(asset)}`} className="wb-surface min-w-0 overflow-hidden text-left transition-colors hover:border-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]" onClick={() => openDetail(asset)}>
                        <div className="flex min-h-32 items-center justify-center bg-[var(--muted)] p-2">{media ? <AssetImage key={media.thumbnail} src={media.thumbnail} alt={assetTitle(asset)} /> : <span className="p-5 text-sm text-[var(--muted-foreground)]">{asset.status !== "ready" ? `尚不可预览：${adminLabel(asset.status)}` : `${adminLabel(asset.kind)}素材`}</span>}</div>
                        <div className="grid gap-2 p-3"><h3 className="truncate text-sm font-medium">{assetTitle(asset)}</h3><p className="truncate text-xs text-[var(--muted-foreground)]">{asset.ownerName || "—"} · {asset.modelName || "未记录模型"}</p><div className="flex flex-wrap items-center justify-between gap-1"><span className="text-xs text-[var(--muted-foreground)]">{formatBeijingDateTime(asset.createdAt)}</span><Tag>{resultStatusLabels[asset.resultStatus] || "未标记"}</Tag></div></div>
                    </button>;
                })}
            </div>}
        </section> : <Table className="wb-surface min-w-0 overflow-hidden" rowKey="id" size="small" loading={assetsQuery.isFetching} dataSource={assets} scroll={{ x: 1600 }} pagination={false} title={() => "公司素材监管"} locale={{ emptyText: "当前筛选下暂无素材" }} columns={[
            { title: "预览", width: 80, render: (_, asset: ServerAsset) => { const media = asset.kind === "image" && asset.status === "ready" ? assetMediaUrls(asset.id) : null; return media ? <button type="button" aria-label={`查看素材：${assetTitle(asset)}`} onClick={() => openDetail(asset)}><AssetImage key={media.thumbnail} compact src={media.thumbnail} alt={assetTitle(asset)} /></button> : <Tag>{asset.status === "ready" ? adminLabel(asset.kind) : adminLabel(asset.status)}</Tag>; } },
            { title: "素材", width: 200, ellipsis: true, render: (_, asset: ServerAsset) => assetTitle(asset) },
            { title: "设计师", dataIndex: "ownerName" }, { title: "部门", dataIndex: "departmentName" }, { title: "项目", render: (_, asset: ServerAsset) => asset.projectName || String(asset.metadata.projectId || "未归档") },
            { title: "来源", dataIndex: "source", render: adminLabel }, { title: "操作", dataIndex: "operationType", render: adminLabel }, { title: "模型", dataIndex: "modelName" }, { title: "大小", render: (_, asset: ServerAsset) => `${(asset.byteSize / 1024 / 1024).toFixed(2)} MB` }, { title: "时间（北京时间）", dataIndex: "createdAt", render: formatBeijingDateTime },
            { title: "查看", fixed: "right", width: 100, render: (_, asset: ServerAsset) => <Button type="link" onClick={() => openDetail(asset)}>查看详情</Button> },
        ]} />}
        <InfiniteLoadMore hasMore={Boolean(assetsQuery.hasNextPage)} loading={assetsQuery.isFetching} error={assetsQuery.error}
            resetKey={JSON.stringify([userId, filterKey])} pageKey={assetsQuery.data?.pages.at(-1)?.nextCursor} label="加载更多公司素材"
            endLabel="没有更多公司素材" onLoadMore={() => assetsQuery.fetchNextPage({ cancelRefetch: false })} />
        {detail && detail.userId === userId && detail.filterKey === filterKey ? <AssetDetail key={`${userId}:${detail.id}`} id={detail.id} userId={detail.userId} onClose={() => setDetail(null)} /> : null}
    </div>;
}
