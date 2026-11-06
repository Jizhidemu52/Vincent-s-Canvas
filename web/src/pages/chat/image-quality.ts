import { adaptImageModelSettings, imageModelProfile } from "@/lib/image-model-settings";
import { imageAgentQualitySettings } from "@/lib/image-agent-defaults";
import { readImageOptions } from "@/lib/image-advanced-settings";
import { preferredImageModel } from "@/lib/default-image-model";
import type { PublicModel } from "@/services/api/business-config";

/** Conversation tasks always carry a prompt; reference-only fusion belongs to its own workbench. */
export function filterChatImageModels<T extends PublicModel>(models: T[], action?: "generate" | "edit"): T[] {
    return models.filter(model => imageModelProfile(model.modelId, models).requiresPrompt
        && (action ? model.capabilities.includes(action) : model.capabilities.some(capability => capability === "generate" || capability === "edit")));
}

export function preferredChatImageModel<T extends PublicModel>(models: T[], preferred: (string | undefined)[], action?: "generate" | "edit"): T | undefined {
    return preferredImageModel(filterChatImageModels(models, action), preferred);
}

export function chatImageQualitySettings(profile: ReturnType<typeof imageModelProfile>, requested?: string, requestedResolution?: string) {
    const { quality, resolution } = imageAgentQualitySettings(profile, requested, requestedResolution);
    const adjustable = profile.qualityLabel !== "生成速度" && profile.qualities.length > 1;
    const independentResolution = profile.resolutions.length > 0;
    const labels: Record<string, string> = { auto: "自动", high: "高画质", medium: "标准", low: "普通" };
    return {
        quality, adjustable, independentResolution, resolution,
        label: independentResolution ? "图片质量" : ["gpt", "gemini", "resolution-1k"].includes(profile.kind) ? "清晰度" : "画质",
        resolutionOptions: profile.resolutions.map(value => ({ value, label: value.toUpperCase() })),
        options: adjustable ? profile.qualities.map(value => ({ value, label: labels[value] || value.toUpperCase() }))
            : [{ value: quality, label: "模型默认" }],
    };
}

/** Explicit model changes affect only the editable session preferences. */
export function selectChatImageModel(modelId: string, session: { imageQuality?: string; imageResolution?: string; imageSize?: string }) {
    const settings = adaptImageModelSettings({ size: session.imageSize || "auto", quality: session.imageQuality || "", count: "1", imageOptions: JSON.stringify(session.imageResolution ? { resolution: session.imageResolution } : {}) }, imageModelProfile(modelId));
    const quality = resolveChatImageQuality(modelId, session.imageQuality, session.imageResolution);
    return { imageModelId: modelId, imageQuality: quality.quality, imageResolution: quality.resolution, imageSize: settings.size === "auto" ? undefined : settings.size };
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
