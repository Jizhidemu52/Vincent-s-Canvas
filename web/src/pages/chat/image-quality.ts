import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { readImageOptions } from "@/lib/image-advanced-settings";
import { preferredImageModel } from "@/lib/default-image-model";

type ImageModel = { id?: string; modelId: string; capabilities: string[] };
export function preferredChatImageModel<T extends ImageModel>(models: T[], preferred: (string | undefined)[], action?: "generate" | "edit"): T | undefined {
    const available = action ? models.filter(model => model.capabilities.includes(action)) : models;
    return preferredImageModel(available, preferred);
}

export function chatImageQualitySettings(profile: ReturnType<typeof imageModelProfile>, requested?: string, requestedResolution?: string) {
    const quality = normalizeImageModelSettings({ size: "auto", count: "1", quality: requested || "" }, profile).quality;
    const adjustable = profile.qualityLabel !== "生成速度" && profile.qualities.length > 1;
    const independentResolution = profile.kind === "quality-resolution";
    const resolution = independentResolution ? (profile.resolutions.includes(requestedResolution || "") ? requestedResolution : "1k") : undefined;
    const labels: Record<string, string> = { auto: "自动", high: "高画质", medium: "标准", low: "普通" };
    return {
        quality, adjustable, independentResolution, resolution,
        label: independentResolution ? "图片质量" : ["gpt", "gemini", "resolution-1k"].includes(profile.kind) ? "清晰度" : "画质",
        resolutionOptions: profile.resolutions.map(value => ({ value, label: value.toUpperCase() })),
        options: adjustable ? profile.qualities.map(value => ({ value, label: labels[value] || value.toUpperCase() }))
            : [{ value: quality, label: "模型默认" }],
    };
}

export function resolveChatImageQuality(modelId: string, requested?: string, requestedResolution?: string) {
    const profile = imageModelProfile(modelId);
    const settings = chatImageQualitySettings(profile, requested, requestedResolution);
    const qualitySupported = !requested || (profile.qualities.includes(requested) && (settings.adjustable || requested === settings.quality));
    const resolutionSupported = !settings.independentResolution || !requestedResolution || profile.resolutions.includes(requestedResolution);
    return { ...settings, supported: qualitySupported && resolutionSupported };
}

/** Independent resolution belongs to this conversation, never the global or previous model's options. */
export function chatImageRequestOptions(value: string | undefined, resolution: string | undefined) {
    const options = readImageOptions(value);
    delete options.resolution;
    if (resolution) options.resolution = resolution;
    return Object.keys(options).length ? JSON.stringify(options) : "";
}
