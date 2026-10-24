import { readImageMeta } from "@/lib/image-utils";
import type { UploadedImage } from "@/services/image-storage";

export type StitchPreviewImage = Omit<UploadedImage, "storageKey"> & { storageKey?: string };

/** Viewing a server result must not create another persisted local original. */
export async function loadSeamlessPreview(url: string): Promise<StitchPreviewImage> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`历史图片读取失败（${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("历史图片文件为空");
    const preview = URL.createObjectURL(blob);
    try {
        const meta = await readImageMeta(preview);
        return { ...meta, url, bytes: blob.size, mimeType: blob.type || meta.mimeType };
    } finally {
        URL.revokeObjectURL(preview);
    }
}
