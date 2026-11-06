import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CANVAS_IMAGE_MODEL, DEFAULT_IMAGE_MODEL, preferredImageModel } from "@/lib/default-image-model";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { preferredChatImageModel } from "@/pages/chat/image-quality";
import { currentToolConfig, useToolConfig } from "@/hooks/use-tool-config";
import { applyToolModel } from "@/services/api/tool-runtime";
import { toolDefinitions } from "../../shared/feature-catalog";

const models = [
    { id: "open-gpt2", modelId: "open-gpt2", name: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "mark-flare", modelId: "mark-flare", name: "aplmart-gpt2.5-flare", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "mark-gpt2", modelId: "mark-gpt2", name: "aplmart-gpt2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "mark-flare26", modelId: "mark-flare26", name: "aplmart-gpt2.6-flare", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
];
const originalConfig = useConfigStore.getState();
const originalBusiness = useBusinessConfigStore.getState();
const configInitialState = useConfigStore.getInitialState();
const originalConfigInitial = { ...configInitialState };
const businessInitialState = useBusinessConfigStore.getInitialState();
const originalBusinessInitial = { ...businessInitialState };
afterEach(() => {
    useConfigStore.setState(originalConfig);
    useBusinessConfigStore.setState(originalBusiness);
    Object.assign(configInitialState, originalConfigInitial);
    Object.assign(businessInitialState, originalBusinessInitial);
});

describe("APIMart GPT2.6 Flare default selection", () => {
    const imageTools = toolDefinitions.filter(tool => tool.toolKey !== "midjourney-blend" && ["image_generation", "inpaint", "upscale", "seamless_stitch", "batch_image"].includes(tool.operationType));

    test("new image workspaces ignore an old global default without changing stored preferences or other media", () => {
        const saved = { ...defaultConfig, model: "mark-gpt2", imageModel: "mark-gpt2", videoModel: "saved-video", textModel: "saved-chat" };
        Object.assign(configInitialState, { config: saved });
        Object.assign(businessInitialState, { models, status: "ready" });
        let imageConfig = defaultConfig;
        let regularConfig = defaultConfig;
        function ReadConfig() { imageConfig = useEffectiveConfig("image"); regularConfig = useEffectiveConfig(); return null; }
        renderToStaticMarkup(<ReadConfig />);
        expect(imageConfig).toMatchObject({ model: "mark-flare26", imageModel: "mark-flare26", videoModel: "saved-video" });
        expect(regularConfig).toMatchObject({ model: "mark-gpt2", imageModel: "mark-gpt2", videoModel: "saved-video" });
        expect(imageConfig.textModel).toBe(regularConfig.textModel);
        expect(configInitialState.config).toBe(saved);
        Object.assign(businessInitialState, { status: "loading", models: [] });
        renderToStaticMarkup(<ReadConfig />);
        expect(imageConfig).toMatchObject({ model: DEFAULT_IMAGE_MODEL, imageModel: DEFAULT_IMAGE_MODEL });
    });

    test.each(imageTools)("$toolKey resolves a new empty choice to Flare but preserves a saved choice and forced binding", tool => {
        const business = { models, prices: [], tools: [] };
        const empty = { ...defaultConfig, model: "", imageModel: "" };
        expect(applyToolModel(empty, business, tool.toolKey)).toMatchObject({ model: "mark-flare26", imageModel: "mark-flare26" });
        const selected = { ...defaultConfig, model: "mark-flare", imageModel: "mark-flare" };
        expect(applyToolModel(selected, business, tool.toolKey).model).toBe("mark-flare");
        const bound = { ...business, tools: [{ toolKey: tool.toolKey, modelConfigId: "mark-gpt2", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }] };
        expect(applyToolModel(empty, bound, tool.toolKey).model).toBe("mark-gpt2");
        expect(() => applyToolModel(empty, { ...bound, tools: [{ ...bound.tools[0]!, modelConfigId: "removed" }] }, tool.toolKey)).toThrow("绑定的模型");
        expect(() => applyToolModel(empty, { ...bound, tools: [{ ...bound.tools[0]!, enabled: false }] }, tool.toolKey)).toThrow("已停用");
        expect(selected.model).toBe("mark-flare");
    });

    test("a default captured before loading resolves an opaque public alias without rewriting the draft", () => {
        const opaqueModels = models.map(model => ({ ...model, publicName: model.name, name: `Display ${model.id}` }));
        const business = { models: opaqueModels, prices: [], tools: [], status: "ready" as const };
        Object.assign(businessInitialState, business);
        useBusinessConfigStore.setState(business);
        let current = defaultConfig;
        function ReadConfig() { current = useToolConfig(defaultConfig, "creative-style-to-sketch"); return null; }
        renderToStaticMarkup(<ReadConfig />);
        expect(current).toMatchObject({ model: "mark-flare26", imageModel: "mark-flare26" });
        expect(currentToolConfig(defaultConfig, "canvas-batch")).toMatchObject({ model: "mark-flare26", imageModel: "mark-flare26" });
        expect(defaultConfig.imageModel).toBe(DEFAULT_IMAGE_MODEL);
        const selected = { ...defaultConfig, model: "mark-flare", imageModel: "mark-flare" };
        expect(currentToolConfig(selected, "canvas-batch")).toMatchObject({ model: "mark-flare", imageModel: "mark-flare" });
    });

    test("missing explicit models and non-image or dedicated Blend workflows never silently use the image default", () => {
        const business = { models, prices: [], tools: [] };
        expect(() => applyToolModel({ ...defaultConfig, model: "removed-model" }, business, "canvas-image")).toThrow("所选模型");
        expect(() => applyToolModel({ ...defaultConfig, model: "", videoModel: "" }, business, "video")).toThrow("所选模型");
        expect(() => applyToolModel({ ...defaultConfig, model: "", imageModel: "" }, business, "midjourney-blend")).toThrow("所选模型");
    });
    test("new and stale selections prefer APIMart rather than another provider's GPT2 or the first row", () => {
        expect(defaultConfig.imageModel).toBe(DEFAULT_IMAGE_MODEL);
        expect(defaultConfig.model).toBe(DEFAULT_IMAGE_MODEL);
        expect(preferredImageModel(models)?.id).toBe("mark-flare26");
        expect(preferredImageModel(models, ["removed"])?.id).toBe("mark-flare26");
        expect(resolveCapabilityModel({ ...defaultConfig, imageModel: "removed" }, "image", models)).toBe("mark-flare26");
        expect(preferredChatImageModel(models, [])?.id).toBe("mark-flare26");
    });

    test("valid explicit selections and provider-specific public aliases remain authoritative", () => {
        expect(preferredImageModel(models, ["open-gpt2"])?.id).toBe("open-gpt2");
        expect(preferredImageModel(models, ["default::aplmart-gpt2.5-flare"])?.id).toBe("mark-flare");
        expect(resolveCapabilityModel(defaultConfig, "image", models, "mark-flare")).toBe("mark-flare");
        expect(preferredChatImageModel(models, ["mark-flare"])?.id).toBe("mark-flare");
    });

    test("publicName resolves opaque IDs and unavailable defaults fall back only to supplied compatible models", () => {
        const hidden = models.map(model => ({ ...model, publicName: model.name, name: model.id }));
        expect(preferredImageModel(hidden)?.modelId).toBe("mark-flare26");
        expect(preferredImageModel(models.slice(0, 2))?.modelId).toBe("open-gpt2");
        expect(preferredImageModel([])).toBeUndefined();
        const editOnly = models.map(model => ({ ...model, capabilities: ["mark-gpt2", "mark-flare26"].includes(model.id) ? ["generate"] : ["edit"] }));
        expect(preferredChatImageModel(editOnly, [], "edit")?.id).toBe("open-gpt2");
    });

    test("effective defaults resolve after server loading without rewriting saved user selections", () => {
        useConfigStore.setState({ config: defaultConfig });
        Object.assign(configInitialState, { config: defaultConfig });
        Object.assign(businessInitialState, { models, status: "ready" });
        let selected = defaultConfig;
        function ReadConfig() { selected = useEffectiveConfig(); return null; }
        renderToStaticMarkup(<ReadConfig />);
        expect(selected).toMatchObject({ model: "mark-flare26", imageModel: "mark-flare26" });
        expect(useConfigStore.getState().config.imageModel).toBe(DEFAULT_IMAGE_MODEL);
        Object.assign(configInitialState, { config: { ...defaultConfig, imageModel: "mark-flare" } });
        renderToStaticMarkup(<ReadConfig />);
        expect(selected.imageModel).toBe("mark-flare");
        Object.assign(businessInitialState, { status: "loading", models: [] });
        renderToStaticMarkup(<ReadConfig />);
        expect(selected.imageModel).toBe("mark-flare");
    });

    test("canvas starts with Flare while other workspaces and saved node choices remain unchanged", () => {
        const saved = { ...defaultConfig, model: "mark-gpt2", imageModel: "mark-gpt2" };
        Object.assign(configInitialState, { config: saved });
        Object.assign(businessInitialState, { models, status: "ready" });
        let canvasConfig = defaultConfig;
        let regularConfig = defaultConfig;
        function ReadConfig() { canvasConfig = useEffectiveConfig("canvas"); regularConfig = useEffectiveConfig(); return null; }
        renderToStaticMarkup(<ReadConfig />);
        expect(canvasConfig).toMatchObject({ model: "mark-flare26", imageModel: "mark-flare26" });
        expect(regularConfig).toMatchObject({ model: "mark-gpt2", imageModel: "mark-gpt2" });
        expect(configInitialState.config).toBe(saved);
        expect(resolveCapabilityModel(canvasConfig, "image", models, "mark-gpt2")).toBe("mark-gpt2");
        Object.assign(businessInitialState, { status: "loading", models: [] });
        renderToStaticMarkup(<ReadConfig />);
        expect(canvasConfig.imageModel).toBe(DEFAULT_CANVAS_IMAGE_MODEL);
        Object.assign(businessInitialState, { status: "ready", models: models.filter(model => model.id !== "mark-flare26") });
        renderToStaticMarkup(<ReadConfig />);
        expect(canvasConfig.imageModel).toBe("mark-gpt2");
    });
});
