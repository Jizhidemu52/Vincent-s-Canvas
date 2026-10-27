import { useEffect, useRef, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { acquireImageThumbnail } from "@/services/image-thumbnails";
import { canvasServerThumbnailUrl, type ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import type { ImageThumbnailLease } from "@/lib/image-thumbnail-cache";
import type { CanvasNodeData } from "@/types/canvas";

type PreviewImage = { source: string; url: string; thumbnail: boolean; edge: ImageThumbnailEdge | 0; lease: ImageThumbnailLease | null };
type PreviewState = Omit<PreviewImage, "lease"> & { loaded: boolean; failed: boolean; placeholderUrl: string; request: number };

/** Display-only URL: never write this value into node metadata or media references. */
export function useCanvasImageThumbnail(node: CanvasNodeData, edge: ImageThumbnailEdge | 0) {
    const storageKey = node.metadata?.storageKey;
    const content = node.metadata?.content || "";
    const width = node.metadata?.naturalWidth || 0;
    const height = node.metadata?.naturalHeight || 0;
    const source = `${storageKey || ""}\n${content}`;
    const [attempt, setAttempt] = useState(0);
    const [originalOnly, setOriginalOnly] = useState<string | null>(null);
    const displayed = useRef<PreviewImage | null>(null);
    const candidate = useRef<PreviewImage | null>(null);
    const upgrade = useRef<(() => void) | null>(null);
    const request = useRef(0);
    const blankPreview: PreviewState = { source, url: "", thumbnail: false, edge: 0, failed: false, loaded: false, placeholderUrl: "", request: 0 };
    const [preview, setPreview] = useState<PreviewState>(blankPreview);

    useEffect(() => () => {
        displayed.current?.lease?.release();
        displayed.current = null;
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        const requestId = ++request.current;
        if (displayed.current?.source !== source) {
            displayed.current?.lease?.release();
            displayed.current = null;
        }
        const previous = displayed.current;
        setPreview(previous ? { ...previous, loaded: true, failed: false, placeholderUrl: "", request: requestId } : { ...blankPreview, request: requestId });

        const install = (image: PreviewImage) => {
            if (controller.signal.aborted) { image.lease?.release(); return; }
            candidate.current = image;
            setPreview({ ...image, loaded: false, failed: false, placeholderUrl: displayed.current?.url || "", request: requestId });
        };
        const resolve = async (requestedEdge: ImageThumbnailEdge | 0): Promise<PreviewImage | null> => {
            const serverThumbnail = originalOnly === source ? null : canvasServerThumbnailUrl(content, requestedEdge);
            if (serverThumbnail) return { source, url: serverThumbnail, thumbnail: true, edge: requestedEdge, lease: null };
            if (originalOnly !== source && requestedEdge && storageKey && width && height) {
                const lease = await acquireImageThumbnail({ storageKey, edge: requestedEdge, width, height }, controller.signal);
                if (controller.signal.aborted) { lease?.release(); return null; }
                if (lease) return { source, url: lease.url, thumbnail: true, edge: requestedEdge, lease };
            }
            return null;
        };
        const loadTarget = async () => {
            try {
                const thumbnail = await resolve(edge);
                if (controller.signal.aborted) { thumbnail?.lease?.release(); return; }
                if (thumbnail) { install(thumbnail); return; }
                const url = await resolveImageUrl(storageKey, content);
                if (controller.signal.aborted) return;
                if (url) install({ source, url, thumbnail: false, edge: 0, lease: null });
                else setPreview(value => ({ ...value, failed: true }));
            } catch {
                if (!controller.signal.aborted) setPreview(value => ({ ...value, failed: true }));
            }
        };
        void (async () => {
            // A cold detailed view starts with the smallest derivative. Its load
            // event, not just its URL, starts the upgrade so there is always a
            // decoded image underneath the expensive original.
            const canStartSmall = Math.max(width, height) > 256 || (!width && !height && Boolean(canvasServerThumbnailUrl(content, 256)));
            if (!previous && canStartSmall && edge !== 256 && originalOnly !== source) {
                try {
                    const small = await resolve(256);
                    if (controller.signal.aborted) { small?.lease?.release(); return; }
                    if (small) {
                        upgrade.current = () => { void loadTarget(); };
                        install(small);
                        return;
                    }
                } catch { /* Derivatives are optional; the original is authoritative. */ }
            }
            await loadTarget();
        })();
        return () => {
            controller.abort();
            upgrade.current = null;
            candidate.current?.lease?.release();
            candidate.current = null;
        };
    }, [source, storageKey, content, edge, width, height, originalOnly, attempt]);
    const current = preview.source === source ? preview : blankPreview;
    return {
        ...current,
        key: `${source}:${attempt}:${current.url}`,
        onLoad: () => {
            if (current.request !== request.current || current.source !== source || current.loaded) return;
            const image = candidate.current;
            if (!image || image.source !== source || image.url !== current.url) return;
            displayed.current?.lease?.release();
            displayed.current = image;
            candidate.current = null;
            setPreview(value => ({ ...value, loaded: true, placeholderUrl: "" }));
            const next = upgrade.current;
            upgrade.current = null;
            next?.();
        },
        onError: () => {
            if (current.request !== request.current || current.source !== source) return;
            // A failed derivative gets one original fallback, never an automatic retry loop.
            if (current.thumbnail) setOriginalOnly(source);
            else setPreview(value => value.source === source && value.url === current.url ? { ...value, failed: true } : value);
        },
        retry: () => { setOriginalOnly(null); setAttempt(value => value + 1); },
    };
}
