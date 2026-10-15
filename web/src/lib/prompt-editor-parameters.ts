import { imageAdvancedParameters, imageOptionFields, readImageOptions } from "@/lib/image-advanced-settings";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import type { PublicModel } from "@/services/api/business-config";

type ImageProfile = ReturnType<typeof imageModelProfile>;

export function mergePromptEditorParameters(original: Record<string, unknown> | undefined, values: { size?: string; quality?: string; quantity?: number; imageOptions?: string }, profile?: ImageProfile) {
    const parameters = { ...original };
    // Preserve parameters not represented by this editor (video mode, duration, resolution, etc.).
    if (values.size?.trim()) parameters.size = values.size.trim(); else delete parameters.size;
    if (values.quality) parameters.quality = values.quality; else delete parameters.quality;
    parameters.quantity = 1;
    if ("count" in parameters) parameters.count = parameters.quantity;
    if (profile && values.imageOptions !== undefined) {
        const supported = new Set(imageOptionFields(profile).map(field => field.key));
        const options = Object.fromEntries(Object.entries(readImageOptions(values.imageOptions)).filter(([key]) => supported.has(key)));
        if (profile.resolutions.length && !options.resolution) options.resolution = "1k";
        parameters.imageOptions = JSON.stringify(options);
        // These image controls are represented by the profile-aware editor; never retain an old model's values.
        for (const key of ["resolution", "background", "output_format", "output_compression"]) delete parameters[key];
        Object.assign(parameters, imageAdvancedParameters(parameters.imageOptions as string, profile));
        if (profile.kind === "resolution-1k" || profile.kind === "gemini" || profile.kind === "gpt") {
            parameters.resolution = values.quality || "1k";
            delete parameters.quality;
        }
    }
    return parameters;
}

/** Restore both older flat task snapshots and newer editor snapshots using the selected model's capabilities. */
export function promptImageSettings(parameters: Record<string, unknown>, model: string, models?: readonly PublicModel[]) {
    const profile = imageModelProfile(model, models);
    let wrapped: Record<string, unknown> = {};
    if (typeof parameters.imageOptions === "string") {
        try { wrapped = readImageOptions(parameters.imageOptions); } catch { /* Older malformed wrappers still permit valid flat fields. */ }
    } else if (parameters.imageOptions && typeof parameters.imageOptions === "object" && !Array.isArray(parameters.imageOptions)) wrapped = parameters.imageOptions as Record<string, unknown>;
    const options: Record<string, string> = {};
    for (const field of imageOptionFields(profile)) {
        const value = wrapped[field.key] ?? parameters[field.key === "quality" && profile.kind === "midjourney" ? "midjourneyQuality" : field.key];
        if (value !== undefined && value !== null && value !== "") options[field.key] = typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    if (profile.resolutions.length && !profile.resolutions.includes(options.resolution || "")) options.resolution = "1k";
    const usesResolution = profile.kind === "resolution-1k" || profile.kind === "gemini" || profile.kind === "gpt";
    const normalized = normalizeImageModelSettings({
        size: typeof parameters.size === "string" ? parameters.size : "auto",
        quality: String((usesResolution ? parameters.resolution : undefined) ?? parameters.quality ?? (usesResolution ? "1k" : "auto")),
        count: String(parameters.quantity ?? parameters.count ?? 1),
    }, profile);
    return { ...normalized, imageOptions: JSON.stringify(options) };
}
