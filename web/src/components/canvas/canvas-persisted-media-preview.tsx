import { useUiText } from "@/lib/i18n";
import { useEffect, useState } from "react";

import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";
import { needsCanvasNodeMediaPreviewResolution, resolveCanvasNodeMediaPreview } from "@/lib/canvas/canvas-node-media-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { useImagePreview } from "@/hooks/use-image-preview";
import { readImageMeta } from "@/lib/image-utils";
import { canvasServerThumbnailUrl } from "@/lib/canvas/canvas-image-thumbnail";
import { serverAssetContentUrl } from "@/lib/canvas/canvas-image-source";

type CanvasPersistedMediaPreviewProps = {
    kind: "image" | "video";
    url?: string;
    storageKey?: string;
    serverAssetId?: string;
    alt?: string;
    className: string;
    controls?: boolean;
    placeholderClassName?: string;
    width?: number;
    height?: number;
};

/** Resolves local Blob-backed media only when its chat/card preview mounts. */
export function CanvasPersistedMediaPreview({ kind, url = "", storageKey, serverAssetId, alt = "", className, controls = false, placeholderClassName = "", width, height }: CanvasPersistedMediaPreviewProps) {
    const t = useUiText();
    const sourceUrl = serverAssetContentUrl(serverAssetId) || url;
    const source = { type: kind, content: sourceUrl, storageKey };
    const needsResolution = needsCanvasNodeMediaPreviewResolution(source);
    const [previewUrl, setPreviewUrl] = useState(() => (needsResolution ? "" : sourceUrl));
    const [loadedThumbnail, setLoadedThumbnail] = useState("");
    const sourceKey = `${storageKey || ""}:${serverAssetId || ""}:${sourceUrl}`;
    const [dimensions, setDimensions] = useState<{ source: string; width?: number; height?: number } | null>(null);
    const needsDimensions = kind === "image" && Boolean(storageKey) && !canvasServerThumbnailUrl(sourceUrl, 256) && !(width && height);
    const resolvedDimensions = dimensions?.source === sourceKey ? dimensions : null;
    const isInlineOriginal = kind === "image" && !storageKey && /^(blob:|data:)/.test(sourceUrl);
    useEffect(() => {
        if (!needsDimensions) return;
        let current = true;
        void resolveImageUrl(storageKey, sourceUrl).then(readImageMeta).then(meta => {
            if (current) setDimensions({ source: sourceKey, width: meta.width, height: meta.height });
        }).catch(() => { if (current) setDimensions({ source: sourceKey }); });
        return () => { current = false; };
    }, [needsDimensions, sourceKey, sourceUrl, storageKey]);
    const thumbnail = useImagePreview({ dataUrl: sourceUrl, storageKey, width: width || resolvedDimensions?.width, height: height || resolvedDimensions?.height }, 256, kind === "image" && !isInlineOriginal && (!needsDimensions || Boolean(resolvedDimensions)));

    useEffect(() => {
        let active = true;
        if (kind === "image") return;
        if (!needsResolution) {
            setPreviewUrl(sourceUrl);
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
    }, [kind, needsResolution, serverAssetId, sourceUrl, storageKey]);

    const imageSource = isInlineOriginal ? sourceUrl : thumbnail;
    if (kind === "image" ? !imageSource : !previewUrl) return <span aria-label={t("正在恢复媒体预览")} className={`block animate-pulse bg-muted ${placeholderClassName || className}`} />;
    if (kind === "video") return <video src={previewUrl} controls={controls} preload="metadata" className={className} />;
    return <img src={imageSource} alt={alt} {...canvasImageRenderProps()} className={`cw-persisted-preview ${className}`} data-loaded={loadedThumbnail === imageSource} onLoad={() => setLoadedThumbnail(imageSource)} />;
}
