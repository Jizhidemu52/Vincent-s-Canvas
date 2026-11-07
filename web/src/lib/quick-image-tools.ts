import type { QuickImageAction } from "../../../shared/quick-image-tools";
export type { QuickImageAction } from "../../../shared/quick-image-tools";

export const quickImageToolKeys = ["remove-background", "hd-upscale", "item-extract"] as const;
export type QuickImageToolKey = (typeof quickImageToolKeys)[number];
export function isQuickImageTool(key: unknown): key is QuickImageToolKey {
    return typeof key === "string" && quickImageToolKeys.some(item => item === key);
}
export function quickImageTitle(action: QuickImageAction) { return action === "remove-background" ? "一键去背景" : action === "item-extract" ? "提取产品图" : "高清放大"; }
export function quickImageAction(key: string): QuickImageAction {
    if (isQuickImageTool(key)) return key;
    throw new Error("不支持这个快捷图片操作");
}

/** Common processing boundary only. Model-specific validation belongs to the server's saved configuration. */
export function quickImageReferenceFileError(file: { size?: number; type?: string }) {
    if (file.size !== undefined && (!Number.isFinite(file.size) || file.size <= 0 || file.size > 50 * 1024 * 1024)) {
        return "请使用非空且不超过 50 MiB 的原图；原始文件未修改。";
    }
    if (file.type && !["image/png", "image/jpeg", "image/webp"].includes(file.type.toLowerCase())) {
        return "请使用 PNG、JPEG 或 WebP 原图；原始文件未修改。";
    }
    return undefined;
}
