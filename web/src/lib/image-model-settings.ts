import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { PublicModel } from "@/services/api/business-config";

export type ImageParameterProfile = "standard" | "gpt" | "gemini" | "midjourney" | "midjourney-blend" | "unverified";
const gptRatios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"];
const geminiRatios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9", "1:4", "4:1", "1:8", "8:1", "auto"];

/** Capabilities describe our configured provider adapter, not a model's marketing name. */
export function imageModelProfile(model: string, models: readonly PublicModel[] = useBusinessConfigStore.getState().models) {
    const id = modelOptionName(model).toLowerCase();
    const configured = models.find(item => [item.id, item.modelId, item.name].some(value => value.toLowerCase() === id));
    const actual = (configured?.modelId || id).toLowerCase();
    const kind: ImageParameterProfile = configured?.imageParameterProfile
        || (actual.includes("midjourney-blend") ? "midjourney-blend" : actual.includes("midjourney") ? "midjourney"
            : actual.includes("vcen-gpt2") || actual.includes("gpt-image-2-extend") ? "gpt"
                : actual.includes("gemini-3.1-flash-image-preview") || actual.includes("nano-banana-2") ? "gemini" : actual === "gemini-3.1-flash-image" ? "unverified" : "standard");
    const midjourney = kind === "midjourney" || kind === "midjourney-blend";
    const verified = kind !== "unverified";
    return {
        // maxCount is the application's batch limit. Every upstream request has n=1.
        kind, verified, maxCount: midjourney ? 1 : 10, customSize: kind === "gpt", upstreamCount: 1,
        requiresPrompt: kind !== "midjourney-blend",
        sizes: !verified ? ["auto"] : kind === "standard" ? ["1024x1024", "1536x1024", "1024x1536", "auto"] : kind === "gemini" ? geminiRatios : kind === "gpt" ? [...gptRatios, "auto"] : [...gptRatios, "1:4", "4:1", "1:8", "8:1"],
        qualities: !verified ? ["auto"] : midjourney ? ["relax", "fast", "turbo"] : kind === "standard" ? ["auto", "high", "medium", "low"] : kind === "gemini" ? ["0.5k", "1k", "2k", "4k"] : ["1k", "2k", "4k"],
        qualityLabel: midjourney ? "生成速度" : kind === "standard" ? "画质" : "分辨率",
        tip: !verified ? "当前渠道的此模型参数文档待确认，暂用渠道默认设置，不额外传入尺寸或画质。"
            : kind === "midjourney-blend" ? "合成 2–4 张参考图，不使用提示词，每次提交一个任务。"
            : kind === "midjourney" ? "支持描述和参考图引导；可在描述中使用原生 MJ 参数，每次提交一个任务。"
                : kind === "standard" ? "支持三种固定尺寸及自适应；自适应由模型结合描述和参考图决定输出尺寸。画质不等于分辨率。"
                    : kind === "gemini" ? "支持 0.5K / 1K / 2K / 4K，最多 14 张参考图。批量张数会拆成多个单图任务。" : "支持 1K / 2K / 4K、15 种比例及像素尺寸，最多 15 张参考图。批量张数会拆成多个单图任务。",
        documentationUrl: !verified ? "" : kind === "gpt" ? "https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation" : kind === "gemini" ? "https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation" : midjourney ? `https://docs.apimart.ai/en/api-reference/images/midjourney/${kind === "midjourney-blend" ? "blend" : "imagine"}` : "https://docs.opentoken.io/api/openai/image-generation/",
    };
}

export function useImageModelProfile(model: string) {
    return imageModelProfile(model, useBusinessConfigStore(state => state.models));
}

export function normalizeImageModelSettings(config: Pick<AiConfig, "size" | "quality" | "count">, profile: ReturnType<typeof imageModelProfile>) {
    const rawSize = String(config.size || "").trim().toLowerCase();
    const size = profile.sizes.includes(rawSize) || (profile.customSize && /^[1-9]\d*x[1-9]\d*$/.test(rawSize)) ? rawSize
        : profile.kind === "standard" ? ({ "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" }[rawSize] || profile.sizes[0]!) : profile.sizes[0]!;
    const rawQuality = String(config.quality || "").toLowerCase();
    const quality = profile.qualities.includes(rawQuality) ? rawQuality : profile.kind === "gemini" ? "1k" : profile.qualities[0]!;
    const count = String(Math.max(1, Math.min(profile.maxCount, Math.floor(Number(config.count)) || 1)));
    return { size, quality, count };
}
