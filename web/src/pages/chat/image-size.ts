import { imageModelProfile, imageModelSettingsError, nearestImageSize, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type Profile = ReturnType<typeof imageModelProfile>;
type ImageSize = { width: number; height: number };
export const CHAT_AUTO_IMAGE_SIZE = "auto";

export function chatImageSizeOptions(profile: Profile) {
    return [
        { value: CHAT_AUTO_IMAGE_SIZE, label: "自动（默认）" },
        ...profile.sizes.filter(value => value !== "auto").map(value => ({ value, label: value.replace("x", " × ") })),
    ];
}

function aspect(value: string) {
    const parts = /^(\d+(?:\.\d+)?)[x:](\d+(?:\.\d+)?)$/.exec(value);
    const ratio = parts ? Number(parts[1]) / Number(parts[2]) : NaN;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

/** Models without an adaptive mode use the nearest declared preset. */
export function chatImageSizeForSource(source: ImageSize, profile: Profile) {
    if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) throw new Error("底图尺寸无法读取，图片任务尚未提交。请重新添加底图。");
    if (profile.sizes.includes("auto")) return "auto";
    return nearestImageSize(`${source.width}:${source.height}`, profile.sizes);
}

async function readSourceSize(source: ReferenceImage, assertCurrent: () => void) {
    const dataUrl = await imageToDataUrl(source);
    assertCurrent();
    return readImageMeta(dataUrl);
}

/** Automatic is the session default; explicit user-selected proportions still win. */
export async function resolveChatImageSize(config: AiConfig, requested: string | undefined, action: "generate" | "edit", source: ReferenceImage | undefined, assertCurrent: () => void,
    readSize: (source: ReferenceImage, assertCurrent: () => void) => Promise<ImageSize> = readSourceSize) {
    assertCurrent();
    const profile = imageModelProfile(config.model || config.imageModel);
    if (action === "edit" && !source) throw new Error("没有可用的编辑底图，图片任务尚未提交。");
    if (profile.kind === "mai-image" && source) return "auto";
    const automatic = !requested || requested === CHAT_AUTO_IMAGE_SIZE || requested === "follow-source";
    let size = automatic ? (profile.sizes.includes("auto") ? "auto" : config.size) : requested || config.size;
    if (automatic && action === "edit" && !profile.sizes.includes("auto")) {
        const dimensions = await readSize(source!, assertCurrent);
        assertCurrent();
        size = chatImageSizeForSource(dimensions, profile);
    }
    const normalized = normalizeImageModelSettings({ ...config, size }, profile).size;
    const requestedAspect = requested && aspect(requested);
    const normalizedAspect = aspect(normalized);
    if (!automatic && requestedAspect && (!normalizedAspect || Math.abs(Math.log(requestedAspect / normalizedAspect)) >= 1e-9)) {
        throw new Error("当前模型不支持已选择的图片尺寸，请在出图设置重新选择；图片任务尚未提交。");
    }
    const error = imageModelSettingsError(normalized, profile);
    if (error) throw new Error(error);
    return normalized;
}
