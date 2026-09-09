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
    const mime = node.metadata?.mimeType || node.metadata?.content?.match(/^data:([^;,]+)/)?.[1] || (original && imageMimeFromFileName(original)) || "image/png";
    const extension = original && imageMimeFromFileName(original) === mime ? original.match(imageExtensionPattern)![1] : mime === "image/jpeg" ? "jpg" : mime === "image/svg+xml" ? "svg" : mime === "image/tiff" ? "tif" : mime.split("/")[1] || "png";
    return `${canvasImageExportStem(node)}.${extension.replace(/[^a-z0-9]/gi, "") || "png"}`;
}

export function canvasImageVersion(node: CanvasNodeData) {
    const value = node.metadata?.imageVersion;
    return value && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function canvasImageBaseName(node: CanvasNodeData) {
    return (node.metadata?.imageName || originalCanvasImageFileName(node) || node.title || `图片-${node.id}`).replace(imageExtensionPattern, "");
}

export function canvasImageExportStem(node: CanvasNodeData) {
    const base = canvasImageBaseName(node).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 160) || "图片";
    return `${base}_v${canvasImageVersion(node)}`;
}

/** A derived image keeps the primary reference's identity, not its prompt title. */
export function canvasImageReferenceIdentity(reference?: ReferenceImage) {
    if (!reference) return { imageVersion: 1 };
    return {
        imageName: (reference.imageName || reference.originalFileName || reference.name).replace(imageExtensionPattern, ""),
        imageVersion: (reference.imageVersion && Number.isSafeInteger(reference.imageVersion) && reference.imageVersion > 0 ? reference.imageVersion : 1) + 1,
    };
}
