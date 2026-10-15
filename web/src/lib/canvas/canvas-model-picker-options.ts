import type { imageModelProfile } from "@/lib/image-model-settings";

export type CanvasModelOption = {
    value: string;
    name: string;
    description?: string;
    channel?: string;
    family: string;
    icon?: string;
    details: string[];
    usageModelId?: string;
    isFeatured?: boolean;
    displayOrder?: number | null;
};

/** Only inspect the already-published label, never a hidden provider/model identifier. */
export function canvasModelPresentation(label: string) {
    const channel = /^(?:aplmart|apimart)[-\s]+/i.test(label) ? "APIMart" : undefined;
    const visibleName = label.replace(/^(?:aplmart|apimart)[-\s]+/i, "").trim();
    const names: Record<string, string> = {
        "gpt2": "GPT Image 2", "gpt-image-2": "GPT Image 2",
        "gpt2.5-flare": "GPT Image 2.5 Flare", "gpt-image-2.5-flare": "GPT Image 2.5 Flare",
        "gpt2.5-sunburst": "GPT Image 2.5 Sunburst", "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
        "nano2.1": "Nano Banana 2.1", "nano2": "Nano Banana 2",
        "gpt6-astra": "GPT-6 Astra", "gpt-6-astra": "GPT-6 Astra",
        "happyhorse1.1": "HappyHorse 1.1", "mj-blend": "Midjourney Blend", "grok2": "Grok Image 2",
    };
    const name = names[visibleName.toLowerCase()] || visibleName;
    const families: Array<[RegExp, string, string?]> = [
        [/claude|anthropic/i, "Anthropic", "/icons/claude.svg"],
        [/gemini|google|nano[ -]?banana/i, "Google", "/icons/gemini.svg"],
        [/gpt|openai/i, "OpenAI", "/icons/openai.svg"],
        [/grok|\bxai\b/i, "xAI", "/icons/grok.svg"],
        [/deepseek/i, "DeepSeek", "/icons/deepseek.svg"],
        [/\bglm\b|智谱/i, "智谱", "/icons/glm.svg"],
        [/midjourney|\bmj\b/i, "Midjourney"],
        [/happyhorse/i, "HappyHorse"],
    ];
    const match = families.find(([pattern]) => pattern.test(name));
    return { name, channel, family: match?.[1] || "其他模型", icon: match?.[2] };
}

export function canvasImageModelDetails(profile: ReturnType<typeof imageModelProfile>, references: { minimum: number; maximum: number; supportsReferences: boolean }) {
    if (!profile.verified) return ["渠道默认参数"];
    const details: string[] = [];
    const resolutions = profile.resolutions.length ? profile.resolutions : profile.qualities.filter(value => /^\d+(?:\.\d+)?k$/i.test(value));
    if (resolutions.length) details.push(resolutions.map(value => value.toUpperCase()).join(" / "));
    if (references.supportsReferences) {
        const count = references.minimum > 0 ? `${references.minimum}–${references.maximum}` : `最多 ${references.maximum}`;
        details.push(`${count} 张参考图${profile.kind === "resolution-1k" ? "（工作台上限）" : ""}`);
    }
    if (!profile.requiresPrompt) details.push("无需提示词");
    return details;
}

/** Featured membership and order are server-owned; selection never changes their ranking. */
export function commonCanvasModels(options: readonly CanvasModelOption[]) {
    const order = (option: CanvasModelOption) => typeof option.displayOrder === "number" && Number.isFinite(option.displayOrder) ? option.displayOrder : Number.MAX_SAFE_INTEGER;
    return options.filter(option => option.isFeatured === true).sort((left, right) => order(left) - order(right)).slice(0, 5);
}

export function canvasModelGroups(options: readonly CanvasModelOption[]) {
    const groups = new Map<string, CanvasModelOption[]>();
    for (const option of options) groups.set(option.family, [...(groups.get(option.family) || []), option]);
    return [...groups].map(([name, models]) => ({ name, models }));
}
