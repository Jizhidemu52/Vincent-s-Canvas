import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export type VideoMode = "auto" | "text" | "first-frame" | "last-frame" | "first-last-frame" | "reference" | "edit" | "extend";
export const videoModeLabels: Record<VideoMode, string> = { auto: "自动判断", text: "文生视频", "first-frame": "首帧", "last-frame": "尾帧", "first-last-frame": "首尾帧", reference: "多素材参考", edit: "视频编辑", extend: "视频延长 / 续写" };
export type VideoModelParameterKey = "size" | "vquality" | "videoSeconds" | "videoMode" | "videoGenerateAudio" | "videoWatermark";
type VideoConfig = Pick<AiConfig, "model" | "videoModel" | VideoModelParameterKey>;

export type VideoModelParameterSpec = {
    seconds: readonly [number, number];
    resolutions: readonly string[];
    sizes: readonly string[];
    /** Availability of an output-audio toggle, not native audio generation capability. */
    supportsAudio: boolean;
    supportsWatermark: boolean;
    supportsAutoDuration: boolean;
    defaultResolution: string;
    defaultSize: string;
    maxImages: number;
    modes: readonly VideoMode[];
    maxVideos: number;
    maxAudios: number;
    videoMaxMB: number;
    videoDuration: readonly [number, number];
    videoTotalSeconds: number;
    audioDuration: readonly [number, number];
    audioTotalSeconds: number;
    mediaHint?: string;
    imageInputHint: string;
    ratioHint?: string;
    audioHint?: string;
};

const standardRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

// Verified against the APIMart endpoint documentation, with the implemented
// advanced-media adapter scope recorded in docs/manual/video-model-parameters.md.
// Contract tests also check that UI selections reach the provider unchanged.
const specifications: Record<string, VideoModelParameterSpec> = {
    "MiniMax-H3": {
        seconds: [4, 15], resolutions: ["768P", "2K"], sizes: ["21:9", ...standardRatios],
        supportsAudio: false, supportsWatermark: true, supportsAutoDuration: false,
        defaultResolution: "2K", defaultSize: "16:9",
        modes: ["auto", "text", "first-frame", "last-frame", "first-last-frame", "reference"],
        maxVideos: 3, maxAudios: 3, videoMaxMB: 50, videoDuration: [2, 15], videoTotalSeconds: 15, audioDuration: [2, 15], audioTotalSeconds: 15,
        maxImages: 9, imageInputHint: "自动模式：单图作首帧，2–9 张作为参考图。首尾帧按图片顺序排列，不能混用视频/音频参考。",
        mediaHint: "最多 3 段视频（单个 ≤50MB）及 3 段音频（单个 ≤15MB），每段 2–15 秒，各类合计 ≤15 秒。音频须搭配参考图或视频。",
        ratioHint: "单张首帧模式由原图决定比例；这里的比例仅用于文生或多图参考。",
        audioHint: "模型原生输出带音轨；渠道未提供关闭声音的参数。",
    },
    "doubao-seedance-2.5": {
        seconds: [4, 30], resolutions: ["480p", "720p", "1080p"], sizes: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
        supportsAudio: true, supportsWatermark: true, supportsAutoDuration: true,
        defaultResolution: "720p", defaultSize: "adaptive",
        modes: ["auto", "text", "first-frame", "first-last-frame", "reference", "edit", "extend"],
        maxVideos: 10, maxAudios: 10, videoMaxMB: 200, videoDuration: [2, 30], videoTotalSeconds: 30, audioDuration: [2, 30], audioTotalSeconds: 30,
        maxImages: 30, imageInputHint: "最多 30 张参考图；首尾帧模式按图片顺序排列，使用自适应比例，不混用视频/音频。",
        mediaHint: "最多 10 段视频（单个 ≤200MB）及 10 段音频（单个 ≤15MB），每段 2–30 秒，各类合计 ≤30 秒。支持纯音频参考。真人素材需先完成渠道素材库审核。",
    },
    "wan2.7": {
        seconds: [2, 15], resolutions: ["720P", "1080P"], sizes: standardRatios,
        supportsAudio: false, supportsWatermark: true, supportsAutoDuration: false,
        defaultResolution: "1080P", defaultSize: "16:9",
        modes: ["auto", "text", "first-frame", "first-last-frame", "extend"],
        maxVideos: 1, maxAudios: 1, videoMaxMB: 100, videoDuration: [2, 10], videoTotalSeconds: 10, audioDuration: [2, 30], audioTotalSeconds: 30,
        maxImages: 2, imageInputHint: "1 张为首帧；2 张按顺序作为首帧、尾帧。续写时可额外提供 1 张尾帧。",
        mediaHint: "续写需 1 段 2–10 秒视频（≤100MB），不能配音频；文生/图生可配 1 段 2–30 秒音频（≤15MB）。",
        ratioHint: "图生视频比例由输入图片决定；这里的比例仅用于文生视频。",
        audioHint: "渠道未提供生成声音开关；可使用自定义音频输入。",
    },
    "happyhorse-1.1": {
        seconds: [3, 15], resolutions: ["720P", "1080P"], sizes: standardRatios,
        supportsAudio: false, supportsWatermark: true, supportsAutoDuration: false,
        defaultResolution: "1080P", defaultSize: "16:9",
        modes: ["auto", "text", "first-frame", "reference"],
        maxVideos: 0, maxAudios: 0, videoMaxMB: 0, videoDuration: [0, 0], videoTotalSeconds: 0, audioDuration: [0, 0], audioTotalSeconds: 0,
        maxImages: 9, imageInputHint: "支持 1 张首帧或 1–9 张参考图；自动模式单图作首帧、多图作参考。不支持视频/音频输入或编辑。",
        ratioHint: "首帧模式由原图决定比例；这里的比例仅用于文生或参考图模式。",
        audioHint: "渠道文档未提供音频参数，不显示生成声音开关。",
    },
};

export function getVideoModelParameterSpec(config: Pick<AiConfig, "model" | "videoModel"> | string): VideoModelParameterSpec | undefined {
    const model = modelOptionName(typeof config === "string" ? config : config.model || config.videoModel);
    return specifications[model];
}

export function videoAspectRatioFollowsImage(config: Pick<AiConfig, "model" | "videoModel"> | string, referenceCount = 0, imageMode?: string) {
    const model = modelOptionName(typeof config === "string" ? config : config.model || config.videoModel);
    if (model === "MiniMax-H3") return imageMode === "reference" || imageMode === "text" ? false : imageMode && imageMode !== "auto" ? imageMode.includes("frame") : referenceCount === 1;
    if (model === "wan2.7") return referenceCount > 0 || imageMode === "extend";
    return model === "happyhorse-1.1" && referenceCount === 1 && imageMode !== "reference" && imageMode !== "text";
}

export function normalizeVideoModelConfig(config: VideoConfig): Pick<AiConfig, VideoModelParameterKey> {
    const current = { size: config.size, vquality: config.vquality, videoSeconds: config.videoSeconds, videoMode: config.videoMode || "auto", videoGenerateAudio: config.videoGenerateAudio, videoWatermark: config.videoWatermark };
    const spec = getVideoModelParameterSpec(config);
    if (!spec) return current;

    const seconds = Number(config.videoSeconds);
    const validSeconds = Number.isInteger(seconds) && ((seconds >= spec.seconds[0] && seconds <= spec.seconds[1]) || (spec.supportsAutoDuration && seconds === -1));
    const resolution = String(config.vquality || "").trim().replace(/^(\d+)$/, "$1P").toUpperCase();
    const size = config.size === "auto" ? "adaptive" : config.size;
    const videoMode = spec.modes.includes(config.videoMode as VideoMode) ? config.videoMode : "auto";
    const lockRatio = videoModeLocksRatio({ ...config, videoMode });
    const edit = modelOptionName(config.model || config.videoModel) === "doubao-seedance-2.5" && videoMode === "edit";
    return {
        videoMode,
        size: lockRatio ? "adaptive" : spec.sizes.includes(size) ? size : spec.defaultSize,
        vquality: spec.resolutions.find((option) => option.toUpperCase() === resolution) || spec.defaultResolution,
        videoSeconds: edit ? "-1" : String(validSeconds ? seconds : 5),
        videoGenerateAudio: String(spec.supportsAudio && config.videoGenerateAudio !== "false"),
        videoWatermark: String(spec.supportsWatermark && config.videoWatermark === "true"),
    };
}

export function videoModelRequestParameters(config: VideoConfig): Record<string, unknown> {
    const spec = getVideoModelParameterSpec(config);
    if (!spec) throw new Error("当前视频模型尚未提供参数规格，请选择已配置的视频模型");
    const normalized = normalizeVideoModelConfig(config);
    return {
        videoMode: normalized.videoMode,
        seconds: Number(normalized.videoSeconds),
        size: normalized.size,
        resolution: normalized.vquality,
        ...(spec.supportsAudio ? { generateAudio: normalized.videoGenerateAudio === "true" } : {}),
        ...(spec.supportsWatermark ? { watermark: normalized.videoWatermark === "true" } : {}),
    };
}

export function videoModeLocksRatio(config: Pick<AiConfig, "model" | "videoModel" | "videoMode">) {
    return modelOptionName(config.model || config.videoModel) === "doubao-seedance-2.5" && ["first-frame", "last-frame", "first-last-frame", "edit", "extend"].includes(config.videoMode);
}

export function resolveVideoMode(config: Pick<AiConfig, "model" | "videoModel" | "videoMode">, images = 0, videos = 0, audios = 0, legacyMode?: string): VideoMode {
    const model = modelOptionName(config.model || config.videoModel);
    const requested = config.videoMode || legacyMode || "auto";
    if (requested !== "auto") return requested as VideoMode;
    if (model === "wan2.7") return videos ? "extend" : images > 1 ? "first-last-frame" : images ? "first-frame" : "text";
    if (model === "doubao-seedance-2.5") return images || videos || audios ? "reference" : "text";
    return videos || audios || images > 1 ? "reference" : images ? "first-frame" : "text";
}

/** Pure validation runs before local/remote uploads. Unknown metadata is left to server probing. */
export function videoReferenceError(config: Pick<AiConfig, "model" | "videoModel" | "videoMode"> & Partial<Pick<AiConfig, "videoSeconds">>, images: ReferenceImage[] = [], videos: ReferenceVideo[] = [], audios: ReferenceAudio[] = [], legacyMode?: string, allowIncomplete = false): string {
    const spec = getVideoModelParameterSpec(config);
    if (!spec) return "当前视频模型尚未提供参数规格";
    const model = modelOptionName(config.model || config.videoModel);
    const requested = config.videoMode || legacyMode || "auto";
    if (!spec.modes.includes(requested as VideoMode)) return `当前模型不支持${videoModeLabels[requested as VideoMode] || requested}模式`;
    const mode = resolveVideoMode(config, images.length, videos.length, audios.length, legacyMode);
    if (images.length > spec.maxImages) return `当前视频模型最多支持 ${spec.maxImages} 张参考图`;
    if (videos.length > spec.maxVideos) return spec.maxVideos ? `当前视频模型最多支持 ${spec.maxVideos} 段视频` : "当前视频模型不支持视频参考";
    if (audios.length > spec.maxAudios) return spec.maxAudios ? `当前视频模型最多支持 ${spec.maxAudios} 段音频` : "当前视频模型不支持音频参考";
    if (mode === "text" && (images.length || videos.length || (model !== "wan2.7" && audios.length))) return "文生视频模式不接收这些参考素材，请移除素材或切换模式";
    if (mode.includes("frame")) {
        const count = mode === "first-last-frame" ? 2 : 1;
        if (allowIncomplete ? images.length > count : images.length !== count) return `${videoModeLabels[mode]}模式需要恰好 ${count} 张图片`;
        if (videos.length || (audios.length && model !== "wan2.7")) return "首尾帧与视频/音频参考不可混用，请切换多素材参考模式";
    }
    if ((mode === "edit" || mode === "extend") && !videos.length && !allowIncomplete) return "视频编辑或延长模式至少需要 1 段源视频";
    if (mode === "reference" && !images.length && !videos.length && !audios.length && !allowIncomplete) return "参考模式需要至少 1 个参考素材";
    if (model === "MiniMax-H3" && audios.length && !images.length && !videos.length && !allowIncomplete) return "MiniMax 音频参考必须搭配参考图或视频";
    if (model === "wan2.7" && mode === "extend" && (images.length > 1 || audios.length)) return "Wan 续写仅支持 1 段视频及可选 1 张尾帧，不能使用音频或首帧";
    const requestedSeconds = Number(config.videoSeconds);
    const outputSeconds = Number.isInteger(requestedSeconds) && requestedSeconds >= spec.seconds[0] && requestedSeconds <= spec.seconds[1] ? requestedSeconds : 5;
    if (model === "wan2.7" && mode === "extend" && videos.some((video) => video.durationMs !== undefined && video.durationMs >= outputSeconds * 1000)) return "Wan 续写的输出总时长必须大于源视频时长，请增加生成时长";
    const sizeBounds = model === "doubao-seedance-2.5" ? [300, 6000, 0.4, 2.5] : model === "MiniMax-H3" ? [256, 5760, 0.4, 2.5] : [240, 4096, 0.125, 8];
    for (const [index, image] of images.entries()) {
        if (image.type && !["image/jpeg", "image/png", "image/webp"].includes(image.type)) return `图片${index + 1} 仅支持 JPEG/PNG/WebP`;
        if (image.bytes !== undefined && (image.bytes <= 0 || image.bytes > 10 * 1024 * 1024)) return `图片${index + 1} 需为非空文件且不超过当前上传入口的 10MB 限制`;
        if (["MiniMax-H3", "doubao-seedance-2.5"].includes(model) && image.width && image.height && !validDimensions(image.width, image.height, sizeBounds)) return `图片${index + 1} 的宽高或比例不符合模型要求（边长 ${sizeBounds[0]}–${sizeBounds[1]}px，比例 ${sizeBounds[2]}–${sizeBounds[3]}）`;
        if (model === "happyhorse-1.1" && mode === "first-frame" && image.width && image.height && (Math.min(image.width, image.height) < 300 || image.width / image.height < 0.4 || image.width / image.height > 2.5)) return "HappyHorse 首帧短边至少 300px，宽高比需在 0.4–2.5 之间";
    }
    for (const [kind, items, maxMB, duration, total] of [["视频", videos, spec.videoMaxMB, spec.videoDuration, spec.videoTotalSeconds], ["音频", audios, 15, spec.audioDuration, spec.audioTotalSeconds]] as const) {
        let sum = 0;
        for (const [index, item] of items.entries()) {
            const label = `${kind}${index + 1}`;
            const formats = kind === "视频" ? ["video/mp4", "video/quicktime"] : ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"];
            if (item.type && !formats.includes(item.type)) return `${label} 格式不支持，请使用${kind === "视频" ? " MP4/MOV" : " WAV/MP3"}`;
            if (item.bytes !== undefined && (item.bytes <= 0 || item.bytes > maxMB * 1024 * 1024)) return `${label} 需为非空文件且不超过 ${maxMB}MB`;
            if (item.durationMs !== undefined) {
                const min = kind === "视频" && mode === "edit" ? 4 : duration[0];
                if (!Number.isFinite(item.durationMs) || item.durationMs < min * 1000 || item.durationMs > duration[1] * 1000) return `${label} 时长需要在 ${min}–${duration[1]} 秒之间`;
                sum += item.durationMs;
            }
            if (kind === "视频") {
                const video = item as ReferenceVideo;
                if (video.width && video.height) {
                    if (!validDimensions(video.width, video.height, sizeBounds)) return `${label} 宽高或比例不符合模型要求（边长 ${sizeBounds[0]}–${sizeBounds[1]}px，比例 ${sizeBounds[2]}–${sizeBounds[3]}）`;
                    if (model === "doubao-seedance-2.5" && (video.width * video.height < 409600 || video.width * video.height > 8295044)) return `${label} 像素总量需在 409600–8295044 之间`;
                }
                const minFps = model === "MiniMax-H3" ? 23.976 : 24;
                if (model !== "wan2.7" && video.fps !== undefined && (video.fps < minFps || video.fps > 60)) return `${label} 帧率需在 ${minFps}–60 FPS 之间`;
            }
        }
        if (sum > total * 1000) return `参考${kind}总时长不能超过 ${total} 秒`;
    }
    return "";
}

function validDimensions(width: number, height: number, [min, max, minRatio, maxRatio]: number[]) {
    return width >= min && width <= max && height >= min && height <= max && width / height >= minRatio && width / height <= maxRatio;
}
