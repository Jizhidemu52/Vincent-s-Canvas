import { useEffect, useRef, useState } from "react";
import { Play, Video } from "lucide-react";
import { useUiText } from "@/lib/i18n";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import { canvasVideoAssetId, canvasVideoDurationLabel, createLocalVideoPoster } from "@/lib/canvas/canvas-video-poster";
import { fetchServerAssetPoster } from "@/services/api/server-assets";
import { resolveMediaUrl } from "@/services/file-storage";
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
    const previewUrl = media.source === source ? media.url : "";
    const posterUrl = poster.source === source ? poster.url : "";
    const duration = canvasVideoDurationLabel(node.metadata?.durationMs || (poster.source === source ? poster.durationMs : undefined) || (loadedDuration?.source === source ? loadedDuration.value : undefined));

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
    return <div className="relative h-full w-full overflow-hidden rounded-[inherit]" style={{ background: theme.node.fill }} data-canvas-video-content data-canvas-no-zoom
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
        {interactive && previewUrl ? <video ref={videoRef} src={previewUrl} poster={posterUrl || undefined} preload="none" controls muted playsInline className="h-full w-full object-contain" aria-label={t("播放视频")}
            onPointerDown={() => { hoverPreview.current = false; }} onKeyDown={() => { hoverPreview.current = false; }}
            onLoadedMetadata={event => { const seconds = event.currentTarget.duration; if (Number.isFinite(seconds) && seconds > 0) setLoadedDuration({ source, value: Math.round(seconds * 1000) }); }} />
            : posterUrl ? <img src={posterUrl} alt={t("视频封面")} className="pointer-events-none h-full w-full object-contain" draggable={false} />
                : <div className="flex h-full w-full items-center justify-center" style={{ color: theme.node.muted }}><Video className="size-8" /></div>}
        {duration ? <span className="pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs tabular-nums" style={{ color: theme.node.text, background: theme.toolbar.panel }}>{duration}</span> : null}
        {!interactive && posterUrl ? <span className="pointer-events-none absolute left-2 top-2 rounded p-1" style={{ color: theme.node.text, background: theme.toolbar.panel }}><Play className="size-3" /></span> : null}
    </div>;
}
