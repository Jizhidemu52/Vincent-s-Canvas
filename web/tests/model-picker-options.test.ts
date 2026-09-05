import { describe, expect, test } from "bun:test";
import { filterServerModelsByCapability, getModelPickerOptions, resolveCapabilityModel, resolveModelPickerSource, resolveModelPickerValue } from "@/lib/model-picker-options";
import { defaultConfig } from "@/stores/use-config-store";

const models = [
    { modelId: "gpt-image-2", capabilities: ["generate", "edit"] },
    { modelId: "other-image", capabilities: ["generate"] },
    { modelId: "chat-custom", capabilities: ["chat"] },
    { modelId: "wan2.7", capabilities: ["video"] },
    { modelId: "demo-audio", capabilities: ["audio"] },
];

describe("capability-backed model selection", () => {
    test("mode changes replace a wrong-type model with an actually available one", () => {
        expect(resolveCapabilityModel(defaultConfig, "image", models, "chat-custom")).toBe("gpt-image-2");
        expect(resolveCapabilityModel(defaultConfig, "text", models, "gpt-image-2")).toBe("chat-custom");
        expect(resolveCapabilityModel(defaultConfig, "video", models, "gpt-image-2")).toBe("wan2.7");
        expect(resolveCapabilityModel(defaultConfig, "audio", models, "gpt-image-2")).toBe("");
    });

    test("server capabilities, not a guessed model name, decide which models are valid", () => {
        const customModels = [{ modelId: "custom-company-model", capabilities: ["audio"] }, { modelId: "image-looking-name", capabilities: ["chat"] }];
        expect(resolveCapabilityModel(defaultConfig, "audio", customModels, "")).toBe("custom-company-model");
        expect(filterServerModelsByCapability(customModels, "text").map((model) => model.modelId)).toEqual(["image-looking-name"]);
        expect(filterServerModelsByCapability(models, "audio")).toEqual([]);
    });

    test("keeps an available chosen model and canonicalizes an encoded configured default", () => {
        expect(resolveCapabilityModel(defaultConfig, "image", models, "other-image")).toBe("other-image");
        expect(resolveCapabilityModel(defaultConfig, "image", models, "default::other-image")).toBe("other-image");
        expect(resolveCapabilityModel({ ...defaultConfig, imageModel: "custom::other-image" }, "image", models, "removed-model")).toBe("other-image");
        expect(resolveCapabilityModel(defaultConfig, "video", [], "wan2.7")).toBe("");
    });

    test("an invalid current value cannot masquerade as a selectable model", () => {
        expect(resolveModelPickerValue("gpt-image-2", [], "server")).toBe("");
        expect(resolveModelPickerValue("gpt-image-2", ["wan2.7"], "server")).toBe("");
        expect(resolveModelPickerValue("default::wan2.7", ["wan2.7"], "server")).toBe("wan2.7");
        expect(resolveModelPickerValue("other::custom", ["company::custom"], "local")).toBe("");
    });

    test("server-backed standalone pickers do not use static local defaults", () => {
        expect(resolveModelPickerSource("remote", undefined, true)).toBe("server");
        expect(resolveModelPickerSource("local", "server", true)).toBe("server");
        expect(resolveModelPickerSource("local", undefined, false)).toBe("server");
        expect(getModelPickerOptions(defaultConfig, "audio", models, "server")).toEqual([]);
    });

    test("true local channels retain explicitly configured custom models and channel identity", () => {
        const config = { ...defaultConfig, audioModels: ["company::custom-a", "company::custom-b"], audioModel: "company::custom-b" };
        expect(resolveModelPickerSource("local", undefined, true)).toBe("local");
        expect(resolveModelPickerSource("local", "local", false)).toBe("local");
        expect(getModelPickerOptions(config, "audio", models, "local")).toEqual(config.audioModels);
        expect(resolveCapabilityModel(config, "audio", models, "company::custom-a", "local")).toBe("company::custom-a");
        expect(resolveCapabilityModel(config, "audio", models, "unavailable", "local")).toBe("company::custom-b");
        expect(getModelPickerOptions(config, undefined, [], "local", "custom-unlisted")).toContain("custom-unlisted");
    });
});
