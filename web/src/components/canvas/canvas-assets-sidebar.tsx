import { useMemo, useState } from "react";
import { Empty, Input, Segmented } from "antd";
import { Clock3, Heart, Image as ImageIcon, Search, Sparkles } from "lucide-react";

import { canUserAccessAsset, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

type AssetTab = "history" | "favorites" | "community";

export type CanvasSidebarAsset =
    | { kind: "text"; content: string; title: string }
    | { kind: "image"; dataUrl: string; title: string; storageKey?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };

export function CanvasAssetsSidebar({ onInsert }: { onInsert: (asset: CanvasSidebarAsset) => void }) {
    const assets = useAssetStore((state) => state.assets);
    const user = useUserStore((state) => state.user);
    const [tab, setTab] = useState<AssetTab>("history");
    const [keyword, setKeyword] = useState("");

    const visibleAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((asset) => canUserAccessAsset(asset, user))
            .filter((asset) => asset.kind === "image" || asset.kind === "video")
            .filter((asset) => tab !== "favorites" || asset.tags.includes("收藏") || asset.tags.includes("favorite"))
            .filter((asset) => tab !== "community" || asset.metadata?.shared === true || asset.tags.includes("共享"))
            .filter((asset) => !query || [asset.title, asset.source || "", ...asset.tags].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, tab, user]);

    return (
        <aside className="hidden h-full min-h-0 w-[252px] shrink-0 flex-col border-l border-stone-200 bg-white/95 text-stone-900 dark:border-stone-800 dark:bg-stone-950/95 dark:text-stone-100 xl:flex">
            <div className="border-b border-stone-200 px-3 pb-3 pt-3 dark:border-stone-800">
                <Segmented
                    block
                    size="small"
                    value={tab}
                    onChange={(value) => setTab(value as AssetTab)}
                    options={[
                        { value: "history", label: <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />历史</span> },
                        { value: "favorites", label: <span className="inline-flex items-center gap-1"><Heart className="size-3" />收藏</span> },
                        { value: "community", label: <span className="inline-flex items-center gap-1"><Sparkles className="size-3" />共享</span> },
                    ]}
                />
                <Input
                    className="!mt-3 !rounded-lg"
                    size="small"
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="搜索素材"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    allowClear
                />
            </div>

            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                {visibleAssets.length ? (
                    <div className="grid grid-cols-2 gap-2">
                        {visibleAssets.map((asset) => (
                            <AssetTile key={asset.id} asset={asset} onInsert={onInsert} />
                        ))}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tab === "favorites" ? "暂无收藏素材" : "暂无可用素材"} className="pt-14" />
                )}
            </div>
        </aside>
    );
}

function AssetTile({ asset, onInsert }: { asset: Asset; onInsert: (asset: CanvasSidebarAsset) => void }) {
    const imageUrl = asset.kind === "image" ? asset.coverUrl || asset.data.dataUrl : asset.kind === "video" ? asset.coverUrl : "";
    const insert = () => {
        if (asset.kind === "image") onInsert({ kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
        if (asset.kind === "video") onInsert({ kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height });
    };

    return (
        <button type="button" className="group overflow-hidden rounded-md border border-stone-200 bg-stone-50 text-left transition hover:border-orange-400 hover:shadow-sm dark:border-stone-800 dark:bg-stone-900" onClick={insert} title={`插入 ${asset.title}`}>
            {imageUrl ? <img src={imageUrl} alt={asset.title} className="aspect-square w-full object-cover" /> : <div className="flex aspect-square items-center justify-center text-stone-400"><ImageIcon className="size-5" /></div>}
            <div className="truncate px-1.5 py-1 text-[10px] font-medium text-stone-600 dark:text-stone-300">{asset.title}</div>
        </button>
    );
}
