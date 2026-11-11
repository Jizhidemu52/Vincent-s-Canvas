import { uploadServerAsset } from "@/services/api/server-assets";
import { LAYER_STUDIO_MAX_REFERENCE_BYTES, LAYER_STUDIO_MAX_REFERENCE_PIXELS } from "../../../../shared/layer-studio-options";
import type { LayerStudioReference } from "./page-state";

const formats: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
export const LAYER_STUDIO_REFERENCE_ACCEPT = Object.keys(formats).map(extension => `.${extension}`).join(",");

export function layerStudioReferenceFile(file: File) {
    const type = formats[file.name.split(".").pop()?.toLowerCase() || ""];
    if (!type || (file.type && !Object.values(formats).includes(file.type.toLowerCase()))) throw new Error("仅支持 JPEG、PNG、WebP、BMP、TIFF、GIF、HEIC、HEIF；请自行转换 AVIF / JP2 的副本。");
    if (!file.size || file.size > LAYER_STUDIO_MAX_REFERENCE_BYTES) throw new Error("每张参考图需大于 0 字节且不超过 30 MiB。");
    // Supply missing MIME metadata without modifying or re-encoding a single byte.
    return file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
}

export async function saveLayerStudioReference(source: File, ownerId: string, assertCurrent: () => void): Promise<LayerStudioReference> {
    const file = layerStudioReferenceFile(source);
    assertCurrent();
    let dimensions: { width: number; height: number } | undefined;
    try {
        const bitmap = await createImageBitmap(file);
        dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
    } catch { /* TIFF / HEIF may be valid provider inputs without a browser decoder. Server preflight checks them. */ }
    assertCurrent();
    if (dimensions && dimensions.width * dimensions.height > LAYER_STUDIO_MAX_REFERENCE_PIXELS) throw new Error("参考图总像素不能超过 3600 万，原图未修改。");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
    const sha256 = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
    assertCurrent();
    const id = await uploadServerAsset(file, { source: "layer-studio-reference", sha256, ...dimensions }, { expectedOwnerId: ownerId, clientReferenceId: `layer-studio:${sha256}` })
        .catch(() => { throw new Error("原图上传未完成；尚未创建生成任务，原始文件未修改。请检查格式或联系管理员。"); });
    assertCurrent();
    return { id, name: file.name, mimeType: file.type, bytes: file.size, sha256, ...dimensions, previewable: Boolean(dimensions) };
}
