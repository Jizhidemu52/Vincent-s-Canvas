import { expect, test } from "bun:test";
import { canvasImageUsageInput } from "@/lib/canvas/canvas-image-usage";
import { imageModelProfile } from "@/lib/image-model-settings";
import { estimateServerUsage, type BusinessConfig } from "@/services/api/business-config";

const business: BusinessConfig = {
    models: [
        { id: "blend-uuid", modelId: "blend-uuid", name: "aplmart-mj-blend", imageParameterProfile: "midjourney-blend", capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
        { id: "grok-uuid", modelId: "grok-uuid", name: "aplmart-grok2", imageParameterProfile: "grok-image", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    ],
    prices: [
        { operationType: "image_generation", label: "生成", credits: 1, rmbCost: 0.1, version: 1 },
        { operationType: "inpaint", label: "编辑", credits: 9, rmbCost: 0.9, version: 1 },
    ],
    tools: [
        { toolKey: "canvas-image", modelConfigId: null, enabled: true, creditCostOverride: 2, rmbCostOverride: 0.2, configurationVersion: 1 },
        { toolKey: "canvas-edit", modelConfigId: null, enabled: true, creditCostOverride: 8, rmbCostOverride: 0.8, configurationVersion: 1 },
    ],
};

test.each([2, 4])("Blend with %i references estimates its generation override instead of an unavailable edit", referenceCount => {
    const input = canvasImageUsageInput("blend-uuid", referenceCount, imageModelProfile("blend-uuid", business.models));
    expect(input).toEqual({ operationType: "image_generation", toolKey: "canvas-image", modelId: "blend-uuid", quantity: 1 });
    expect(estimateServerUsage(business, input)).toMatchObject({ configured: true, rmbCost: 0.2 });
    expect(estimateServerUsage(business, { ...input, operationType: "inpaint", toolKey: "canvas-edit" })).toMatchObject({ configured: false, rmbCost: 0 });
});

test.each([0, 1, 3])("ordinary image reference count %i retains its correct generate/edit pricing", referenceCount => {
    const input = canvasImageUsageInput("grok-uuid", referenceCount, imageModelProfile("grok-uuid", business.models));
    expect(input).toMatchObject({ operationType: referenceCount ? "inpaint" : "image_generation", toolKey: referenceCount ? "canvas-edit" : "canvas-image", quantity: 1 });
    expect(estimateServerUsage(business, input)).toMatchObject({ configured: true, rmbCost: referenceCount ? 0.8 : 0.2 });
});
