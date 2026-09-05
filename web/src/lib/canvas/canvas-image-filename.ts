import type { CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

const imageExtensionPattern = /\.(png|jpe?g|webp|gif|avif|bmp|svg|tiff?|heic|heif)$/i;

export function originalCanvasImageFileName(node: CanvasNodeData) {
    return node.metadata?.originalFileName || (imageExtensionPattern.test(node.title) ? node.title.split(/[\\/]/).pop() : undefined);
}

export function originalReferenceFileName(references: readonly ReferenceImage[]) {
    const primary = references[0];
    return primary?.originalFileName || (primary && imageExtensionPattern.test(primary.name) ? primary.name.split(/[\\/]/).pop() : undefined);
}

export function imageMimeFromFileName(name: string) {
    const extension = name.match(imageExtensionPattern)?.[1]?.toLowerCase();
    if (!extension) return undefined;
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "svg") return "image/svg+xml";
    if (extension === "tif" || extension === "tiff") return "image/tiff";
    return `image/${extension}`;
}

export function canvasImageDownloadFileName(node: CanvasNodeData) {
    const original = originalCanvasImageFileName(node);
    if (original) return original;
    const mime = node.metadata?.mimeType || node.metadata?.content?.match(/^data:([^;,]+)/)?.[1] || "image/png";
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/svg+xml" ? "svg" : mime.split("/")[1] || "png";
    return `canvas-image-${node.id}.${extension}`;
}
