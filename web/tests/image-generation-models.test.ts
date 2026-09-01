import { describe, expect, test } from "bun:test";

import { selectImageGenerationModels } from "../src/services/api/generation-tasks";

describe("canvas agent image model list", () => {
    test("keeps only configured image-capable models", () => {
        expect(selectImageGenerationModels([
            { id: "open-gpt", name: "open gpt2", modelId: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0 },
            { id: "gemini", name: "gemini", modelId: "gemini-3.1-flash-image", capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0 },
            { id: "video", name: "video", modelId: "happyhorse-1.1", capabilities: ["video"], creditCost: 4, rmbCost: 0 },
            { id: "demo", name: "demo", modelId: "demo-image", capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
        ])).toEqual([
            { id: "open-gpt", name: "open gpt2", modelId: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0 },
            { id: "gemini", name: "gemini", modelId: "gemini-3.1-flash-image", capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0 },
        ]);
    });
});
