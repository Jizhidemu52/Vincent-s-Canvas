export const quickImageToolKeys = ["remove-background", "hd-upscale"] as const;
export type QuickImageToolKey = (typeof quickImageToolKeys)[number];
export type QuickImageAction = "remove-background" | "hd-upscale";
export function isQuickImageTool(key: unknown): key is QuickImageToolKey {
    return typeof key === "string" && quickImageToolKeys.some(item => item === key);
}
export function quickImageTitle(action: QuickImageAction) { return action === "remove-background" ? "一键去背景" : "高清放大"; }
export function quickImageAction(key: string): QuickImageAction { return key.endsWith("remove-background") ? "remove-background" : "hd-upscale"; }

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
