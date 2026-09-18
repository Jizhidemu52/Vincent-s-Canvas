import { describe, expect, test } from "bun:test";

import { estimateServerUsage, resolveToolModel, type BusinessConfig } from "../src/services/api/business-config";
import { stripClientProviderSecrets } from "../src/stores/use-config-store";

const config: BusinessConfig = {
    models: [{ id: "model-id", name: "公司生图模型", modelId: "image-v1", capabilities: ["generate"], creditCost: 3, rmbCost: 0.25 }],
    prices: [{ operationType: "image_generation", label: "生成图片", credits: 2, rmbCost: 0.1, version: 4 }],
    tools: [{ toolKey: "image", modelConfigId: "model-id" }],
};

describe("server-synchronized usage estimates", () => {
    test("keeps provider cost estimates without charging internal credits", () => {
        expect(estimateServerUsage(config, { operationType: "image_generation", modelId: "image-v1", quantity: 4 })).toEqual({ credits: 0, rmbCost: 1.4, configured: true });
    });

    test("supports operations that do not require a model", () => {
        expect(estimateServerUsage(config, { operationType: "image_generation", quantity: 1 })).toEqual({ credits: 0, rmbCost: 0.1, configured: true });
    });

    test("keeps the administrator model binding without a credit badge", () => {
        expect(estimateServerUsage(config, { operationType: "image_generation", toolKey: "image" })).toEqual({ credits: 0, rmbCost: 0.35, configured: true });
        expect(estimateServerUsage(config, { operationType: "image_generation", toolKey: "video" }).configured).toBe(false);
    });

    test("resolves the exact model selected by the administrator", () => {
        expect(resolveToolModel(config, "image")?.modelId).toBe("image-v1");
        expect(resolveToolModel(config, "video")).toBeUndefined();
    });

    test("still marks missing requested models as unconfigured", () => {
        expect(estimateServerUsage(config, { operationType: "upscale", modelId: "missing", quantity: 1 })).toEqual({ credits: 0, rmbCost: 0, configured: false });
    });

    test("missing credit prices do not block a configured model in the open workspace", () => {
        expect(estimateServerUsage({ ...config, prices: [] }, { operationType: "image_generation", toolKey: "image", quantity: 2 })).toEqual({ credits: 0, rmbCost: 0.5, configured: true });
        expect(estimateServerUsage({ ...config, prices: [] }, { operationType: "image_generation", modelId: "missing" }).configured).toBe(false);
    });
});

describe("client provider secret removal", () => {
    test("drops legacy top-level and channel API keys during hydration", () => {
        const sanitized = stripClientProviderSecrets({
            apiKey: "legacy-top-level-secret",
            channels: [{ id: "legacy", name: "旧渠道", baseUrl: "https://api.example.test", apiKey: "legacy-channel-secret", apiFormat: "openai", models: ["image-v1"] }],
        });
        expect(sanitized.apiKey).toBe("");
        expect(sanitized.channels[0]?.apiKey).toBe("");
        expect(JSON.stringify(sanitized)).not.toContain("legacy-channel-secret");
    });
});
