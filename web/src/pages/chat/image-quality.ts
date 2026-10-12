import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";

type ImageModel = { modelId: string; capabilities: string[] };
export function preferredChatImageModel<T extends ImageModel>(models: T[], preferred: (string | undefined)[], action?: "generate" | "edit"): T | undefined {
    const available = action ? models.filter(model => model.capabilities.includes(action)) : models;
    return preferred.map(id => available.find(model => model.modelId === id)).find(Boolean) || available[0];
}

export function chatImageQualitySettings(profile: ReturnType<typeof imageModelProfile>, requested?: string) {
    const quality = normalizeImageModelSettings({ size: "auto", count: "1", quality: requested || "" }, profile).quality;
    const adjustable = profile.qualityLabel !== "生成速度" && profile.qualities.length > 1;
    const labels: Record<string, string> = { auto: "自动", high: "高画质", medium: "标准", low: "普通" };
    return {
        quality, adjustable,
        options: adjustable ? profile.qualities.map(value => ({ value, label: labels[value] || value.toUpperCase() }))
            : [{ value: quality, label: "模型默认" }],
    };
}

export function resolveChatImageQuality(modelId: string, requested?: string) {
    const profile = imageModelProfile(modelId);
    const settings = chatImageQualitySettings(profile, requested);
    return { ...settings, supported: !requested || (profile.qualities.includes(requested) && (settings.adjustable || requested === settings.quality)) };
}
