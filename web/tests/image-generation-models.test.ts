import { describe, expect, test } from "bun:test";

import { selectImageGenerationModels } from "../src/services/api/generation-tasks";

describe("canvas agent image model list", () => {
    test("keeps both configured GPT Image 2.5 variants distinct", () => {
        const models = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].map(modelId => ({
            id: `config-${modelId}`, name: modelId, modelId, capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0,
        }));
        expect(selectImageGenerationModels(models).map(model => model.modelId)).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
    });

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
