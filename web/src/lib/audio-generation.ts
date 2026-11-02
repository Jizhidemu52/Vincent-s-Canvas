export const audioVoiceOptions = [
    { value: "alloy", label: "Alloy", chineseLabel: "合金" },
    { value: "ash", label: "Ash", chineseLabel: "白蜡" },
    { value: "ballad", label: "Ballad", chineseLabel: "歌谣" },
    { value: "coral", label: "Coral", chineseLabel: "珊瑚" },
    { value: "echo", label: "Echo", chineseLabel: "回声" },
    { value: "fable", label: "Fable", chineseLabel: "寓言" },
    { value: "nova", label: "Nova", chineseLabel: "新星" },
    { value: "onyx", label: "Onyx", chineseLabel: "黑曜" },
    { value: "sage", label: "Sage", chineseLabel: "鼠尾草" },
    { value: "shimmer", label: "Shimmer", chineseLabel: "微光" },
    { value: "verse", label: "Verse", chineseLabel: "诗韵" },
    { value: "marin", label: "Marin", chineseLabel: "马林" },
    { value: "cedar", label: "Cedar", chineseLabel: "雪松" },
];

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
];

// Public samples documented by OpenAI, not recordings from this project's
// configured provider. Only verified sample files are offered; no voice aliases.
const sampledVoices = new Set(["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]);
export function audioVoiceSampleUrl(voice: string): string | undefined {
    return sampledVoices.has(voice) ? `https://cdn.openai.com/API/docs/audio/${voice}.wav` : undefined;
}

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string) {
    const voice = normalizeAudioVoiceValue(value);
    const option = audioVoiceOptions.find((item) => item.value === voice);
    return option ? `${option.chineseLabel} ${option.label}` : voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
