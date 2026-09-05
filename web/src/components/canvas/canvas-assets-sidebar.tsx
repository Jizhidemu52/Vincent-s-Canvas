import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Empty, Input, Segmented } from "antd";
import { Clock3, Heart, Image as ImageIcon, Search, Sparkles } from "lucide-react";

import { canUserAccessAsset, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { canvasAssetsSidebarPropsEqual, type CanvasAssetsSidebarRenderState } from "@/lib/canvas/canvas-assets-sidebar-render-stability";
import { createCanvasVirtualGridWindow } from "@/lib/canvas/canvas-virtual-grid";
import { canvasAssetThumbnailRenderProps } from "@/lib/canvas/canvas-asset-thumbnail-render-quality";
import { needsCanvasAssetPreviewResolution, resolveCanvasAssetPreview } from "@/lib/canvas/canvas-asset-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";

type AssetTab = "history" | "favorites" | "community";

const assetGridColumns = 2;
const assetGridRowHeight = 126;
const assetGridRowGap = 6;
const assetGridOverscanRows = 3;

export type CanvasSidebarAsset =
    | { kind: "text"; content: string; title: string }
    | { kind: "image"; dataUrl: string; title: string; storageKey?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };

export const CanvasAssetsSidebar = memo(function CanvasAssetsSidebar({ onInsert, testId }: CanvasAssetsSidebarRenderState) {
    const assets = useAssetStore((state) => state.assets);
    const user = useUserStore((state) => state.user);
    const [tab, setTab] = useState<AssetTab>("history");
    const [keyword, setKeyword] = useState("");
    const deferredKeyword = useDeferredValue(keyword);
    const assetListRef = useRef<HTMLDivElement>(null);
    const [assetScrollTop, setAssetScrollTop] = useState(0);
    const [assetViewportHeight, setAssetViewportHeight] = useState(0);
    const scrollFrameRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef(0);

    const visibleAssets = useMemo(() => {
        const query = deferredKeyword.trim().toLowerCase();
        return assets
            .filter((asset) => canUserAccessAsset(asset, user))
            .filter((asset) => asset.kind === "image" || asset.kind === "video")
            .filter((asset) => tab !== "favorites" || asset.tags.includes("收藏") || asset.tags.includes("favorite"))
            .filter((asset) => tab !== "community" || asset.metadata?.shared === true || asset.tags.includes("共享"))
            .filter((asset) => !query || [asset.title, asset.source || "", ...asset.tags].join(" ").toLowerCase().includes(query));
    }, [assets, deferredKeyword, tab, user]);
    const virtualGrid = useMemo(
        () => createCanvasVirtualGridWindow({
            itemCount: visibleAssets.length,
            columns: assetGridColumns,
            rowHeight: assetGridRowHeight,
            rowGap: assetGridRowGap,
            scrollTop: assetScrollTop,
            viewportHeight: assetViewportHeight,
            overscanRows: assetGridOverscanRows,
        }),
        [assetScrollTop, assetViewportHeight, visibleAssets.length],
    );
    const renderedAssets = useMemo(() => visibleAssets.slice(virtualGrid.startIndex, virtualGrid.endIndex), [visibleAssets, virtualGrid.endIndex, virtualGrid.startIndex]);

    useEffect(() => {
        const element = assetListRef.current;
        if (!element) return;
        const updateViewportHeight = () => setAssetViewportHeight(element.clientHeight);
        updateViewportHeight();
        const observer = new ResizeObserver(updateViewportHeight);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(
        () => () => {
            if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
        },
        [],
    );

    const scheduleScrollWindow = useCallback((scrollTop: number) => {
        pendingScrollTopRef.current = scrollTop;
        if (scrollFrameRef.current !== null) return;
        scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = null;
            const nextScrollTop = pendingScrollTopRef.current;
            setAssetScrollTop((previous) => (previous === nextScrollTop ? previous : nextScrollTop));
        });
    }, []);

    return (
        <aside data-testid={testId} className="hidden h-full min-h-0 w-[264px] shrink-0 flex-col border-l border-stone-200/90 bg-[#fbfbf8] text-slate-900 shadow-[-10px_0_30px_rgba(28,25,23,.025)] dark:border-stone-800 dark:bg-stone-950 dark:text-stone-100 xl:flex">
            <div className="border-b border-stone-200/90 px-3 pb-3 pt-3.5 dark:border-stone-800">
                <div className="mb-3 flex items-center justify-between">
                    <div>
                        <div className="text-sm font-semibold tracking-[-.02em]">素材库</div>
                        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[.12em] text-stone-400">Library</div>
                    </div>
                    <span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] font-semibold text-stone-500 dark:bg-stone-900">{visibleAssets.length}</span>
                </div>
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
                    className="!mt-2 !rounded-lg"
                    size="small"
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="搜索素材"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    allowClear
                />
            </div>

            <div
                ref={assetListRef}
                className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3"
                onScroll={(event) => scheduleScrollWindow(event.currentTarget.scrollTop)}
            >
                {visibleAssets.length ? (
                    <div className="relative" style={{ height: virtualGrid.totalHeight }}>
                        <div className="absolute left-0 right-0 grid grid-cols-2 gap-1.5" style={{ transform: `translateY(${Math.floor(virtualGrid.startIndex / assetGridColumns) * (assetGridRowHeight + assetGridRowGap)}px)` }}>
                            {renderedAssets.map((asset) => (
                                <AssetTile key={asset.id} asset={asset} onInsert={onInsert} />
                            ))}
                        </div>
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tab === "favorites" ? "暂无收藏素材" : "暂无可用素材"} className="pt-14" />
                )}
            </div>
        </aside>
    );
}, canvasAssetsSidebarPropsEqual);

const AssetTile = memo(function AssetTile({ asset, onInsert }: { asset: Asset; onInsert: (asset: CanvasSidebarAsset) => void }) {
    const fallbackUrl = asset.kind === "image" ? asset.coverUrl || asset.data.dataUrl : asset.kind === "video" ? asset.coverUrl || asset.data.url : "";
    const needsResolution = (asset.kind === "image" || asset.kind === "video") && needsCanvasAssetPreviewResolution(asset);
    const [imageUrl, setImageUrl] = useState(() => (needsResolution ? "" : fallbackUrl));
    useEffect(() => {
        let active = true;
        if (asset.kind !== "image" && asset.kind !== "video") return;
        if (!needsResolution) {
            setImageUrl(fallbackUrl);
            return;
        }
        setImageUrl("");
        void resolveCanvasAssetPreview(asset, { resolveImage: resolveImageUrl, resolveMedia: resolveMediaUrl })
            .then((url) => {
                if (active) setImageUrl(url);
            })
            .catch(() => {
                if (active) setImageUrl("");
            });
        return () => {
            active = false;
        };
    }, [asset, fallbackUrl, needsResolution]);
    const insert = () => {
        if (asset.kind === "image") onInsert({ kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
        if (asset.kind === "video") onInsert({ kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height });
    };

    return (
        <div className="h-[126px]">
        <button type="button" className="group overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:-translate-y-px hover:border-[#ff5a1f] hover:shadow-md dark:border-stone-800 dark:bg-stone-900" onClick={insert} title={`插入 ${asset.title}`}>
            {imageUrl ? <img src={imageUrl} alt={asset.title} {...canvasAssetThumbnailRenderProps()} className="aspect-square w-full object-cover" /> : <div className="flex aspect-square items-center justify-center text-stone-400"><ImageIcon className="size-5" /></div>}
            <div className="truncate px-1.5 py-1 text-[10px] font-medium text-stone-600 dark:text-stone-300">{asset.title}</div>
        </button>
        </div>
    );
});
