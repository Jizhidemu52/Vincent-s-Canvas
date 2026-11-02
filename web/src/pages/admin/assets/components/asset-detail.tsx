import { Alert, Button, Collapse, Drawer, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy-text";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { fetchServerAsset } from "@/services/api/server-assets";
import { AdminDetails, adminLabel } from "../../admin-labels";
import { assetMediaUrls, assetTitle, resultStatusLabels } from "../asset-media";
import { AssetImage } from "./asset-media";

export function AssetDetail({ id, userId, onClose }: { id: string; userId: string; onClose: () => void }) {
    const copyText = useCopyText();
    const query = useQuery({ queryKey: ["admin-asset-detail", userId, id], queryFn: ({ signal }) => fetchServerAsset(id, signal), retry: false, refetchOnWindowFocus: false });
    const asset = query.data?.asset;
    const media = asset && asset.status === "ready" ? assetMediaUrls(asset.id) : null;
    const prompt = asset?.prompt || (typeof asset?.metadata.prompt === "string" ? asset.metadata.prompt : "");
    return <Drawer open onClose={onClose} title="素材详情" size="large">
        {query.isPending ? <p role="status">正在读取完整素材详情…</p> : query.error ? <Alert type="warning" showIcon title="素材详情加载失败" description={query.error.message} action={<Button onClick={() => void query.refetch()}>重试详情</Button>} /> : asset ? <div className="grid gap-5">
            <div><h2 className="break-words text-lg font-medium">{assetTitle(asset)}</h2><p className="mt-1 text-sm text-[var(--muted-foreground)]">{asset.ownerName || "—"} · {asset.departmentName || "未分部门"} · {formatBeijingDateTime(asset.createdAt)}（北京时间）</p></div>
            {media && asset.kind === "image" ? <AssetImage key={media.preview} src={media.preview} preview={media.preview} alt={assetTitle(asset)} /> : <Alert type="info" title={asset.status !== "ready" ? `文件尚不可预览：${adminLabel(asset.status)}` : `${adminLabel(asset.kind)}素材，请按需打开原文件`} />}
            <div className="flex flex-wrap items-center gap-2"><Tag>{resultStatusLabels[asset.resultStatus] || "未标记"}</Tag><span className="text-sm text-[var(--muted-foreground)]">{asset.projectName || "未归档项目"} · {asset.modelName || "未记录模型"} · {adminLabel(asset.operationType)} · {(asset.byteSize / 1024 / 1024).toFixed(2)} MB</span></div>
            {media ? <div><Button href={media.content} target="_blank" rel="noopener noreferrer" icon={<ExternalLink className="size-4" />}>打开原文件</Button></div> : null}
            <section><div className="mb-2 flex items-center justify-between gap-3"><h3 className="font-medium">完整提示词</h3><Button size="small" disabled={!prompt} icon={<Copy className="size-3.5" />} onClick={() => void copyText(prompt, "提示词已复制")}>复制提示词</Button></div><p className="whitespace-pre-wrap break-words text-sm">{prompt || "未记录提示词"}</p></section>
            <Collapse items={[{ key: "metadata", label: "素材参数与元数据", children: <AdminDetails value={asset.metadata} /> }]} />
        </div> : null}
    </Drawer>;
}
