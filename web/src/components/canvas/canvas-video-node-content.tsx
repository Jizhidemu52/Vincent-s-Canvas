import { Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play, Video } from "lucide-react";
import { useUiText } from "@/lib/i18n";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import { canvasVideoAssetId, canvasVideoDurationLabel, createLocalVideoPoster } from "@/lib/canvas/canvas-video-poster";
import { fetchServerAssetPoster } from "@/services/api/server-assets";
import { resolveMediaUrl } from "@/services/file-storage";
import { useVideoPlayback } from "@/hooks/use-video-playback";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasVideoNodeContentProps = { node: CanvasNodeData; theme: CanvasTheme; renderQuality: CanvasRenderQuality };

export function CanvasVideoNodeContent({ node, theme, renderQuality }: CanvasVideoNodeContentProps) {
    const t = useUiText();
    const content = node.metadata?.content || "", storageKey = node.metadata?.storageKey;
    const assetId = canvasVideoAssetId(node), source = `${storageKey || ""}\n${content}\n${assetId || ""}`;
    const [media, setMedia] = useState({ source, url: storageKey ? "" : content });
    const [poster, setPoster] = useState<{ source: string; url: string; durationMs?: number }>({ source, url: "" });
    const [loadedDuration, setLoadedDuration] = useState<{ source: string; value: number }>();
    const videoRef = useRef<HTMLVideoElement>(null);
    const hoverPreview = useRef(false);
    const interactive = renderQuality === "full";
    const originalUrl = media.source === source ? media.url : "";
    const playback = useVideoPlayback({ assetId: node.metadata?.serverAssetId, originalUrl, storageKey, enabled: interactive });
    const previewUrl = playback.playbackUrl || "";
    const posterUrl = poster.source === source ? poster.url : "";
    const duration = canvasVideoDurationLabel(playback.durationMs || node.metadata?.durationMs || (poster.source === source ? poster.durationMs : undefined) || (loadedDuration?.source === source ? loadedDuration.value : undefined));

    useEffect(() => {
        let active = true;
        setMedia({ source, url: storageKey ? "" : content });
        if (storageKey) void resolveMediaUrl(storageKey, content).then(url => { if (active) setMedia({ source, url }); }).catch(() => {});
        return () => { active = false; };
    }, [source, storageKey, content]);

    useEffect(() => {
        const controller = new AbortController();
        let objectUrl = "", timer: ReturnType<typeof setTimeout> | undefined;
        const started = Date.now();
        setPoster({ source, url: "" });
        const install = (value: { blob: Blob; durationMs?: number }) => {
            if (controller.signal.aborted) return;
            objectUrl = URL.createObjectURL(value.blob);
            setPoster({ source, url: objectUrl, durationMs: value.durationMs });
        };
        const load = async () => {
            try {
                if (assetId) {
                    const value = await fetchServerAssetPoster(assetId, controller.signal);
                    if (controller.signal.aborted) return;
                    if (value.status === "pending") {
                        if (Date.now() - started < 120_000) timer = setTimeout(() => { void load(); }, value.retryAfterMs);
                    } else install(value);
                } else {
                    const localUrl = storageKey ? await resolveMediaUrl(storageKey, content) : content;
                    if (!controller.signal.aborted && /^(blob:|data:video\/)/.test(localUrl)) install(await createLocalVideoPoster(localUrl, controller.signal));
                }
            } catch { /* A display derivative must never make the original unplayable. */ }
        };
        void load();
        return () => { controller.abort(); clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [source, assetId, storageKey, content]);

    useEffect(() => {
        hoverPreview.current = false;
        const video = videoRef.current;
        return () => { video?.pause(); };
    }, [interactive, source]);

    if (!content && !storageKey) return <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}><Video className="size-7 opacity-35" /><span className="text-sm">{t("空视频节点")}</span></div>;
    return <div className="relative h-full w-full overflow-hidden rounded-[inherit]" style={{ background: theme.node.fill }} data-canvas-video-content
        onPointerEnter={event => {
            const video = videoRef.current;
            if (!interactive || event.pointerType !== "mouse" || !video?.paused) return;
            hoverPreview.current = true; video.muted = true;
            void video.play().catch(() => { hoverPreview.current = false; });
        }}
        onPointerLeave={() => {
            if (!hoverPreview.current) return;
            hoverPreview.current = false;
            const video = videoRef.current;
            if (video) { video.pause(); video.currentTime = 0; }
        }}>
        {interactive && previewUrl ? <video ref={videoRef} src={previewUrl} poster={posterUrl || undefined} preload="none" controls muted playsInline className="h-full w-full object-contain" aria-label={t("播放视频")} data-canvas-no-zoom
            onPointerDown={() => { hoverPreview.current = false; }} onKeyDown={() => { hoverPreview.current = false; }}
            onError={playback.onError}
            onLoadedMetadata={event => { playback.onLoadedMetadata(event); const seconds = event.currentTarget.duration; if (Number.isFinite(seconds) && seconds > 0) setLoadedDuration({ source, value: Math.round(seconds * 1000) }); }} />
            : posterUrl ? <img src={posterUrl} alt={t("视频封面")} className="pointer-events-none h-full w-full object-contain" draggable={false} />
                : <div className="flex h-full w-full items-center justify-center" style={{ color: theme.node.muted }}><Video className="size-8" /></div>}
        {interactive && previewUrl ? <Tooltip title={t("拖动移动，底部控制播放")}><div data-canvas-video-drag-surface className="absolute inset-x-0 top-0 cursor-grab active:cursor-grabbing"
            // Native controls live in the bottom strip. Keep that strip in screen
            // pixels when zoomed, so dragging the picture never steals seeking.
            style={{ bottom: "min(100%, calc(56px * var(--canvas-node-ui-scale, 1)))", touchAction: "none" }}
            onPointerDown={() => { hoverPreview.current = false; }} /></Tooltip> : null}
        {duration ? <span className="pointer-events-none absolute right-2 top-2 rounded px-2 py-1 text-xs tabular-nums" style={{ color: theme.node.text, background: theme.toolbar.panel }}>{duration}</span> : null}
        {interactive && playback.status === "preparing" ? <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-xs" style={{ color: theme.node.text, background: theme.node.fill }}><LoaderCircle className="size-5 animate-spin" />{t("正在准备兼容预览，最多等待 150 秒；原件未更改。")}</div> : null}
        {interactive && playback.error ? <div role="alert" data-canvas-no-zoom className="absolute inset-x-2 bottom-2 z-10 rounded p-2 text-xs" style={{ color: theme.node.text, background: theme.toolbar.panel }} onPointerDown={event => event.stopPropagation()}><p>{t(playback.error)}</p><button type="button" className="mt-1 underline" onClick={playback.retry}>{t("重试预览")}</button></div> : null}
        {interactive && playback.status === "local" ? <span className="pointer-events-none absolute left-2 top-2 max-w-[65%] rounded px-2 py-1 text-xs" style={{ color: theme.node.text, background: theme.toolbar.panel }}>{t("仅有本地原件，兼容性取决于浏览器")}</span> : null}
        {interactive && playback.width && playback.height ? <span className="pointer-events-none absolute bottom-2 left-2 rounded px-2 py-1 text-xs tabular-nums" style={{ color: theme.node.text, background: theme.toolbar.panel }}>{playback.width}x{playback.height}</span> : null}
        {!interactive && posterUrl ? <span className="pointer-events-none absolute left-2 top-2 rounded p-1" style={{ color: theme.node.text, background: theme.toolbar.panel }}><Play className="size-3" /></span> : null}
    </div>;
}
