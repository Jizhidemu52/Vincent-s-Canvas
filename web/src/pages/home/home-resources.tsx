import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton } from "antd";
import { Link } from "react-router-dom";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { usePromptTemplateActions } from "@/components/prompts/use-prompt-template-actions";
import { useUiText } from "@/lib/i18n";
import { canUserAccessAsset, useAssetStore } from "@/stores/use-asset-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { useUserStore } from "@/stores/use-user-store";
import { listServerAssets } from "@/services/api/server-assets";
import { listPromptTemplates, promptTargetLabels } from "@/services/api/prompts";
import { isSupportedServerAsset, serverAssetToLocal } from "@/lib/server-asset-local";

export function HomeResources() {
    const t = useUiText(), user = useUserStore(state => state.user), authenticated = useUserStore(state => state.status === "authenticated");
    const assetsEnabled = useModuleEnabled("assets"), promptsEnabled = useModuleEnabled("prompts");
    const local = useAssetStore(state => state.assets);
    const recent = useQuery({ queryKey: ["home-assets", user?.id], queryFn: ({ signal }) => listServerAssets({ limit: 4 }, signal), enabled: authenticated && assetsEnabled, staleTime: 30_000, retry: false });
    const favorites = useQuery({ queryKey: ["home-prompts", user?.id], queryFn: () => listPromptTemplates({ scope: "personal", favorite: true, sort: "used", pageSize: 4 }), enabled: authenticated && promptsEnabled, staleTime: 30_000, retry: false });
    const { reuse, canvasDialog } = usePromptTemplateActions();
    const server = (recent.data?.assets || []).filter(isSupportedServerAsset).map(serverAssetToLocal);
    const serverIds = new Set(server.map(asset => asset.id));
    const items = [...server, ...local.filter(asset => !serverIds.has(asset.id) && !serverIds.has(String(asset.metadata?.serverAssetId || "")) && canUserAccessAsset(asset, user))]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
    return <div className="my-8 grid gap-8 lg:grid-cols-2">
        {assetsEnabled && <section aria-label={t("最近素材")}><div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("最近素材")}</h2><Link to="/assets" className="text-sm underline">{t("打开素材库")}</Link></div>
            {recent.isFetching && !items.length ? <div role="status" aria-label={t("正在加载素材")}><Skeleton active /></div> : items.length ? <div className="grid grid-cols-2 gap-3">{items.map(asset => <figure key={asset.id} className="wb-surface overflow-hidden">
                {asset.kind === "text" ? <p className="line-clamp-4 h-32 p-3 text-sm leading-6">{asset.data.content}</p> : <CanvasPersistedMediaPreview kind={asset.kind} url={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : asset.data.url)} storageKey={asset.data.storageKey} alt={asset.title} className="h-32 w-full object-contain" />}
                <figcaption className="truncate p-3 text-sm">{asset.title}</figcaption></figure>)}</div> : <p className="text-sm text-muted-foreground">{t("保存或上传素材后，会在这里显示最近内容。")}</p>}
            {recent.isError && <p role="alert" className="mt-2 text-sm">{t("最近素材暂未更新")}<Button type="link" onClick={() => void recent.refetch()}>{t("重试")}</Button></p>}
        </section>}
        {promptsEnabled && <section aria-label={t("收藏的提示词")}><div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("收藏的提示词")}</h2><Link to="/my-prompts" className="text-sm underline">{t("我的提示词")}</Link></div>
            {favorites.isFetching && !favorites.data ? <div role="status" aria-label={t("正在加载提示词库")}><Skeleton active /></div> : favorites.data?.templates.length ? <div className="space-y-3">{favorites.data.templates.map(item => <article key={item.id} className="wb-surface flex items-center justify-between gap-3 p-4"><div className="min-w-0"><h3 className="truncate text-sm font-medium">{item.title}</h3><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.prompt}</p></div><Button onClick={() => void reuse(item, "fill")}>{t("填入")} {t(promptTargetLabels[item.targetTool])}</Button></article>)}</div> : <p className="text-sm text-muted-foreground">{t("在提示词库收藏常用模板，下次可直接填入。")}</p>}
            {favorites.isError && <p role="alert" className="mt-2 text-sm">{t("收藏模板暂未更新")}<Button type="link" onClick={() => void favorites.refetch()}>{t("重试")}</Button></p>}
        </section>}
        {canvasDialog}
    </div>;
}
