import type { ReactNode } from "react";
import type { CanvasNodeData } from "@/types/canvas";
import type { ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";
import { useCanvasImageThumbnail } from "./use-canvas-image-thumbnail";

/** Image loading is deferred until the canvas actually contains an image. */
export default function CanvasNodeImagePreview({ node, edge, placeholderColor, renderError }: {
    node: CanvasNodeData; edge: ImageThumbnailEdge | 0; placeholderColor: string; renderError: (retry: () => void) => ReactNode;
}) {
    const preview = useCanvasImageThumbnail(node, edge);
    const fit = node.metadata?.freeResize ? "object-fill" : "object-contain";
    return <div className="relative h-full w-full overflow-hidden">
        {preview.placeholderUrl ? <img src={preview.placeholderUrl} alt="" aria-hidden draggable={false} className={`pointer-events-none absolute inset-0 h-full w-full ${fit}`} /> : null}
        {preview.failed ? <div className="relative flex h-full w-full flex-col items-center justify-center gap-3" role="status">{renderError(preview.retry)}</div>
            : preview.url ? <img key={preview.key} src={preview.url} data-canvas-image-resolution={preview.edge || "original"} alt={node.title} draggable={false}
                {...canvasImageRenderProps()} onError={preview.onError} onLoad={preview.onLoad} onDragStart={event => event.preventDefault()}
                style={{ opacity: !preview.loaded && preview.placeholderUrl ? 0 : 1, filter: preview.thumbnail && !preview.loaded ? "blur(2px)" : undefined }}
                className={`cw-image-progressive pointer-events-none relative block h-full w-full select-none ${fit}`} />
                : <div className="h-full w-full animate-pulse" style={{ background: placeholderColor }} aria-label="正在恢复图片预览" />}
    </div>;
}
