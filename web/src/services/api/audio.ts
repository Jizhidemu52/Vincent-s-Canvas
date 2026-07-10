import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { requestQueuedMedia } from "@/services/api/generation-tasks";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal };

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const format = normalizeAudioFormatValue(config.audioFormat);
    const [url] = await requestQueuedMedia({
        modelId: modelOptionName(config.model || config.audioModel),
        prompt,
        operationType: "audio_generation",
        parameters: {
            voice: normalizeAudioVoiceValue(config.audioVoice),
            responseFormat: format,
            speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
            instructions: config.audioInstructions.trim(),
        },
        signal: options?.signal,
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
