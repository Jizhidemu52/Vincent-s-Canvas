import { describe, expect, test } from "bun:test";

import { estimateServerUsage, resolveToolModel, type BusinessConfig } from "../src/services/api/business-config";
import { stripClientProviderSecrets } from "../src/stores/use-config-store";

const config: BusinessConfig = {
    models: [{ id: "model-id", name: "公司生图模型", modelId: "image-v1", capabilities: ["generate"], creditCost: 3, rmbCost: 0.25 }],
    prices: [{ operationType: "image_generation", label: "生成图片", credits: 2, rmbCost: 0.1, version: 4 }],
    tools: [{ toolKey: "image", modelConfigId: "model-id", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 0 }],
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

    test("a board binding takes precedence over an explicit requested model", () => {
        const otherModel = { ...config.models[0], id: "other", modelId: "other-image", rmbCost: 4 };
        const combined = { ...config, models: [...config.models, otherModel] };
        expect(resolveToolModel(combined, "image", "other")?.id).toBe("model-id");
        expect(estimateServerUsage(combined, { operationType: "image_generation", toolKey: "image", modelId: "other" }).rmbCost).toBe(0.35);
    });

    test("disabled tools and broken bindings never fall back", () => {
        const disabled = { ...config, tools: [{ ...config.tools[0], enabled: false }] };
        const broken = { ...config, tools: [{ ...config.tools[0], modelConfigId: "missing" }] };
        for (const unavailable of [disabled, broken]) {
            expect(resolveToolModel(unavailable, "image", "image-v1")).toBeUndefined();
            expect(estimateServerUsage(unavailable, { operationType: "image_generation", toolKey: "image", modelId: "image-v1" })).toEqual({ credits: 0, rmbCost: 0, configured: false });
        }
    });

    test("an enabled unbound tool supports user choice and compatible defaults", () => {
        const unbound = { ...config, tools: [{ ...config.tools[0], modelConfigId: null }] };
        expect(resolveToolModel(unbound, "image", "image-v1")?.id).toBe("model-id");
        expect(resolveToolModel(unbound, "image")?.id).toBe("model-id");
        expect(resolveToolModel(unbound, "image", "missing")).toBeUndefined();
        expect(estimateServerUsage(unbound, { operationType: "image_generation", toolKey: "image" }).configured).toBe(true);
        expect(resolveToolModel({ ...unbound, models: [{ ...config.models[0], capabilities: ["chat"] }] }, "image")).toBeUndefined();
    });

    test("a known board missing a legacy binding keeps the selected compatible model", () => {
        const legacy = { ...config, tools: [] };
        expect(resolveToolModel(legacy, "creative-text-to-style", "image-v1")?.id).toBe("model-id");
        expect(estimateServerUsage(legacy, { operationType: "image_generation", toolKey: "creative-text-to-style", modelId: "image-v1" }).rmbCost).toBe(0.35);
        expect(resolveToolModel(legacy, "not-a-real-board", "image-v1")).toBeUndefined();
    });

    test("zero overrides are total per-call amounts and isolated to each board", () => {
        const isolated = { ...config, tools: [
            { ...config.tools[0], rmbCostOverride: 0, creditCostOverride: 0 },
            { ...config.tools[0], toolKey: "creative-text-to-style", rmbCostOverride: 0.7 },
            { ...config.tools[0], toolKey: "canvas-image" },
        ] };
        expect(estimateServerUsage(isolated, { operationType: "image_generation", toolKey: "image", quantity: 3 }).rmbCost).toBe(0);
        expect(estimateServerUsage(isolated, { operationType: "image_generation", toolKey: "creative-text-to-style", quantity: 3 }).rmbCost).toBe(2.1);
        expect(estimateServerUsage(isolated, { operationType: "image_generation", toolKey: "canvas-image", quantity: 3 }).rmbCost).toBe(1.05);
    });

    test("chat is uncharged even if stale price overrides are present", () => {
        const chat = { ...config, models: [{ ...config.models[0], capabilities: ["chat"] }], tools: [{ ...config.tools[0], toolKey: "gpt-chat", rmbCostOverride: 9, creditCostOverride: 9 }] };
        expect(estimateServerUsage(chat, { operationType: "chat", toolKey: "gpt-chat" })).toEqual({ credits: 0, rmbCost: 0, configured: true });
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
