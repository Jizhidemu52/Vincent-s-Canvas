import { expect, test } from "bun:test";
import { imageAgentDraftSettings, imageAgentQualitySettings } from "@/lib/image-agent-defaults";
import { imageModelProfile } from "@/lib/image-model-settings";

test.each([
    ["gpt-image-2.6-flare", undefined, "high", "2k"],
    ["standard", "standard", "high", undefined],
    ["pixel", "pixel", "2k", undefined],
    ["nano", "resolution-1k", "2k", undefined],
    ["grok", "grok-image", "medium", "2k"],
    ["mai-image-2.6-flash", undefined, "auto", "2k"],
    ["midjourney", undefined, "relax", undefined],
] as const)("agent default for %s uses only supported 2K / high parameters", (modelId, imageParameterProfile, quality, resolution) => {
    const profile = imageModelProfile(modelId, imageParameterProfile ? [{ id: modelId, modelId, name: modelId, capabilities: ["generate"], imageParameterProfile, creditCost: 0, rmbCost: 0 }] : []);
    expect(imageAgentQualitySettings(profile)).toEqual({ quality, resolution });
    expect(imageAgentQualitySettings(profile, "unsupported", "8k")).toEqual({ quality, resolution });
});

test("explicit historical quality, resolution and unrelated options are preserved without mutation", () => {
    const profile = imageModelProfile("gpt-image-2.6-flare", []);
    const options = '{"resolution":"1k","output_format":"webp"}';
    expect(imageAgentDraftSettings(profile, "low", options)).toEqual({ quality: "low", imageOptions: '{"output_format":"webp","resolution":"1k"}' });
    expect(imageAgentQualitySettings(profile, "auto", "4k")).toEqual({ quality: "auto", resolution: "4k" });
    expect(options).toBe('{"resolution":"1k","output_format":"webp"}');
    expect(imageAgentDraftSettings(imageModelProfile("midjourney", []), "turbo", options)).toEqual({ quality: "turbo", imageOptions: '{"output_format":"webp"}' });
});
