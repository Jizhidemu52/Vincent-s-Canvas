import { useUiText } from "@/lib/i18n";
import { useEffect, useState } from "react";

import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";
import { needsCanvasNodeMediaPreviewResolution, resolveCanvasNodeMediaPreview } from "@/lib/canvas/canvas-node-media-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { useImagePreview } from "@/hooks/use-image-preview";
import { readImageMeta } from "@/lib/image-utils";
import { canvasServerThumbnailUrl } from "@/lib/canvas/canvas-image-thumbnail";

type CanvasPersistedMediaPreviewProps = {
    kind: "image" | "video";
    url?: string;
    storageKey?: string;
    alt?: string;
    className: string;
    controls?: boolean;
    placeholderClassName?: string;
    width?: number;
    height?: number;
};

/** Resolves local Blob-backed media only when its chat/card preview mounts. */
export function CanvasPersistedMediaPreview({ kind, url = "", storageKey, alt = "", className, controls = false, placeholderClassName = "", width, height }: CanvasPersistedMediaPreviewProps) {
    const t = useUiText();
    const source = { type: kind, content: url, storageKey };
    const needsResolution = needsCanvasNodeMediaPreviewResolution(source);
    const [previewUrl, setPreviewUrl] = useState(() => (needsResolution ? "" : url));
    const [loadedThumbnail, setLoadedThumbnail] = useState("");
    const sourceKey = `${storageKey || ""}:${url}`;
    const [dimensions, setDimensions] = useState<{ source: string; width?: number; height?: number } | null>(null);
    const needsDimensions = kind === "image" && Boolean(storageKey) && !canvasServerThumbnailUrl(url, 256) && !(width && height);
    const resolvedDimensions = dimensions?.source === sourceKey ? dimensions : null;
    useEffect(() => {
        if (!needsDimensions) return;
        let current = true;
        void resolveImageUrl(storageKey, url).then(readImageMeta).then(meta => {
            if (current) setDimensions({ source: sourceKey, width: meta.width, height: meta.height });
        }).catch(() => { if (current) setDimensions({ source: sourceKey }); });
        return () => { current = false; };
    }, [needsDimensions, sourceKey, storageKey, url]);
    const thumbnail = useImagePreview({ dataUrl: url, storageKey, width: width || resolvedDimensions?.width, height: height || resolvedDimensions?.height }, 256, kind === "image" && (!needsDimensions || Boolean(resolvedDimensions)));

    useEffect(() => {
        let active = true;
        if (kind === "image") return;
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

    if (kind === "image" ? !thumbnail : !previewUrl) return <span aria-label={t("正在恢复媒体预览")} className={`block animate-pulse bg-muted ${placeholderClassName || className}`} />;
    if (kind === "video") return <video src={previewUrl} controls={controls} preload="metadata" className={className} />;
    return <img src={thumbnail} alt={alt} {...canvasImageRenderProps()} className={`cw-persisted-preview ${className}`} data-loaded={loadedThumbnail === thumbnail} onLoad={() => setLoadedThumbnail(thumbnail)} />;
}
