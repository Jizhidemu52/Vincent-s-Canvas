import type { PromptInputData } from "../../../../shared/prompt-contracts";
import { normalizeVideoMotionSettings, type VideoMotionSettings } from "../../../../shared/video-motion-options";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, resolveVideoMode, videoParameterModelId } from "@/lib/video-model-parameters";
import type { AiConfig } from "@/stores/use-config-store";

/** Only the standalone motion page uses frame defaults; saved explicit modes remain intact. */
export function motionVideoConfig(config: AiConfig, settings: VideoMotionSettings, counts: { images: number; videos: number; audios: number }, planning: boolean): AiConfig {
    const next = { ...config };
    if (planning) {
        if (videoParameterModelId(next) === "doubao-seedance-2.5" && (!next.videoMode || next.videoMode === "auto") && !counts.videos && !counts.audios) {
            next.videoMode = counts.images === 1 ? "first-frame" : counts.images === 2 ? "first-last-frame" : counts.images ? "reference" : "text";
        }
        if (getVideoModelParameterSpec(next)?.supportsAudio) next.videoGenerateAudio = settings.audio === "none" ? "false" : "true";
    }
    return { ...next, ...normalizeVideoModelConfig(next) };
}

export function createVideoMotionInput(userText: string, settings: VideoMotionSettings, config: AiConfig, counts: { images: number; videos: number; audios: number }): PromptInputData {
    const mode = resolveVideoMode(config, counts.images, counts.videos, counts.audios);
    return {
        scene: "video-motion", mode: "video", outputLanguage: "zh", userText,
        fields: { ...normalizeVideoMotionSettings(settings), duration: Number(config.videoSeconds), ratio: config.size, resolution: config.vquality, video_mode: mode, generate_audio: config.videoGenerateAudio === "true" },
        referenceRoles: Array.from({ length: counts.images }, (_, index) => mode === "first-frame" ? "首帧" : mode === "first-last-frame" ? index === 0 ? "首帧" : "尾帧" : `参考图片${index + 1}`),
    };
}

export function videoMotionSummary(task: { summaryZh?: string; parameters?: Record<string, unknown> }): string | undefined {
    if (typeof task.summaryZh === "string") return task.summaryZh;
    const optimization = task.parameters?.promptOptimization;
    return optimization && typeof optimization === "object" && "summaryZh" in optimization && typeof optimization.summaryZh === "string" ? optimization.summaryZh : undefined;
}
