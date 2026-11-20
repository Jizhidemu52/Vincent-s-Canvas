import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ImageIcon, Search, X } from "lucide-react";
import "./reference-picker.css";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";

const assetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assetContent = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/i;
const canvasImage = (image) =>
    typeof image === "string" &&
    (assetContent.test(image) ||
        /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(image) ||
        /^\/design-examples\/[a-z0-9._-]+$/i.test(image) ||
        image.startsWith(`blob:${window.location.origin}/`));
const asCanvasItem = (item) =>
    item &&
    typeof item.id === "string" &&
    (canvasImage(item.image) || (typeof item.storageKey === "string" && /^image:[a-z0-9_-]+$/i.test(item.storageKey)))
        ? {
              id: item.id,
              title: item.title || "未命名图片",
              image: canvasImage(item.image) ? item.image : "",
              storageKey: item.storageKey,
              width: item.width,
              height: item.height,
              kind: item.kind || "reference",
          }
        : null;
const asAssetItem = (asset) =>
    asset && assetId.test(asset.id) && asset.kind === "image" && asset.contentUrl === `/api/assets/${asset.id}/content`
        ? {
              id: asset.id,
              title: asset.filename || "未命名素材",
              image: asset.contentUrl,
              thumbnail: `/api/assets/${asset.id}/thumb?w=256`,
              kind: "reference",
          }
        : null;

async function getAssets(api, query, signal) {
    if (typeof api?.assets === "function") return api.assets(query);
    const parameters = new URLSearchParams({ kind: "image", limit: "24", ...query });
    const response = await fetch(`/api/assets?${parameters}`, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error("素材加载失败，请重试。");
    return response.json();
}

export function ReferencePicker({
    open,
    items = [],
    currentIds = [],
    onChoose,
    onClose,
    api,
    max = 4,
    initialTab = "canvas",
}) {
    const dialog = useRef(null);
    const latest = useRef(null);
    const request = useRef(0);
    const inserting = useRef(false);
    const alive = useRef(false);
    const titleId = useId();
    const descriptionId = useId();
    const panelId = useId();
    const [tab, setTab] = useState(initialTab === "assets" ? "assets" : "canvas");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(new Map());
    const [assets, setAssets] = useState([]);
    const [nextCursor, setNextCursor] = useState(null);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [chooseError, setChooseError] = useState("");
    const [revision, setRevision] = useState(0);
    const maximum = Number.isInteger(max) && max > 0 ? max : 4;
    const canvasItems = useMemo(
        () =>
            Array.from(
                new Map(
                    items
                        .map(asCanvasItem)
                        .filter(Boolean)
                        .map((item) => [item.id, item]),
                ).values(),
            ),
        [items],
    );
    const scope = `${open}:${tab}:${query}:${revision}`;
    latest.current = { api, open, scope, canvasItems, currentIds, maximum, onChoose, onClose };

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            request.current++;
        };
    }, []);

    useEffect(() => {
        const element = dialog.current;
        request.current++;
        if (!open) {
            element?.close();
            return;
        }
        const current = latest.current;
        setTab(initialTab === "assets" ? "assets" : "canvas");
        setQuery("");
        setSelected(
            new Map(
                current.canvasItems
                    .filter((item) => current.currentIds.includes(item.id))
                    .slice(0, current.maximum)
                    .map((item) => [item.id, item]),
            ),
        );
        setAssets([]);
        setNextCursor(null);
        setChooseError("");
        setLoadError("");
        if (element && !element.open) element.showModal();
    }, [open, initialTab]);

    useEffect(() => {
        const sequence = ++request.current;
        setLoadingMore(false);
        if (!open || tab !== "assets") {
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        setLoading(true);
        setLoadError("");
        setAssets([]);
        setNextCursor(null);
        const timer = setTimeout(
            async () => {
                try {
                    const result = await getAssets(
                        latest.current.api,
                        query.trim() ? { q: query.trim() } : {},
                        controller.signal,
                    );
                    if (!Array.isArray(result?.assets)) throw new Error("素材返回格式无效，请重试。");
                    if (!alive.current || request.current !== sequence || latest.current.scope !== scope) return;
                    setAssets(result.assets.map(asAssetItem).filter(Boolean));
                    setNextCursor(result.hasMore && typeof result.nextCursor === "string" ? result.nextCursor : null);
                } catch (error) {
                    if (
                        alive.current &&
                        request.current === sequence &&
                        latest.current.scope === scope &&
                        !controller.signal.aborted
                    )
                        setLoadError(error.message || "素材加载失败，请重试。");
                } finally {
                    if (alive.current && request.current === sequence && latest.current.scope === scope)
                        setLoading(false);
                }
            },
            query ? 220 : 0,
        );
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [open, tab, query, revision]);

    const loadMore = async () => {
        if (!nextCursor || loading || loadingMore || busy) return;
        const sequence = ++request.current;
        setLoadingMore(true);
        setLoadError("");
        try {
            const result = await getAssets(latest.current.api, {
                ...(query.trim() ? { q: query.trim() } : {}),
                cursor: nextCursor,
            });
            if (!Array.isArray(result?.assets)) throw new Error("素材返回格式无效，请重试。");
            if (!alive.current || request.current !== sequence || latest.current.scope !== scope) return;
            setAssets((previous) =>
                Array.from(
                    new Map(
                        [...previous, ...result.assets.map(asAssetItem).filter(Boolean)].map((item) => [item.id, item]),
                    ).values(),
                ),
            );
            setNextCursor(
                result.hasMore && typeof result.nextCursor === "string" && result.nextCursor !== nextCursor
                    ? result.nextCursor
                    : null,
            );
        } catch (error) {
            if (alive.current && request.current === sequence && latest.current.scope === scope)
                setLoadError(error.message || "更多素材加载失败，请重试。");
        } finally {
            if (alive.current && request.current === sequence && latest.current.scope === scope) setLoadingMore(false);
        }
    };

    const toggle = (item) => {
        if (busy) return;
        setChooseError("");
        setSelected((previous) => {
            const next = new Map(previous);
            if (next.has(item.id)) next.delete(item.id);
            else if (next.size < maximum) next.set(item.id, item);
            return next;
        });
    };

    const choose = async () => {
        if (!selected.size || inserting.current) return;
        inserting.current = true;
        setBusy(true);
        setChooseError("");
        try {
            await latest.current.onChoose?.(
                Array.from(selected.values(), ({ id, title, image, kind, storageKey, width, height }) => ({
                    id,
                    title,
                    image,
                    kind,
                    storageKey,
                    width,
                    height,
                })),
            );
            if (alive.current && latest.current.open) latest.current.onClose?.();
        } catch (error) {
            if (alive.current && latest.current.open) setChooseError(error.message || "图片添加失败，请重试。");
        } finally {
            inserting.current = false;
            if (alive.current) setBusy(false);
        }
    };

    const visible =
        tab === "canvas"
            ? canvasItems.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()))
            : assets;
    const switchTab = (value) => {
        if (!busy) {
            setTab(value);
            setQuery("");
            setChooseError("");
        }
    };
    const close = () => {
        if (!inserting.current) latest.current.onClose?.();
    };

    return (
        <dialog
            ref={dialog}
            className="reference-picker"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCancel={(event) => {
                event.preventDefault();
                close();
            }}
        >
            <header className="rp-header">
                <div>
                    <h2 id={titleId}>选择设计参考</h2>
                    <p id={descriptionId}>从画布或素材库选图，最多 {maximum} 张；无需下载重传。</p>
                </div>
                <button type="button" className="rp-close" aria-label="关闭参考图选择" disabled={busy} onClick={close}>
                    <X size={20} />
                </button>
            </header>
            <div
                className="rp-tabs"
                role="tablist"
                aria-label="图片来源"
                onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || busy) return;
                    event.preventDefault();
                    const next =
                        event.key === "Home"
                            ? "canvas"
                            : event.key === "End"
                              ? "assets"
                              : tab === "canvas"
                                ? "assets"
                                : "canvas";
                    switchTab(next);
                    event.currentTarget.querySelector(`[data-tab="${next}"]`)?.focus();
                }}
            >
                {[
                    ["canvas", "画布上的图片"],
                    ["assets", "我的素材"],
                ].map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        role="tab"
                        id={`${panelId}-${value}`}
                        data-tab={value}
                        tabIndex={tab === value ? 0 : -1}
                        aria-selected={tab === value}
                        aria-controls={panelId}
                        disabled={busy}
                        onClick={() => switchTab(value)}
                    >
                        {label}
                        {value === "canvas" && <span>{canvasItems.length}</span>}
                    </button>
                ))}
            </div>
            <label className="rp-search">
                <Search size={17} aria-hidden="true" />
                <input
                    type="search"
                    aria-label={tab === "canvas" ? "搜索画布图片" : "搜索我的素材"}
                    placeholder={tab === "canvas" ? "搜索画布图片名称" : "搜索素材名称"}
                    value={query}
                    disabled={busy}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </label>
            <section
                className="rp-content"
                id={panelId}
                role="tabpanel"
                aria-labelledby={`${panelId}-${tab}`}
                aria-busy={loading || loadingMore}
            >
                {loadError && tab === "assets" && (
                    <div className="rp-error" role="alert">
                        <span>{loadError}</span>
                        <button
                            type="button"
                            disabled={busy || loadingMore}
                            onClick={() =>
                                nextCursor && assets.length ? void loadMore() : setRevision((value) => value + 1)
                            }
                        >
                            重试
                        </button>
                    </div>
                )}
                {loading ? (
                    <p className="rp-empty" role="status">
                        正在加载素材…
                    </p>
                ) : visible.length ? (
                    <div className="rp-grid">
                        {visible.map((item) => {
                            const checked = selected.has(item.id);
                            const disabled = busy || (!checked && selected.size >= maximum);
                            return (
                                <button
                                    type="button"
                                    key={item.id}
                                    className="rp-card"
                                    aria-label={`选择图片：${item.title}`}
                                    aria-pressed={checked}
                                    disabled={disabled}
                                    onClick={() => toggle(item)}
                                >
                                    <span className="rp-card-image">
                                        <CanvasPersistedMediaPreview
                                            kind="image"
                                            url={item.image}
                                            storageKey={item.storageKey}
                                            width={item.width}
                                            height={item.height}
                                            alt=""
                                            className=""
                                        />
                                        <span className="rp-selected" aria-hidden="true">
                                            {checked && <Check size={14} />}
                                        </span>
                                    </span>
                                    <span className="rp-card-title">{item.title}</span>
                                    <span className="rp-card-status">
                                        {checked ? "已选择" : selected.size >= maximum ? "已达选择上限" : "点击选择"}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    !loadError && (
                        <div className="rp-empty">
                            <ImageIcon size={28} aria-hidden="true" />
                            <p>
                                {query
                                    ? "没有找到匹配图片，换个名称试试。"
                                    : tab === "canvas"
                                      ? "画布上还没有图片。可先上传图片，或切换到“我的素材”。"
                                      : "素材库中还没有可用图片。"}
                            </p>
                        </div>
                    )
                )}
                {tab === "assets" && nextCursor && !loading && (
                    <button
                        type="button"
                        className="rp-more"
                        disabled={loadingMore || busy}
                        onClick={() => void loadMore()}
                    >
                        {loadingMore ? "正在加载更多…" : "加载更多素材"}
                    </button>
                )}
            </section>
            {chooseError && (
                <p className="rp-choose-error" role="alert">
                    {chooseError}
                </p>
            )}
            <footer className="rp-footer">
                <div>
                    <span role="status" aria-live="polite">
                        已选 {selected.size} / {maximum} 张
                    </span>
                    <button
                        type="button"
                        className="rp-clear"
                        disabled={!selected.size || busy}
                        onClick={() => {
                            setSelected(new Map());
                            setChooseError("");
                        }}
                    >
                        清空选择
                    </button>
                </div>
                <button
                    type="button"
                    className="rp-confirm"
                    disabled={!selected.size || busy}
                    onClick={() => void choose()}
                >
                    {busy ? "正在添加…" : `使用这 ${selected.size} 张图片`}
                </button>
            </footer>
        </dialog>
    );
}
