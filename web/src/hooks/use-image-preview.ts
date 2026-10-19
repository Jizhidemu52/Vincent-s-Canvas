import { useEffect, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { acquireImageThumbnail } from "@/services/image-thumbnails";
import { canvasServerThumbnailUrl, type ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import type { ImageThumbnailLease } from "@/lib/image-thumbnail-cache";

export type PreviewImage = { dataUrl: string; storageKey?: string; width?: number; height?: number };

/** Display-only derivative. Callers retain the original for preview, edit and export. */
export function useImagePreview(image: PreviewImage, edge: ImageThumbnailEdge = 256, enabled = true) {
    const { dataUrl, storageKey, width, height } = image;
    const source = `${storageKey || ""}\n${dataUrl}`;
    const [preview, setPreview] = useState({ source, url: storageKey ? "" : canvasServerThumbnailUrl(dataUrl, edge) || dataUrl });
    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        let lease: ImageThumbnailLease | null = null;
        void (async () => {
            try {
                const serverUrl = canvasServerThumbnailUrl(dataUrl, edge);
                if (serverUrl) { setPreview({ source, url: serverUrl }); return; }
                if (storageKey && width && height) {
                    try { lease = await acquireImageThumbnail({ storageKey, width, height, edge }, controller.signal); }
                    catch { /* A missing derivative must not hide the original. */ }
                    if (controller.signal.aborted) { lease?.release(); return; }
                    if (lease) { setPreview({ source, url: lease.url }); return; }
                }
                const url = await resolveImageUrl(storageKey, dataUrl);
                if (!controller.signal.aborted) setPreview({ source, url });
            } catch {
                if (!controller.signal.aborted) setPreview({ source, url: "" });
            }
        })();
        return () => { controller.abort(); lease?.release(); };
    }, [enabled, source, dataUrl, storageKey, width, height, edge]);
    return preview.source === source ? preview.url : "";
}
