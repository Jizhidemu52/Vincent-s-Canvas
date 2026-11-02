import type { CanvasNodeData } from "@/types/canvas";

export function canvasVideoAssetId(node: CanvasNodeData) {
    const explicit = node.metadata?.serverAssetId;
    if (explicit && /^[0-9a-f-]{36}$/i.test(explicit)) return explicit;
    return /^\/api\/assets\/([0-9a-f-]{36})\/content(?:\?.*)?$/i.exec(node.metadata?.content || "")?.[1] || null;
}

export function canvasVideoDurationLabel(durationMs?: number) {
    if (!durationMs || !Number.isFinite(durationMs) || durationMs < 0) return "";
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
        : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Local-only display derivative. Remote media stays on its authorized server thumbnail route. */
export function createLocalVideoPoster(url: string, signal: AbortSignal): Promise<{ blob: Blob; durationMs?: number }> {
    if (!url.startsWith("blob:") && !url.startsWith("data:video/")) return Promise.reject(new Error("视频没有本地封面源"));
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        let finished = false;
        const finish = (error?: Error, value?: { blob: Blob; durationMs?: number }) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            video.onloadeddata = null; video.onerror = null;
            video.pause(); video.removeAttribute("src"); video.load();
            error ? reject(error) : resolve(value!);
        };
        const abort = () => finish(new DOMException("请求已取消", "AbortError"));
        const timer = setTimeout(() => finish(new Error("读取视频封面超时")), 15_000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        video.muted = true; video.preload = "auto"; video.playsInline = true;
        video.onerror = () => finish(new Error("无法读取视频封面"));
        video.onloadeddata = () => {
            try {
                const width = video.videoWidth, height = video.videoHeight;
                if (!width || !height || width * height > 67_108_864) throw new Error("视频尺寸超出封面限制");
                const canvas = document.createElement("canvas"), ratio = Math.min(1, 256 / Math.max(width, height));
                canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
                const context = canvas.getContext("2d");
                if (!context) throw new Error("无法创建视频封面");
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                const durationMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : undefined;
                canvas.toBlob(blob => blob ? finish(undefined, { blob, durationMs }) : finish(new Error("无法编码视频封面")), "image/webp", 0.82);
            } catch (error) { finish(error instanceof Error ? error : new Error("无法读取视频封面")); }
        };
        video.src = url;
    });
}
