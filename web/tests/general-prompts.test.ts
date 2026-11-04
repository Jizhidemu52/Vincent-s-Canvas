import { describe, expect, it } from "bun:test";
import { generalPromptDestination, generalPromptSnapshot, matchingGeneralPrompts, type GeneralPrompt } from "../src/pages/prompts/general-prompts";

const item: GeneralPrompt = {
    id: "catalog-test", title: "毛衫产品图", category: "服装", prompt: "保留 [针织肌理]，改为蓝色。\nA & B + C? #1",
    targetTool: "image-edit", notes: "先上传原图", tags: ["针织", "改色"], sources: [{ title: "公开指南", url: "https://example.com/guide" }],
};

describe("general prompt catalog handoff", () => {
    it("searches complete prompts, categories, notes and tags with trimmed terms", () => {
        expect(matchingGeneralPrompts([item], "  针织   蓝色  ")).toEqual([item]);
        expect(matchingGeneralPrompts([item], "服装")).toEqual([item]);
        expect(matchingGeneralPrompts([item], "上传")).toEqual([item]);
        expect(matchingGeneralPrompts([item], "a & b")).toEqual([item]);
        expect(matchingGeneralPrompts([item], "不存在")).toEqual([]);
        expect(matchingGeneralPrompts([item], " ")).toEqual([item]);
    });

    it("fills each existing destination with exactly the original prompt and no auto-run or model setting", () => {
        for (const targetTool of ["image-generation", "image-edit", "video"] as const) {
            const url = new URL(generalPromptDestination({ ...item, targetTool }), "http://localhost");
            expect(url.pathname).toBe(targetTool === "video" ? "/video" : "/image");
            expect(url.searchParams.get("prompt")).toBe(item.prompt);
            expect(url.searchParams.get("tool")).toBe(targetTool === "image-edit" ? "image-edit" : null);
            expect([...url.searchParams.keys()]).toEqual(targetTool === "image-edit" ? ["prompt", "tool"] : ["prompt"]);
        }
    });

    it("saves an independent personal snapshot without fabricated history or database identity", () => {
        const saved = generalPromptSnapshot(item);
        expect(saved).toMatchObject({ title: item.title, prompt: item.prompt, targetTool: item.targetTool, category: item.category, tags: item.tags, parameters: {}, referenceAssetIds: [] });
        expect(saved.notes).toContain(item.notes);
        expect(saved.notes).toContain(item.sources[0].url);
        for (const key of ["id", "scope", "sourceTaskId", "sourceAssetId", "modelConfigId", "useCount", "version"]) expect(saved).not.toHaveProperty(key);
        saved.tags.push("个人新增");
        expect(item.tags).toEqual(["针织", "改色"]);
    });
});
