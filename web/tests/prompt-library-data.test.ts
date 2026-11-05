import { expect, test } from "bun:test";
import { generalPromptTemplates } from "../../shared/general-prompt-templates";
import { generalPromptOptions } from "../src/components/prompts/prompt-library-data";

test("module picker reuses every unchanged general prompt as text, never a server template ID", () => {
    const items = generalPromptOptions("", [], "全部");
    expect(items).toHaveLength(generalPromptTemplates.length);
    for (const [index, item] of items.entries()) {
        expect(item).toMatchObject({ id: `general:${generalPromptTemplates[index].id}`, prompt: generalPromptTemplates[index].prompt, templateId: null, scope: "general", modelId: "" });
    }
});

test("general picker searches full prompt words, category and tag without modifying originals", () => {
    const before = JSON.stringify(generalPromptTemplates);
    const first = generalPromptTemplates[0];
    expect(generalPromptOptions(first.title, [], "全部").map(item => item.id)).toContain(`general:${first.id}`);
    expect(generalPromptOptions("", [first.tags[0]], first.category).every(item => item.tags.includes(first.tags[0]) && item.category === first.category)).toBe(true);
    expect(generalPromptOptions("不存在的完全不匹配文本", [], "全部")).toEqual([]);
    const result = generalPromptOptions("", [], "全部"); result[0].tags.push("local-only");
    expect(JSON.stringify(generalPromptTemplates)).toBe(before);
});
