import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

export type HappyHorseMode = "text" | "first-frame" | "reference" | "edit";

export const happyHorseModes: Array<{ value: HappyHorseMode; label: string; description: string }> = [
    { value: "text", label: "文生视频", description: "仅使用提示词生成视频" },
    { value: "first-frame", label: "首帧图生视频", description: "上传一张首帧图片，作为视频开场画面" },
    { value: "reference", label: "参考图生视频", description: "上传 1-9 张参考图，生成连续画面" },
    { value: "edit", label: "视频编辑", description: "上传一段源视频，可补充风格参考图" },
];

export const happyHorseRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

export function isHappyHorseVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return modelOptionName(requestConfig.model || requestConfig.videoModel).toLowerCase() === "happyhorse-1.0";
}

export function normalizeHappyHorseRatio(value: string) {
    if (happyHorseRatios.includes(value as (typeof happyHorseRatios)[number])) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "16:9";
    const ratio = Number(match[1]) / Number(match[2]);
    return happyHorseRatios.reduce((best, current) => Math.abs(toRatio(current) - ratio) < Math.abs(toRatio(best) - ratio) ? current : best, "16:9");
}

export function normalizeHappyHorseResolution(value: string) {
    return String(value).replace(/p$/i, "").toUpperCase() === "720" ? "720P" : "1080P";
}

export function normalizeHappyHorseDuration(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return String(Math.max(3, Math.min(15, seconds)));
}

function toRatio(value: (typeof happyHorseRatios)[number]) {
    const [width, height] = value.split(":").map(Number);
    return width / height;
}
