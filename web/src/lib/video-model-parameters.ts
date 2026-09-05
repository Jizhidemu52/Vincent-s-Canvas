import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

export type VideoModelParameterKey = "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark";
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
    imageInputHint: string;
    ratioHint?: string;
    audioHint?: string;
};

const standardRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

// Verified against the APIMart endpoint documentation, with the implemented
// image-only adapter scope recorded in docs/manual/video-model-parameters.md.
// Contract tests also check that UI selections reach the provider unchanged.
const specifications: Record<string, VideoModelParameterSpec> = {
    "MiniMax-H3": {
        seconds: [4, 15], resolutions: ["768P", "2K"], sizes: ["21:9", ...standardRatios],
        supportsAudio: false, supportsWatermark: true, supportsAutoDuration: false,
        defaultResolution: "2K", defaultSize: "16:9",
        maxImages: 9, imageInputHint: "1 张图作为首帧；2–9 张作为参考图，不会自动当作首尾帧。",
        ratioHint: "单张首帧模式由原图决定比例；这里的比例仅用于文生或多图参考。",
        audioHint: "模型原生输出带音轨；渠道未提供关闭声音的参数。",
    },
    "doubao-seedance-2.5": {
        seconds: [4, 30], resolutions: ["480p", "720p", "1080p"], sizes: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
        supportsAudio: true, supportsWatermark: true, supportsAutoDuration: true,
        defaultResolution: "720p", defaultSize: "adaptive",
        maxImages: 30, imageInputHint: "最多 30 张图片，均作为参考图；当前未接入首尾帧或视频、音频引用。",
    },
    "wan2.7": {
        seconds: [2, 15], resolutions: ["720P", "1080P"], sizes: standardRatios,
        supportsAudio: false, supportsWatermark: true, supportsAutoDuration: false,
        defaultResolution: "1080P", defaultSize: "16:9",
        maxImages: 2, imageInputHint: "1 张为首帧；2 张按顺序作为首帧、尾帧。",
        ratioHint: "图生视频比例由输入图片决定；这里的比例仅用于文生视频。",
        audioHint: "渠道未提供生成声音开关；自定义音频输入尚未接入。",
    },
    "happyhorse-1.1": {
        seconds: [3, 15], resolutions: ["720P", "1080P"], sizes: standardRatios,
        supportsAudio: false, supportsWatermark: true, supportsAutoDuration: false,
        defaultResolution: "1080P", defaultSize: "16:9",
        maxImages: 9, imageInputHint: "支持 1 张首帧或 1–9 张参考图；未指定模式时单图作首帧、多图作参考。",
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
    if (model === "MiniMax-H3") return referenceCount === 1;
    if (model === "wan2.7") return referenceCount > 0;
    return model === "happyhorse-1.1" && referenceCount === 1 && imageMode !== "reference" && imageMode !== "text";
}

export function normalizeVideoModelConfig(config: VideoConfig): Pick<AiConfig, VideoModelParameterKey> {
    const current = { size: config.size, vquality: config.vquality, videoSeconds: config.videoSeconds, videoGenerateAudio: config.videoGenerateAudio, videoWatermark: config.videoWatermark };
    const spec = getVideoModelParameterSpec(config);
    if (!spec) return current;

    const seconds = Number(config.videoSeconds);
    const validSeconds = Number.isInteger(seconds) && ((seconds >= spec.seconds[0] && seconds <= spec.seconds[1]) || (spec.supportsAutoDuration && seconds === -1));
    const resolution = String(config.vquality || "").trim().replace(/^(\d+)$/, "$1P").toUpperCase();
    const size = config.size === "auto" ? "adaptive" : config.size;
    return {
        size: spec.sizes.includes(size) ? size : spec.defaultSize,
        vquality: spec.resolutions.find((option) => option.toUpperCase() === resolution) || spec.defaultResolution,
        videoSeconds: String(validSeconds ? seconds : 5),
        videoGenerateAudio: String(spec.supportsAudio && config.videoGenerateAudio !== "false"),
        videoWatermark: String(spec.supportsWatermark && config.videoWatermark === "true"),
    };
}

export function videoModelRequestParameters(config: VideoConfig): Record<string, unknown> {
    const spec = getVideoModelParameterSpec(config);
    if (!spec) throw new Error("当前视频模型尚未提供参数规格，请选择已配置的视频模型");
    const normalized = normalizeVideoModelConfig(config);
    return {
        seconds: Number(normalized.videoSeconds),
        size: normalized.size,
        resolution: normalized.vquality,
        ...(spec.supportsAudio ? { generateAudio: normalized.videoGenerateAudio === "true" } : {}),
        ...(spec.supportsWatermark ? { watermark: normalized.videoWatermark === "true" } : {}),
    };
}
