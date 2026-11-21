import { readImageOptions } from "./image-advanced-settings";

export const qualityTiers = [
    { id: "draft", label: "草稿", quality: "low", resolution: "1k" },
    { id: "standard", label: "标准", quality: "medium", resolution: "1k" },
    { id: "hd", label: "高清", quality: "high", resolution: "2k" },
    { id: "ultra", label: "超清", quality: "high", resolution: "4k" },
] as const;

type Tier = typeof qualityTiers[number];
type QualityProfile = { qualities: readonly string[]; resolutions: readonly string[] };

export function availableQualityTiers(profile: QualityProfile) {
    return qualityTiers.filter(tier => profile.qualities.includes(tier.quality) && profile.resolutions.includes(tier.resolution));
}

export function currentQualityTier(quality: string, imageOptions?: string) {
    const resolution = readImageOptions(imageOptions).resolution;
    return qualityTiers.find(tier => tier.quality === quality && tier.resolution === resolution)?.id ?? "custom";
}

export function qualityTierPatch(tier: Tier, imageOptions?: string) {
    return { quality: tier.quality, imageOptions: JSON.stringify({ ...readImageOptions(imageOptions), resolution: tier.resolution }) };
}
