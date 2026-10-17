import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { requestQueuedMedia, type QueuedMediaInput } from "@/services/api/generation-tasks";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { resolveToolConfig } from "./tool-runtime";

type RequestOptions = Pick<QueuedMediaInput, "signal" | "onSubmissionStarted" | "onSubmitted">;

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const resolved = await resolveToolConfig(config, "audio_generation", "canvas-audio");
    config = resolved.config;
    const format = normalizeAudioFormatValue(config.audioFormat);
    const [url] = await requestQueuedMedia({
        resolvedModel: resolved.model,
        modelId: modelOptionName(config.model || config.audioModel),
        prompt,
        operationType: "audio_generation",
        toolKey: "canvas-audio",
        parameters: {
            voice: normalizeAudioVoiceValue(config.audioVoice),
            responseFormat: format,
            speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
            instructions: config.audioInstructions.trim(),
        },
        signal: options?.signal,
        onSubmissionStarted: options?.onSubmissionStarted,
        onSubmitted: options?.onSubmitted,
    });
    if (!url) throw new Error("音频任务没有返回结果");
    const response = await fetch(url, { credentials: "include", signal: options?.signal });
    if (!response.ok) throw new Error(`音频结果读取失败（${response.status}）`);
    const blob = await response.blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}
