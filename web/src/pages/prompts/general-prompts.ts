import { generalPromptTemplates } from "../../../../shared/general-prompt-templates";
import { getUiLocale, uiText } from "@/lib/i18n";
import type { PromptSnapshotInput } from "@/services/api/prompts";

export type GeneralPrompt = (typeof generalPromptTemplates)[number];

/** Only built-in templates have authored English variants. Original/user data
 * is never rewritten; callers use this same variant for display and reuse. */
export function getLocalizedGeneralPrompts(): readonly GeneralPrompt[] {
    if (getUiLocale() === "zh-CN") return generalPromptTemplates;
    return generalPromptTemplates.map(item => ({
        ...item,
        title: uiText(item.title), category: uiText(item.category),
        prompt: uiText(item.prompt), notes: uiText(item.notes),
        tags: item.tags.map(tag => uiText(tag)),
        sources: item.sources.map(source => ({ ...source, title: uiText(source.title) })),
    }));
}

export function matchingGeneralPrompts(items: readonly GeneralPrompt[], query: string) {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => {
        const text = [item.title, item.prompt, item.category, item.notes, ...item.tags].join("\n").toLocaleLowerCase();
        return words.every(word => text.includes(word));
    });
}

/** Reuse the existing prompt-only URL handoff; no model, references or auto-run flag. */
export function generalPromptDestination(item: Pick<GeneralPrompt, "prompt" | "targetTool">) {
    const params = new URLSearchParams({ prompt: item.prompt });
    if (item.targetTool === "video") return `/video?${params}`;
    if (item.targetTool === "image-edit") params.set("tool", "image-edit");
    return `/image?${params}`;
}

export function generalPromptSnapshot(item: GeneralPrompt): PromptSnapshotInput {
    const separator = getUiLocale() === "en-US" ? ": " : "：";
    return {
        title: item.title, prompt: item.prompt, targetTool: item.targetTool,
        category: item.category, tags: [...item.tags], parameters: {}, referenceAssetIds: [],
        notes: `${item.notes}\n\n${uiText("参考来源")}${separator.trimEnd()}\n${item.sources.map(source => `${source.title}${separator}${source.url}`).join("\n")}`,
    };
}
