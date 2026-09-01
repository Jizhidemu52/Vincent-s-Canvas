import { expect, test } from "bun:test";

import { canvasNodePromptDraft, canvasNodePromptDraftPatch } from "../src/lib/canvas/canvas-node-prompt-draft";

test("keeps an image-edit prompt as node draft after its panel unmounts", () => {
    const node = {
        metadata: {
            content: "data:image/png;base64,existing-image",
            prompt: "生成这条红裙子的原始提示词",
            draftPrompt: "让模特穿着它走在西湖边",
        },
    };

    expect(canvasNodePromptDraft(node)).toBe("让模特穿着它走在西湖边");
    expect(canvasNodePromptDraftPatch("保留服装不变，模特自然行走")).toEqual({ draftPrompt: "保留服装不变，模特自然行走" });
});

test("starts image editing with a blank draft instead of the original generation prompt", () => {
    expect(canvasNodePromptDraft({
        metadata: {
            content: "data:image/png;base64,existing-image",
            prompt: "original image generation prompt",
        },
    })).toBe("");
});

test("uses the generation prompt only when a new node has no saved draft", () => {
    expect(canvasNodePromptDraft({ metadata: { prompt: "new image prompt" } })).toBe("new image prompt");
});
