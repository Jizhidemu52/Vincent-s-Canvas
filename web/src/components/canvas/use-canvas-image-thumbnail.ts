import { useEffect, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { acquireImageThumbnail } from "@/services/image-thumbnails";
import type { ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import type { ImageThumbnailLease } from "@/lib/image-thumbnail-cache";
import type { CanvasNodeData } from "@/types/canvas";

/** Display-only URL: never write this value into node metadata or media references. */
export function useCanvasImageThumbnail(node: CanvasNodeData, edge: ImageThumbnailEdge | 0) {
    const storageKey = node.metadata?.storageKey;
    const content = node.metadata?.content || "";
    const width = node.metadata?.naturalWidth || 0;
    const height = node.metadata?.naturalHeight || 0;
    const source = `${storageKey || ""}\n${content}`;
    const [preview, setPreview] = useState({ source, url: storageKey ? "" : content, thumbnail: false });
    useEffect(() => {
        const controller = new AbortController();
        let lease: ImageThumbnailLease | null = null;
        void (async () => {
            try {
                if (edge && storageKey && width && height) {
                    lease = await acquireImageThumbnail({ storageKey, edge, width, height }, controller.signal);
                    if (controller.signal.aborted) { lease?.release(); return; }
                    if (lease) { setPreview({ source, url: lease.url, thumbnail: true }); return; }
                }
                const url = await resolveImageUrl(storageKey, content);
                if (!controller.signal.aborted) setPreview({ source, url, thumbnail: false });
            } catch {
                if (!controller.signal.aborted) setPreview({ source, url: "", thumbnail: false });
            }
        })();
        return () => { controller.abort(); lease?.release(); };
    }, [source, storageKey, content, edge, width, height]);
    return preview.source === source ? preview : { source, url: "", thumbnail: false };
}
