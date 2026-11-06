import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { PublicModel } from "@/services/api/business-config";
import type { ApiUserRole } from "@/services/api/auth";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { normalizeImageOptions, readImageOptions } from "./image-advanced-settings";
import { validateGpt26GifParameters } from "../../../shared/gpt26-image-options";

type InternalImageParameterProfile = "standard" | "gpt" | "gemini" | "midjourney" | "midjourney-blend" | "unverified" | "quality-resolution" | "resolution-1k" | "grok-image" | "mai-image";
export type ImageParameterProfile = InternalImageParameterProfile | "standard-flex" | "standard-flex-plus" | "quality-resolution-v2" | "pixel" | "resolution" | "speed" | "blend";
const publicProfileKinds: Partial<Record<ImageParameterProfile, InternalImageParameterProfile>> = { "standard-flex": "standard", "standard-flex-plus": "standard", "quality-resolution-v2": "quality-resolution", pixel: "gpt", resolution: "gemini", speed: "midjourney", blend: "midjourney-blend" };
const flexibleSizes = ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840", "2880x2880", "auto"];
const flexibleRatioSizes: Record<string, string> = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864", "9:16": "864x1536", "4:3": "1536x1152", "3:4": "1152x1536" };
const gptRatios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"];
const geminiRatios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9", "1:4", "4:1", "1:8", "8:1", "auto"];
const grokRatios = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "auto"];
const maiRatios = [...gptRatios, "1:4", "4:1", "auto"];

/** Capabilities describe our configured provider adapter, not a model's marketing name. */
export function imageModelProfile(model: string, models: readonly PublicModel[] = useBusinessConfigStore.getState().models, role: ApiUserRole | undefined = useUserStore.getState().user?.role) {
    const id = modelOptionName(model).toLowerCase();
    const configured = models.find(item => [item.id, item.modelId, item.name].some(value => value.toLowerCase() === id));
    const actual = (configured?.modelId || id).toLowerCase();
    const configuredKind = configured?.imageParameterProfile;
    const kind: InternalImageParameterProfile = (configuredKind && (publicProfileKinds[configuredKind] || configuredKind) as InternalImageParameterProfile)
        || (actual === "gpt-image-2.6-flare" || actual === "gpt-image-2.6-sunburst" ? "quality-resolution" : actual === "mai-image-2.6-flash" ? "mai-image" : actual.includes("midjourney-blend") ? "midjourney-blend" : actual.includes("midjourney") ? "midjourney"
            : actual.includes("vcen-gpt2") || actual.includes("gpt-image-2-extend") ? "gpt"
                : actual.includes("gemini-3.1-flash-image-preview") || actual.includes("nano-banana-2") ? "gemini" : actual === "gemini-3.1-flash-image" ? "unverified" : "standard");
    const midjourney = kind === "midjourney" || kind === "midjourney-blend";
    const independentResolution = kind === "quality-resolution";
    const gpt26 = configuredKind === "quality-resolution-v2" || (!configuredKind && ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"].includes(actual));
    const resolutionOnly = kind === "resolution-1k";
    const grok = kind === "grok-image";
    const mai = kind === "mai-image";
    const verified = kind !== "unverified";
    const extendedQuality = kind === "standard" && (configuredKind === "standard-flex-plus" || actual === "gpt-image-2.5-flare" || actual === "gpt-image-2.5-sunburst");
    const flexibleSize = kind === "standard" && (extendedQuality || configuredKind === "standard-flex" || actual === "gpt-image-2");
    const constrainedPixels = flexibleSize || independentResolution;
    const canSeeIdentity = isAdminRole(role);
    return {
        // Ordinary image actions submit exactly one task; file batches are a separate workflow.
        kind, verified, maxCount: 1, customSize: mai || kind === "gpt" || constrainedPixels, customAspect: midjourney || mai, upstreamCount: 1,
        supportsGif: gpt26, supportsMarkup: gpt26, supportsComplexity: gpt26,
        sizeConstraints: mai ? { multiple: 1, minEdge: 768, maxEdge: 3072, maxAspectRatio: 4, minPixels: 589824, maxPixels: 2359296 } : constrainedPixels ? { multiple: 16, minEdge: 0, maxEdge: 3840, maxAspectRatio: 3, minPixels: 655360, maxPixels: 8294400 } : undefined,
        sizeConstraintMessage: mai ? "宽高须为不少于 768 的正整数，比例在 1:4 至 4:1 内，总像素不超过 2359296。建议使用 32 的倍数；否则模型会将实际输出宽高各向下取整到 32 的倍数。" : constrainedPixels ? "宽高须为 16 的倍数，单边不超过 3840，长短边比例不超过 3:1，总像素为 655360–8294400。超过 2560 × 1440 的输出为实验尺寸。" : "",
        backgrounds: constrainedPixels ? ["auto", "opaque", "transparent"] : [],
        outputFormats: constrainedPixels ? ["png", "jpeg", "webp", ...(gpt26 ? ["gif"] : [])] : [],
        outputCompression: constrainedPixels,
        resolutions: independentResolution ? ["1k", "2k", "4k"] : grok || mai ? ["1k", "2k"] : [],
        supportsMask: !mai && (configured?.imageSupportsMask ?? (!resolutionOnly && !midjourney && !grok)),
        supportsOfficialFallback: configured?.imageSupportsOfficialFallback ?? (kind !== "gemini" || !["gemini-3.1-flash-image-preview-official", "nano-banana-2"].includes(actual)),
        requiresPrompt: kind !== "midjourney-blend",
        sizes: !verified ? ["auto"] : mai ? maiRatios : grok ? grokRatios : independentResolution ? [...gptRatios, "auto"] : flexibleSize ? flexibleSizes : kind === "standard" ? ["1024x1024", "1536x1024", "1024x1536", "auto"] : kind === "gemini" || resolutionOnly ? geminiRatios : kind === "gpt" ? [...gptRatios, "auto"] : [...gptRatios, "1:4", "4:1", "1:8", "8:1"],
        qualities: !verified || mai ? ["auto"] : grok ? ["low", "medium"] : independentResolution ? ["auto", "low", "medium", "high", "xhigh", "max"] : midjourney ? ["relax", "fast", "turbo"] : extendedQuality ? ["auto", "max", "xhigh", "high", "medium", "low"] : kind === "standard" ? ["auto", "high", "medium", "low"] : kind === "gemini" ? ["0.5k", "1k", "2k", "4k"] : ["1k", "2k", "4k"],
        qualityLabel: independentResolution || grok ? "图片质量" : resolutionOnly ? "清晰度 / 分辨率" : midjourney ? "生成速度" : kind === "standard" ? "画质" : "分辨率",
        tip: !verified ? "当前渠道的此模型参数文档待确认，暂用渠道默认设置，不额外传入尺寸或画质。"
            : mai ? "文生图支持 1K / 2K、宽高比及合规像素尺寸，最多 5 张参考图。图生图尺寸由模型决定，约 100 万像素；不支持 4K、蒙版或透明背景参数，固定输出 PNG。"
            : grok ? "支持 14 种比例、1K / 2K 和最多 3 张参考图；图片质量仅文生图生效。提示词最多 8000 字符；参考图限 JPEG、PNG、WebP，单张最多 10 MiB。不支持蒙版。"
            : independentResolution ? "清晰度与图片质量独立设置；比例或自适应使用 1K / 2K / 4K 档位，精确像素尺寸优先于档位。支持 15 种比例和最多 16 张参考图。每次生成 1 张。"
            : resolutionOnly ? "支持 1K / 2K / 4K 清晰度与参考图，不支持蒙版。参考图当前工作台上限为 16 张，并非渠道公布的固定上限。"
            : kind === "midjourney-blend" ? "合成 2–4 张参考图，不使用提示词，每次提交一个任务。"
            : kind === "midjourney" ? canSeeIdentity ? "支持描述和参考图引导；可在描述中使用原生 MJ 参数，每次提交一个任务。" : "支持描述和参考图引导，每次提交一个任务。"
                : flexibleSize ? "支持 2K / 4K 像素预设及合规自定义尺寸；超过 2560 × 1440 为实验尺寸。画质与像素尺寸分别设置。"
                : kind === "standard" ? "支持三种固定尺寸及自适应；自适应由模型结合描述和参考图决定输出尺寸。画质不等于分辨率。"
                    : kind === "gemini" ? "支持 0.5K / 1K / 2K / 4K，最多 14 张参考图；参考图限 JPEG、PNG、WebP，单张最多 10 MiB。每次生成 1 张。" : "支持 1K / 2K / 4K、15 种比例及像素尺寸，最多 15 张参考图。每次生成 1 张。",
        documentationUrl: !verified || !canSeeIdentity || independentResolution || resolutionOnly ? "" : mai ? "https://docs.apib.ai/cn/api-reference/images/mai-image-2.6/generation" : grok ? "https://docs.apimart.ai/cn/api-reference/images/grok-imagine-2.0-ext/official" : kind === "gpt" ? "https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation" : kind === "gemini" ? "https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation" : midjourney ? `https://docs.apimart.ai/en/api-reference/images/midjourney/${kind === "midjourney-blend" ? "blend" : "imagine"}` : "https://docs.opentoken.io/api/openai/image-generation/",
    };
}

export function useImageModelProfile(model: string) {
    const models = useBusinessConfigStore(state => state.models);
    const role = useUserStore(state => state.user?.role);
    return imageModelProfile(model, models, role);
}

export function nearestImageSize(size: string, choices: readonly string[]) {
    const ratio = (value: string) => { const parts = /^(\d+(?:\.\d+)?)[x:](\d+(?:\.\d+)?)$/.exec(value); return parts ? Number(parts[1]) / Number(parts[2]) : null; };
    const target = ratio(size);
    if (!target) return choices.includes(size) ? size : choices[0]!;
    const valid = choices.filter(value => ratio(value));
    return valid.length ? valid.reduce((best, value) => Math.abs(Math.log(ratio(value)! / target)) < Math.abs(Math.log(ratio(best)! / target)) ? value : best) : choices[0]!;
}

/** Prefer a matching preset or legal exact dimensions; adaptive fallback never resamples the source. */
export function imageSizeForSource(source: { width: number; height: number }, profile: ReturnType<typeof imageModelProfile>) {
    if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) throw new Error("底图尺寸无法读取，图片任务尚未提交。请重新添加底图。");
    const target = source.width / source.height;
    // Flexible profiles also support these established ratio-to-pixel mappings.
    const sizes = [...new Set([...profile.sizes, ...(profile.customSize && profile.sizeConstraints ? Object.values(flexibleRatioSizes) : [])])];
    const candidates = sizes.flatMap(size => {
        const parts = /^(\d+(?:\.\d+)?)[x:](\d+(?:\.\d+)?)$/.exec(size);
        const ratio = parts ? Number(parts[1]) / Number(parts[2]) : NaN;
        if (!Number.isFinite(ratio) || ratio <= 0 || imageModelSettingsError(size, profile)) return [];
        const difference = Math.abs(Math.log(ratio / target));
        const pixelDifference = Math.min(Math.abs(source.width - source.height * ratio), Math.abs(source.height - source.width / ratio));
        return [{ size, difference, matches: difference < 1e-9 || difference <= .005 && pixelDifference <= 1 + 1e-9 }];
    });
    const matching = candidates.filter(candidate => candidate.matches).sort((a, b) => a.difference - b.difference)[0];
    if (matching) return matching.size;
    const pixels = `${source.width}x${source.height}`;
    if (profile.customSize && /^[1-9]\d*x[1-9]\d*$/.test(pixels) && !imageModelSettingsError(pixels, profile)) return pixels;
    const ratio = `${source.width}:${source.height}`;
    if (profile.customAspect && /^[1-9]\d*:[1-9]\d*$/.test(ratio) && !imageModelSettingsError(ratio, profile)) return ratio;
    // Arbitrary original dimensions need not be a valid output size. The provider's
    // adaptive mode is supported, but does not promise identical output pixels.
    if (profile.sizes.includes("auto")) return "auto";
    const nearest = candidates.length ? nearestImageSize(`${source.width}:${source.height}`, candidates.map(candidate => candidate.size)) : "";
    throw new Error(`当前模型不能精确保留底图画幅（${source.width} × ${source.height}）。请在出图设置明确选择${nearest ? ` ${nearest} 等支持的尺寸，或更换模型` : "其他模型"}；图片任务尚未提交。`);
}

export function normalizeImageModelSettings(config: Pick<AiConfig, "size" | "quality" | "count"> & { imageOptions?: string }, profile: ReturnType<typeof imageModelProfile>) {
    const rawSize = String(config.size || "").trim().toLowerCase();
    const size = imageOutputIsGif(config.imageOptions, profile) ? rawSize === "auto" || /^[1-9]\d*x[1-9]\d*$/.test(rawSize) ? rawSize : "auto"
        : profile.sizes.includes(rawSize) || (profile.customSize && /^[1-9]\d*x[1-9]\d*$/.test(rawSize)) || (profile.customAspect && /^[1-9]\d*:[1-9]\d*$/.test(rawSize)) ? rawSize
        : profile.sizeConstraints ? (flexibleRatioSizes[rawSize] || nearestImageSize(rawSize, profile.sizes)) : nearestImageSize(rawSize, profile.sizes);
    const rawQuality = String(config.quality || "").toLowerCase();
    const quality = profile.qualities.includes(rawQuality) ? rawQuality : profile.kind === "grok-image" ? "medium" : profile.kind === "gemini" ? "1k" : profile.qualities[0]!;
    const count = "1";
    return { size, quality, count };
}

/** Apply only to an editable draft after an explicit model selection, never a task snapshot. */
export function adaptImageModelSettings(config: Pick<AiConfig, "size" | "quality" | "count"> & { imageOptions?: string }, profile: ReturnType<typeof imageModelProfile>) {
    const settings = normalizeImageModelSettings(config, profile);
    if (imageModelSettingsError(settings.size, profile, config.imageOptions)) settings.size = imageOutputIsGif(config.imageOptions, profile) ? "auto" : nearestImageSize(settings.size, profile.sizes.filter(size => !imageModelSettingsError(size, profile)));
    return { ...settings, imageOptions: normalizeImageOptions(config.imageOptions, profile) };
}

export function imageReferenceSizeIsAutomatic(profile: Pick<ReturnType<typeof imageModelProfile>, "kind">, referenceCount: number) {
    return profile.kind === "mai-image" && referenceCount > 0;
}

export const automaticReferenceSizeNotice = "图生图尺寸由模型决定，约 100 万像素；尺寸与分辨率设置不参与本次请求。移除全部参考图后恢复文生图设置。";

/** Validation is separate from normalization so typing a custom size never mutates it. */
export function imageOutputIsGif(imageOptions: string | undefined, profile: Pick<ReturnType<typeof imageModelProfile>, "supportsGif">) {
    return profile.supportsGif && readImageOptions(imageOptions).output_format === "gif";
}

export const gifSizeNotice = "GIF 使用单帧像素尺寸，不使用比例或分辨率档位。自适应为 512 × 512；512 × 512 支持全部 2–16 帧，768 × 768 最多 12 帧。";

export function imageModelSettingsError(size: string, profile: ReturnType<typeof imageModelProfile>, imageOptions?: string) {
    if (imageOutputIsGif(imageOptions, profile)) {
        const options = readImageOptions(imageOptions);
        try { validateGpt26GifParameters({ size, frame_count: options.frame_count ? Number(options.frame_count) : undefined, frame_duration_ms: options.frame_duration_ms ? Number(options.frame_duration_ms) : undefined }); return ""; }
        catch (error) { return error instanceof Error ? error.message : "GIF 单帧尺寸或帧参数无效"; }
    }
    const constraints = profile.sizeConstraints;
    if (!constraints) return "";
    const raw = size.trim().toLowerCase();
    if (profile.kind === "mai-image" && /^[1-9]\d*:[1-9]\d*$/.test(raw)) {
        const [width, height] = raw.split(":").map(Number);
        return Math.max(width!, height!) / Math.min(width!, height!) <= 4 ? "" : "宽高比须在 1:4 至 4:1 范围内";
    }
    if ((profile.kind === "quality-resolution" || profile.kind === "mai-image") && profile.sizes.includes(raw)) return "";
    const value = flexibleRatioSizes[raw] || raw;
    if (value === "auto") return "";
    const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
    const width = Number(match?.[1]), height = Number(match?.[2]);
    if (!match || width % constraints.multiple || height % constraints.multiple || Math.min(width, height) < constraints.minEdge || Math.max(width, height) > constraints.maxEdge
        || Math.max(width, height) / Math.min(width, height) > constraints.maxAspectRatio || width * height < constraints.minPixels || width * height > constraints.maxPixels) return profile.sizeConstraintMessage;
    return "";
}
