import { Alert, Button, Image, Select, Table, Tag } from "antd";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useUserStore } from "@/stores/use-user-store";
import { InfiniteLoadMore } from "@/components/infinite-load-more";

import { listAdminAssetOwners, listAdminServerAssets, listAdminServerProjects, type ServerAsset, type ServerProject } from "@/services/api/server-assets";

export function AdminAssetsPanel() {
    const userId = useUserStore(state => state.user?.id);
    const [owner, setOwner] = useState("all");
    const refreshing = useRef(false);
    const assetsQuery = useInfiniteQuery({
        queryKey: ["admin-assets", userId, owner], initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) => listAdminServerAssets({ cursor: pageParam, limit: 60, ownerUserId: owner === "all" ? undefined : owner }, signal),
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
    const refresh = async (cursor?: string) => {
        if (refreshing.current) return;
        refreshing.current = true;
        try {
            if (cursor) await assetsQuery.fetchNextPage({ cancelRefetch: false });
            else await Promise.all([assetsQuery.refetch({ cancelRefetch: false }), projectsQuery.refetch({ cancelRefetch: false }), ownersQuery.refetch({ cancelRefetch: false })]);
        } finally { refreshing.current = false; }
    };
    useEffect(() => { setOwner("all"); }, [userId]);

    return <div className="grid min-w-0 gap-5">
        <div className="wb-toolbar justify-between"><p className="text-sm text-[var(--muted-foreground)]">查看公司项目与已归档的生成素材。</p><Button className="!h-10" loading={loading} icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>刷新</Button></div>
        {error ? <Alert type="warning" showIcon title="部分项目素材数据暂未更新" description={error} action={<Button loading={loading} onClick={() => void refresh()}>重试</Button>} /> : null}
        <Table className="wb-surface min-w-0 overflow-hidden" rowKey="id" size="small" loading={loading} dataSource={projects} scroll={{ x: 1000 }} pagination={{ pageSize: 10 }} title={() => "公司项目监管"} locale={{ emptyText: "暂无可查看的公司项目" }} columns={[
            { title: "项目", dataIndex: "name", ellipsis: true }, { title: "设计师", dataIndex: "ownerName" }, { title: "部门", dataIndex: "departmentName" },
            { title: "状态", render: (_, project: ServerProject) => <Tag color={project.status === "active" ? "green" : "default"}>{project.status}</Tag> },
            { title: "任务", dataIndex: "taskCount" }, { title: "素材", dataIndex: "assetCount" }, { title: "消耗积分", dataIndex: "credits" }, { title: "更新时间", dataIndex: "updatedAt" },
        ]} />
        <div className="wb-toolbar"><Select aria-label="按设计师筛选素材" className="w-full sm:w-64" showSearch optionFilterProp="label" value={owner} onChange={setOwner} options={[{ value: "all", label: "全部设计师" }, ...owners]} /><span className="text-xs text-[var(--muted-foreground)]">已加载 {assets.length} 个素材</span></div>
        <Table className="wb-surface min-w-0 overflow-hidden" rowKey="id" size="small" loading={assetsQuery.isFetching} dataSource={assets} scroll={{ x: 1600 }} pagination={false} title={() => "公司素材监管"} locale={{ emptyText: "当前筛选下暂无素材" }} columns={[
            { title: "预览", width: 80, render: (_, asset: ServerAsset) => asset.kind === "image" ? <Image width={52} height={52} className="object-cover" loading="lazy" alt={asset.filename} src={asset.thumbnailUrl || `/api/assets/${asset.id}/content`} preview={{ src: asset.contentUrl || `/api/assets/${asset.id}/content` }} /> : <Tag>{asset.kind}</Tag> },
            { title: "素材", width: 200, ellipsis: true, render: (_, asset: ServerAsset) => typeof asset.metadata.title === "string" ? asset.metadata.title : asset.filename },
            { title: "设计师", dataIndex: "ownerName" }, { title: "部门", dataIndex: "departmentName" }, { title: "项目", render: (_, asset: ServerAsset) => asset.projectName || String(asset.metadata.projectId || "未归档") },
            { title: "来源", dataIndex: "source" }, { title: "操作", dataIndex: "operationType" }, { title: "模型", dataIndex: "modelName" }, { title: "大小", render: (_, asset: ServerAsset) => `${(asset.byteSize / 1024 / 1024).toFixed(2)} MB` }, { title: "时间", dataIndex: "createdAt" },
            { title: "查看", fixed: "right", width: 100, render: (_, asset: ServerAsset) => <Button type="link" icon={<Download className="size-4" />} href={`/api/assets/${asset.id}/content`} target="_blank" rel="noopener noreferrer">打开</Button> },
        ]} />
        <InfiniteLoadMore hasMore={Boolean(assetsQuery.hasNextPage)} loading={assetsQuery.isFetching} error={assetsQuery.error}
            resetKey={JSON.stringify([userId, owner])} pageKey={assetsQuery.data?.pages.at(-1)?.nextCursor} label="加载更多公司素材"
            endLabel="没有更多公司素材" onLoadMore={() => assetsQuery.fetchNextPage({ cancelRefetch: false })} />
    </div>;
}
