import { useEffect, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { acquireImageThumbnail } from "@/services/image-thumbnails";
import { canvasServerThumbnailUrl, type ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import type { ImageThumbnailLease } from "@/lib/image-thumbnail-cache";
import type { CanvasNodeData } from "@/types/canvas";

/** Display-only URL: never write this value into node metadata or media references. */
export function useCanvasImageThumbnail(node: CanvasNodeData, edge: ImageThumbnailEdge | 0) {
    const storageKey = node.metadata?.storageKey;
    const content = node.metadata?.content || "";
    const width = node.metadata?.naturalWidth || 0;
    const height = node.metadata?.naturalHeight || 0;
    const source = `${storageKey || ""}\n${content}`;
    const [attempt, setAttempt] = useState(0);
    const [originalOnly, setOriginalOnly] = useState<string | null>(null);
    const blankPreview = { source, url: "", thumbnail: false, failed: false };
    const [preview, setPreview] = useState({ ...blankPreview, url: storageKey ? "" : content });
    useEffect(() => {
        const controller = new AbortController();
        let lease: ImageThumbnailLease | null = null;
        setPreview(blankPreview);
        void (async () => {
            try {
                const serverThumbnail = originalOnly === source ? null : canvasServerThumbnailUrl(content, edge);
                if (serverThumbnail) {
                    setPreview({ source, url: serverThumbnail, thumbnail: true, failed: false });
                    return;
                }
                if (originalOnly !== source && edge && storageKey && width && height) {
                    lease = await acquireImageThumbnail({ storageKey, edge, width, height }, controller.signal);
                    if (controller.signal.aborted) { lease?.release(); return; }
                    if (lease) { setPreview({ source, url: lease.url, thumbnail: true, failed: false }); return; }
                }
                const url = await resolveImageUrl(storageKey, content);
                if (!controller.signal.aborted) setPreview({ source, url, thumbnail: false, failed: !url });
            } catch {
                if (!controller.signal.aborted) setPreview({ ...blankPreview, failed: true });
            }
        })();
        return () => { controller.abort(); lease?.release(); };
    }, [source, storageKey, content, edge, width, height, originalOnly, attempt]);
    const current = preview.source === source ? preview : blankPreview;
    return {
        ...current,
        key: `${source}:${attempt}:${current.thumbnail}`,
        // Successful image loads need no extra React render; only failures change UI.
        onError: () => {
            // A failed derivative gets one original fallback, never an automatic retry loop.
            if (current.thumbnail) setOriginalOnly(source);
            else setPreview(value => value.source === source && value.url === current.url ? { ...value, failed: true } : value);
        },
        retry: () => { setOriginalOnly(null); setAttempt(value => value + 1); },
    };
}
