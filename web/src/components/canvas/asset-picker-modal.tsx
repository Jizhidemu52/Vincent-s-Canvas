import { useUiText } from "@/lib/i18n";
import { useDisplayText, DisplayText, DisplayTranslationScope } from "@/hooks/use-display-text";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Spin, Tag, Tooltip } from "antd";
import { Check, ImageIcon, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { isSupportedServerAsset, serverAssetToLocal } from "@/lib/server-asset-local";
import { needsCanvasAssetPreviewResolution, resolveCanvasAssetPreview } from "@/lib/canvas/canvas-asset-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { fetchServerAsset, listServerAssets } from "@/services/api/server-assets";
import { canUserAccessAsset, serverAssetIdFromAsset, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export type InsertAssetPayload =
    | { kind: "text"; content: string; title: string }
    | { kind: "image"; dataUrl: string; title: string; storageKey?: string; mimeType?: string; imageName?: string; imageVersion?: number; originalFileName?: string; sourceAssetId?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert?: (payload: InsertAssetPayload) => void | Promise<void>;
    onInsertMany?: (payloads: InsertAssetPayload[]) => void | Promise<void>;
    selectionMode?: "single" | "single-image" | "multiple-images";
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, onInsertMany, onClose, selectionMode = "single" }: Props) {
    const t = useUiText();
    const ownerId = useUserStore((state) => state.user?.id);
    return (
        <Modal title={t("选择素材")} open={open} centered onCancel={onClose} footer={null} width={800} destroyOnHidden>
            <DisplayTranslationScope visible={open}><MyAssetsTab key={ownerId || "signed-out"} open={open} onInsert={onInsert} onInsertMany={onInsertMany} selectionMode={selectionMode} /></DisplayTranslationScope>
        </Modal>
    );
}

const PAGE_SIZE = 24;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

function PickerCard({ asset, selected, disabled, onClick }: { asset: Asset; selected?: boolean; disabled: boolean; onClick: () => void }) {
    const t = useUiText();
    const display = useDisplayText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const fallback = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : asset.kind === "video" ? asset.data.url : "");
    const needsResolution = (asset.kind === "image" || asset.kind === "video") && needsCanvasAssetPreviewResolution(asset);
    const [cover, setCover] = useState(() => (needsResolution ? "" : fallback));
    useEffect(() => {
        let active = true;
        if (asset.kind === "text" || !needsResolution) {
            setCover(fallback);
            return;
        }
        setCover("");
        void resolveCanvasAssetPreview(asset, { resolveImage: resolveImageUrl, resolveMedia: resolveMediaUrl })
            .then((url) => {
                if (active) setCover(url);
            })
            .catch(() => {
                if (active) setCover("");
            });
        return () => {
            active = false;
        };
    }, [asset, fallback, needsResolution]);
    return (
        <button
            type="button"
            aria-pressed={selected}
            aria-description={disabled ? t("正在处理图片或项目，请稍候…") : undefined}
            disabled={disabled}
            className="cw-asset-card group relative cursor-pointer overflow-hidden rounded-xl border text-left disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: theme.node.panel, color: theme.node.text, borderColor: selected ? theme.canvas.selectionStroke : theme.node.stroke, outline: selected ? `2px solid ${theme.canvas.selectionStroke}` : undefined, outlineOffset: -2 }}
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={display(asset.title)} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center p-3 text-center text-[13px] leading-5" style={{ background: theme.node.fill, color: theme.node.muted }}><DisplayText text={asset.title} /></div>
            )}
            <div className="p-3">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-[13px] font-medium"><DisplayText text={asset.title} /></span>
                    <Tag className="m-0 shrink-0 text-xs">{asset.kind === "image" ? t("图片") : asset.kind === "video" ? t("视频") : t("文本")}</Tag>
                </div>
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" style={{ background: `color-mix(in srgb, ${theme.node.panel} 70%, transparent)`, color: theme.node.text }}>{t(selected === undefined ? "插入" : selected ? "取消选择" : "选择图片")}</div>
            {selected ? <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs" style={{ background: theme.toolbar.activeBg, color: theme.node.text }}><Check className="size-3" />{t("已选中")}</span> : null}
        </button>
    );
}

function MyAssetsTab({ open, onInsert, onInsertMany, selectionMode }: Pick<Props, "open" | "onInsert" | "onInsertMany"> & { selectionMode: NonNullable<Props["selectionMode"]> }) {
    const t = useUiText();
    const localAssets = useAssetStore((state) => state.assets);
    const user = useUserStore((state) => state.user);
    const ownerId = user?.id;
    const [serverState, setServerState] = useState<{ ownerId: string; assets: Asset[]; loading: boolean; error: string } | null>(null);
    const [refreshRevision, setRefreshRevision] = useState(0);
    const [keyword, setKeyword] = useState("");
    const deferredKeyword = useDeferredValue(keyword);
    const [kindFilter, setKindFilter] = useState("all");
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const loadSentinel = useRef<HTMLDivElement>(null);
    const loadNext = useRef<() => void>(() => {});
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [inserting, setInserting] = useState(false);
    const insertingRef = useRef(false);
    const [insertError, setInsertError] = useState("");
    const imageOnly = selectionMode !== "single";
    const queryScope = JSON.stringify([open, ownerId, refreshRevision, deferredKeyword, kindFilter, selectionMode]);
    const queryScopeRef = useRef(queryScope);
    queryScopeRef.current = queryScope;
    const pageController = useRef<AbortController | null>(null);

    useEffect(() => {
        pageController.current?.abort();
        pageController.current = null;
        setLoadingMore(false);
        if (!open || !ownerId) return;
        const controller = new AbortController();
        const isCurrent = () => !controller.signal.aborted && queryScopeRef.current === queryScope && useUserStore.getState().user?.id === ownerId;
        setServerState((current) => ({ ownerId, assets: current?.ownerId === ownerId ? current.assets : [], loading: true, error: "" }));
        setNextCursor(null);
        void listServerAssets({ limit: PAGE_SIZE, q: deferredKeyword || undefined, kind: imageOnly ? "image" : kindFilter === "all" ? undefined : kindFilter as "image" | "video" | "text" }, controller.signal).then(({ assets, nextCursor: cursor }) => {
            if (isCurrent()) { setServerState({ ownerId, assets: assets.filter(isSupportedServerAsset).map(serverAssetToLocal), loading: false, error: "" }); setNextCursor(cursor || null); }
        }).catch((error: unknown) => {
            if (isCurrent()) setServerState((current) => ({ ownerId, assets: current?.ownerId === ownerId ? current.assets : [], loading: false, error: error instanceof Error ? error.message : "素材加载失败，请重试" }));
        });
        return () => { controller.abort(); pageController.current?.abort(); pageController.current = null; };
    }, [open, ownerId, refreshRevision, deferredKeyword, kindFilter, selectionMode]);

    useEffect(() => { setSelectedIds(new Set()); setInsertError(""); setKindFilter("all"); }, [open, ownerId, selectionMode]);

    const serverAssets = useMemo(() => serverState?.ownerId === ownerId ? serverState?.assets || [] : [], [serverState, ownerId]);
    const serverAssetIds = useMemo(() => new Set(serverAssets.map((asset) => asset.id)), [serverAssets]);
    const assets = useMemo(() => [
        ...serverAssets,
        ...localAssets.filter((asset) => !serverAssetIds.has(asset.id) && !serverAssetIds.has(serverAssetIdFromAsset(asset) || "")),
    ], [localAssets, serverAssets, serverAssetIds]);
    const loading = Boolean(open && ownerId && (serverState?.ownerId !== ownerId || serverState.loading));
    const error = serverState?.ownerId === ownerId ? serverState?.error : "";

    const filtered = useMemo(() => {
        const query = deferredKeyword.trim().toLowerCase();
        return assets
            .filter((asset) => canUserAccessAsset(asset, user, serverAssetIds.has(asset.id)))
            .filter((a) => imageOnly ? a.kind === "image" : a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, deferredKeyword, kindFilter, selectionMode, serverAssetIds, user]);

    const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
    const selected = useMemo(() => filtered.filter((asset) => selectedIds.has(asset.id)), [filtered, selectedIds]);

    useEffect(() => {
        setVisibleCount(PAGE_SIZE);
    }, [queryScope]);
    useEffect(() => {
        const target = loadSentinel.current;
        if (!target || !open || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadNext.current(); }, { rootMargin: "160px" });
        observer.observe(target);
        return () => observer.disconnect();
    }, [open, visible.length, nextCursor, loading, loadingMore]);

    const toPayload = async (asset: Asset): Promise<InsertAssetPayload> => {
        if (asset.kind === "text") {
            return { kind: "text", content: asset.data.content, title: asset.title };
        }
        return asset.kind === "video"
            ? { kind: "video", url: await resolveMediaUrl(asset.data.storageKey, asset.data.url), storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height }
            : { kind: "image", dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl), storageKey: asset.data.storageKey, title: asset.title, mimeType: asset.data.mimeType, imageName: typeof asset.metadata?.imageName === "string" ? asset.metadata.imageName : undefined, imageVersion: typeof asset.metadata?.imageVersion === "number" ? asset.metadata.imageVersion : undefined, originalFileName: typeof asset.metadata?.originalFileName === "string" ? asset.metadata.originalFileName : undefined, sourceAssetId: serverAssetIdFromAsset(asset) || undefined };
    };

    const handleInsert = async (asset: Asset) => {
        const currentUser = useUserStore.getState().user;
        if (!open || !ownerId || currentUser?.id !== ownerId || insertingRef.current || !canUserAccessAsset(asset, currentUser, serverAssetIds.has(asset.id))) return;
        setInsertError("");
        if (selectionMode === "multiple-images") {
            setSelectedIds((current) => {
                const next = new Set(current);
                if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id);
                return next;
            });
            return;
        }
        insertingRef.current = true;
        setInserting(true);
        try {
            const source = asset.kind === "text" && serverAssetIds.has(asset.id) ? serverAssetToLocal((await fetchServerAsset(asset.id)).asset) : asset;
            const payload = await toPayload(source);
            if (queryScopeRef.current === queryScope && useUserStore.getState().user?.id === ownerId) await onInsert?.(payload);
        } catch (error) {
            if (queryScopeRef.current === queryScope && useUserStore.getState().user?.id === ownerId) setInsertError(error instanceof Error ? error.message : "素材读取失败，请重试");
        } finally { insertingRef.current = false; setInserting(false); }
    };

    const loadMore = async () => {
        if (!open || !ownerId || !nextCursor || loading || loadingMore || pageController.current) return;
        const controller = new AbortController();
        pageController.current = controller;
        const isCurrent = () => !controller.signal.aborted && queryScopeRef.current === queryScope && useUserStore.getState().user?.id === ownerId;
        setLoadingMore(true);
        try {
            const result = await listServerAssets({ limit: PAGE_SIZE, cursor: nextCursor, q: deferredKeyword || undefined, kind: imageOnly ? "image" : kindFilter === "all" ? undefined : kindFilter as "image" | "video" | "text" }, controller.signal);
            if (!isCurrent()) return;
            setServerState(current => current?.ownerId === ownerId ? { ...current, assets: [...current.assets, ...result.assets.filter(isSupportedServerAsset).filter(asset => !current.assets.some(item => item.id === asset.id)).map(serverAssetToLocal)] } : current);
            setNextCursor(result.nextCursor || null);
        } catch (error) { if (isCurrent()) setServerState(current => current ? { ...current, error: error instanceof Error ? error.message : "素材加载失败" } : current); }
        finally { if (pageController.current === controller) { pageController.current = null; setLoadingMore(false); } }
    };

    loadNext.current = () => {
        if (loading || loadingMore || error) return;
        if (visibleCount < filtered.length) setVisibleCount(value => value + PAGE_SIZE);
        else if (nextCursor) void loadMore();
    };
    const confirmMultiple = async () => {
        const currentUser = useUserStore.getState().user;
        if (!open || !ownerId || currentUser?.id !== ownerId || insertingRef.current) return;
        insertingRef.current = true;
        setInserting(true);
        setInsertError("");
        try {
            const payloads = await Promise.all(selected.filter((asset) => canUserAccessAsset(asset, currentUser, serverAssetIds.has(asset.id))).map(toPayload));
            if (payloads.length && queryScopeRef.current === queryScope && useUserStore.getState().user?.id === ownerId) await onInsertMany?.(payloads);
        } catch (error) {
            if (queryScopeRef.current === queryScope && useUserStore.getState().user?.id === ownerId) setInsertError(error instanceof Error ? error.message : "素材读取失败，请重试");
        } finally { insertingRef.current = false; setInserting(false); }
    };

    return (
        <div className="flex max-h-[70dvh] min-h-80 flex-col gap-4">
            <div className="flex shrink-0 flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-muted-foreground" />}
                    placeholder={t("搜索素材")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setVisibleCount(PAGE_SIZE);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-2">
                    {kindOptions.filter(opt => !imageOnly || opt.value === "all" || opt.value === "image").map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setVisibleCount(PAGE_SIZE);
                                setKindFilter(opt.value);
                            }}
                        >
                            {t(opt.label)}
                        </Tag.CheckableTag>
                    ))}
                </div>
                <Tooltip title={!ownerId ? t("请先登录") : undefined}><Button size="small" loading={loading} disabled={!ownerId} onClick={() => setRefreshRevision((value) => value + 1)}>{t("刷新")}</Button></Tooltip>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {error ? <Alert type="error" showIcon title={t("素材加载失败")} description={error} action={<Button size="small" onClick={() => setRefreshRevision((value) => value + 1)}>{t("重试")}</Button>} /> : null}
            {visible.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} asset={asset} selected={selectionMode === "multiple-images" ? selectedIds.has(asset.id) : undefined} disabled={inserting} onClick={() => void handleInsert(asset)} />
                    ))}
                </div>
            ) : loading ? (
                <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm"><Spin size="small" />{t("正在加载素材…")}</div>
            ) : !error ? (
                <div className="wb-empty flex flex-col items-center gap-3 py-12 text-center"><ImageIcon className="size-8 text-muted-foreground" aria-hidden /><p className="text-sm text-muted-foreground">{t("没有素材")}</p>{keyword || kindFilter !== "all" ? <Button onClick={() => { setKeyword(""); setKindFilter("all"); }}>{t("清除筛选")}</Button> : ownerId ? <Button onClick={() => setRefreshRevision(value => value + 1)}>{t("刷新")}</Button> : null}</div>
            ) : null}

            <div ref={loadSentinel} className="h-1" aria-hidden />
            {nextCursor || visibleCount < filtered.length ? <Tooltip title={loading ? t("加载中…") : undefined}><Button block loading={loadingMore} disabled={loading} onClick={() => { if (visibleCount < filtered.length) setVisibleCount(value => value + PAGE_SIZE); else void loadMore(); }}>{t("加载更多素材")}</Button></Tooltip> : null}
            </div>
            {insertError ? <Alert className="shrink-0" type="error" showIcon title={t("素材读取失败，请重试")} description={insertError} /> : null}
            {selectionMode === "multiple-images" ? <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3"><span role="status" className="text-sm text-muted-foreground">{t("已选中 {count} 张图片", { count: selected.length })}</span><Tooltip title={inserting ? t("正在处理图片或项目，请稍候…") : !selected.length ? t("请先选择图片") : undefined}><Button type="primary" loading={inserting} disabled={!selected.length || inserting} onClick={() => void confirmMultiple()}>{t("加入")}{selected.length} {t(" 张参考图")}</Button></Tooltip></div> : null}
            {inserting ? <p role="status" className="text-sm text-muted-foreground">{t("正在读取素材详情…")}</p> : null}
        </div>
    );
}
