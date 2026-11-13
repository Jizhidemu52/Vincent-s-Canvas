import { getLocalizedGeneralPrompts } from "@/pages/prompts/general-prompts";
import { ALL_PROMPTS_OPTION, type Prompt, type PromptLibraryScope } from "@/services/api/prompts";

export const promptLibrarySourceLabels: Record<PromptLibraryScope, string> = {
    all: "全部提示词", general: "通用提示词", personal: "我的提示词", team: "团队提示词", public: "公共提示词",
};

/** Built-ins are text, not database templates: their IDs must never be resolved. */
export function generalPromptOptions(keyword: string, tags: readonly string[], category: string): Prompt[] {
    const words = keyword.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return getLocalizedGeneralPrompts().filter(item => {
        const text = [item.title, item.prompt, item.notes, item.category, ...item.tags].join("\n").toLocaleLowerCase();
        return words.every(word => text.includes(word))
            && (!category || category === ALL_PROMPTS_OPTION || item.category === category)
            && (!tags[0] || item.tags.includes(tags[0]));
    }).map(item => ({
        id: `general:${item.id}`, scope: "general", templateId: null,
        title: item.title, prompt: item.prompt, tags: [...item.tags], category: item.category,
        preview: item.notes, coverUrl: "", createdAt: "", updatedAt: "", targetTool: item.targetTool, modelId: "",
    }));
}
