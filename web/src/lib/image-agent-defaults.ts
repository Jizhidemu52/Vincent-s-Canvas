import { normalizeImageModelSettings, type imageModelProfile } from "./image-model-settings";
import { readImageOptions } from "./image-advanced-settings";

/** New agent drafts prefer 2K / high where supported; valid explicit choices are unchanged. */
export function imageAgentQualitySettings(profile: ReturnType<typeof imageModelProfile>, requested?: string, requestedResolution?: string) {
    const preferredQuality = profile.qualities.includes("high") ? "high" : profile.qualities.includes("2k") ? "2k" : "";
    const quality = normalizeImageModelSettings({ size: "auto", count: "1", quality: profile.qualities.includes(requested || "") ? requested! : preferredQuality }, profile).quality;
    const resolution = profile.resolutions.length ? profile.resolutions.includes(requestedResolution || "") ? requestedResolution : profile.resolutions.includes("2k") ? "2k" : profile.resolutions[0] : undefined;
    return { quality, resolution };
}

export function imageAgentDraftSettings(profile: ReturnType<typeof imageModelProfile>, quality?: string, imageOptions?: string) {
    const options = readImageOptions(imageOptions);
    const defaults = imageAgentQualitySettings(profile, quality, options.resolution);
    delete options.resolution;
    if (defaults.resolution) options.resolution = defaults.resolution;
    return { quality: defaults.quality, imageOptions: JSON.stringify(options) };
}
