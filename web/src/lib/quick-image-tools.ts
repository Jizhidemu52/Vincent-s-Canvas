export const QUICK_IMAGE_MODEL = "gemini-nano-banana-2.1";
export const quickImageToolKeys = ["remove-background", "hd-upscale"] as const;
export type QuickImageToolKey = (typeof quickImageToolKeys)[number];
export type QuickImageAction = "remove-background" | "hd-upscale";
export function isQuickImageTool(key: unknown): key is QuickImageToolKey {
    return typeof key === "string" && quickImageToolKeys.some(item => item === key);
}
export function quickImageTitle(action: QuickImageAction) { return action === "remove-background" ? "一键去背景" : "高清放大"; }
export function quickImageAction(key: string): QuickImageAction { return key.endsWith("remove-background") ? "remove-background" : "hd-upscale"; }
