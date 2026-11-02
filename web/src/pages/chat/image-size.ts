import { imageModelProfile, imageModelSettingsError, nearestImageSize, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type Profile = ReturnType<typeof imageModelProfile>;
type ImageSize = { width: number; height: number };
export const CHAT_FOLLOW_IMAGE_SIZE = "follow-source";

export function chatImageSizeOptions(profile: Profile) {
    return [
        { value: CHAT_FOLLOW_IMAGE_SIZE, label: "跟随底图画幅（默认）" },
        ...profile.sizes.map(value => ({ value, label: value === "auto" ? "模型自适应" : value.replace("x", " × ") })),
    ];
}

function aspect(value: string) {
    const parts = /^(\d+(?:\.\d+)?)[x:](\d+(?:\.\d+)?)$/.exec(value);
    const ratio = parts ? Number(parts[1]) / Number(parts[2]) : NaN;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

/** Follow an actual source aspect using a declared preset, never invented pixels or auto. */
export function chatImageSizeForSource(source: ImageSize, profile: Profile) {
    if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) throw new Error("底图尺寸无法读取，图片任务尚未提交。请重新添加底图。");
    const target = source.width / source.height;
    const exact = profile.sizes.find(size => {
        const ratio = aspect(size);
        return ratio !== undefined && Math.abs(Math.log(ratio / target)) < 1e-9;
    });
    if (exact) return exact;
    const choices = profile.sizes.filter(size => aspect(size) !== undefined);
    const nearest = choices.length ? nearestImageSize(`${source.width}:${source.height}`, choices) : "";
    throw new Error(`当前模型不能精确保留底图画幅（${source.width} × ${source.height}）。请在出图设置明确选择${nearest ? ` ${nearest} 等支持的尺寸，或更换模型` : "其他模型"}；图片任务尚未提交。`);
}

async function readSourceSize(source: ReferenceImage, assertCurrent: () => void) {
    const dataUrl = await imageToDataUrl(source);
    assertCurrent();
    return readImageMeta(dataUrl);
}

/** Session choices override following; pure generation retains the existing default. */
export async function resolveChatImageSize(config: AiConfig, requested: string | undefined, action: "generate" | "edit", source: ReferenceImage | undefined, assertCurrent: () => void,
    readSize: (source: ReferenceImage, assertCurrent: () => void) => Promise<ImageSize> = readSourceSize) {
    assertCurrent();
    const profile = imageModelProfile(config.model || config.imageModel);
    let size = requested || config.size;
    if (!requested && action === "edit") {
        if (!source) throw new Error("没有可用的编辑底图，图片任务尚未提交。");
        const dimensions = await readSize(source, assertCurrent);
        assertCurrent();
        size = chatImageSizeForSource(dimensions, profile);
    }
    const normalized = normalizeImageModelSettings({ ...config, size }, profile).size;
    const requestedAspect = requested && aspect(requested);
    const normalizedAspect = aspect(normalized);
    if (requested && (requested === "auto" && normalized !== "auto" || requestedAspect && (!normalizedAspect || Math.abs(Math.log(requestedAspect / normalizedAspect)) >= 1e-9))) {
        throw new Error("当前模型不支持已选择的图片尺寸，请在出图设置重新选择；图片任务尚未提交。");
    }
    const error = imageModelSettingsError(normalized, profile);
    if (error) throw new Error(error);
    return normalized;
}
