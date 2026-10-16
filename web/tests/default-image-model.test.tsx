import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_IMAGE_MODEL, preferredImageModel } from "@/lib/default-image-model";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { preferredChatImageModel } from "@/pages/chat/image-quality";

const models = [
    { id: "open-gpt2", modelId: "open-gpt2", name: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "mark-flare", modelId: "mark-flare", name: "aplmart-gpt2.5-flare", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "mark-gpt2", modelId: "mark-gpt2", name: "aplmart-gpt2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
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

describe("APIMart GPT2 default selection", () => {
    test("new and stale selections prefer APIMart rather than another provider's GPT2 or the first row", () => {
        expect(defaultConfig.imageModel).toBe(DEFAULT_IMAGE_MODEL);
        expect(defaultConfig.model).toBe(DEFAULT_IMAGE_MODEL);
        expect(preferredImageModel(models)?.id).toBe("mark-gpt2");
        expect(preferredImageModel(models, ["removed"])?.id).toBe("mark-gpt2");
        expect(resolveCapabilityModel({ ...defaultConfig, imageModel: "removed" }, "image", models)).toBe("mark-gpt2");
        expect(preferredChatImageModel(models, [])?.id).toBe("mark-gpt2");
    });

    test("valid explicit selections and provider-specific public aliases remain authoritative", () => {
        expect(preferredImageModel(models, ["open-gpt2"])?.id).toBe("open-gpt2");
        expect(preferredImageModel(models, ["default::aplmart-gpt2.5-flare"])?.id).toBe("mark-flare");
        expect(resolveCapabilityModel(defaultConfig, "image", models, "mark-flare")).toBe("mark-flare");
        expect(preferredChatImageModel(models, ["mark-flare"])?.id).toBe("mark-flare");
    });

    test("publicName resolves opaque IDs and unavailable defaults fall back only to supplied compatible models", () => {
        const hidden = models.map(model => ({ ...model, publicName: model.name, name: model.id }));
        expect(preferredImageModel(hidden)?.modelId).toBe("mark-gpt2");
        expect(preferredImageModel(models.slice(0, 2))?.modelId).toBe("open-gpt2");
        expect(preferredImageModel([])).toBeUndefined();
        const editOnly = models.map(model => ({ ...model, capabilities: model.id === "mark-gpt2" ? ["generate"] : ["edit"] }));
        expect(preferredChatImageModel(editOnly, [], "edit")?.id).toBe("open-gpt2");
    });

    test("effective defaults resolve after server loading without rewriting saved user selections", () => {
        useConfigStore.setState({ config: defaultConfig });
        Object.assign(configInitialState, { config: defaultConfig });
        Object.assign(businessInitialState, { models, status: "ready" });
        let selected = defaultConfig;
        function ReadConfig() { selected = useEffectiveConfig(); return null; }
        renderToStaticMarkup(<ReadConfig />);
        expect(selected).toMatchObject({ model: "mark-gpt2", imageModel: "mark-gpt2" });
        expect(useConfigStore.getState().config.imageModel).toBe(DEFAULT_IMAGE_MODEL);
        Object.assign(configInitialState, { config: { ...defaultConfig, imageModel: "mark-flare" } });
        renderToStaticMarkup(<ReadConfig />);
        expect(selected.imageModel).toBe("mark-flare");
        Object.assign(businessInitialState, { status: "loading", models: [] });
        renderToStaticMarkup(<ReadConfig />);
        expect(selected.imageModel).toBe("mark-flare");
    });
});
