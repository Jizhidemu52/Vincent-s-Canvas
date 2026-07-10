import { describe, expect, test } from "bun:test";

import { estimateServerUsage, type BusinessConfig } from "../src/services/api/business-config";

const config: BusinessConfig = {
    models: [{ id: "model-id", name: "公司生图模型", modelId: "image-v1", capabilities: ["generate"], creditCost: 3, rmbCost: 0.25 }],
    prices: [{ operationType: "image_generation", label: "生成图片", credits: 2, rmbCost: 0.1, version: 4 }],
};

describe("server-synchronized usage estimates", () => {
    test("matches server billing by combining operation and model prices", () => {
        expect(estimateServerUsage(config, { operationType: "image_generation", modelId: "image-v1", quantity: 4 })).toEqual({ credits: 20, rmbCost: 1.4, configured: true });
    });

    test("supports operations that do not require a model", () => {
        expect(estimateServerUsage(config, { operationType: "image_generation", quantity: 1 })).toEqual({ credits: 2, rmbCost: 0.1, configured: true });
    });

    test("marks missing published prices or models as unconfigured", () => {
        expect(estimateServerUsage(config, { operationType: "upscale", modelId: "missing", quantity: 1 })).toEqual({ credits: 0, rmbCost: 0, configured: false });
    });
});
