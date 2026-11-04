import type { generalPromptTemplates } from "../../../../shared/general-prompt-templates";
import type { PromptSnapshotInput } from "@/services/api/prompts";

export type GeneralPrompt = (typeof generalPromptTemplates)[number];

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
    return {
        title: item.title, prompt: item.prompt, targetTool: item.targetTool,
        category: item.category, tags: [...item.tags], parameters: {}, referenceAssetIds: [],
        notes: `${item.notes}\n\n参考来源：\n${item.sources.map(source => `${source.title}：${source.url}`).join("\n")}`,
    };
}
