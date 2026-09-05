import { useEffect, useState } from "react";

import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";
import { needsCanvasNodeMediaPreviewResolution, resolveCanvasNodeMediaPreview } from "@/lib/canvas/canvas-node-media-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";

type CanvasPersistedMediaPreviewProps = {
    kind: "image" | "video";
    url?: string;
    storageKey?: string;
    alt?: string;
    className: string;
    controls?: boolean;
    placeholderClassName?: string;
};

/** Resolves local Blob-backed media only when its chat/card preview mounts. */
export function CanvasPersistedMediaPreview({ kind, url = "", storageKey, alt = "", className, controls = false, placeholderClassName = "" }: CanvasPersistedMediaPreviewProps) {
    const source = { type: kind, content: url, storageKey };
    const needsResolution = needsCanvasNodeMediaPreviewResolution(source);
    const [previewUrl, setPreviewUrl] = useState(() => (needsResolution ? "" : url));

    useEffect(() => {
        let active = true;
        if (!needsResolution) {
            setPreviewUrl(url);
            return;
        }
        setPreviewUrl("");
        void resolveCanvasNodeMediaPreview(source, { resolveImage: resolveImageUrl, resolveMedia: resolveMediaUrl })
            .then((resolved) => {
                if (active) setPreviewUrl(resolved);
            })
            .catch(() => {
                if (active) setPreviewUrl("");
            });
        return () => {
            active = false;
        };
    }, [kind, needsResolution, storageKey, url]);

    if (!previewUrl) return <span aria-label="正在恢复媒体预览" className={`block animate-pulse bg-black/5 dark:bg-white/10 ${placeholderClassName || className}`} />;
    if (kind === "video") return <video src={previewUrl} controls={controls} preload="metadata" className={className} />;
    return <img src={previewUrl} alt={alt} {...canvasImageRenderProps()} className={className} />;
}
