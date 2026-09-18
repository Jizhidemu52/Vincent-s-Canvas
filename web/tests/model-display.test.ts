import { afterEach, expect, test } from "bun:test";
import { imageModelDisplayName, imageModelIdentityHidden, maskImageModelText, displayModelMetadata, exportModelMetadata } from "../src/lib/model-display";
import { useBusinessConfigStore } from "../src/stores/use-business-config-store";
import { useUserStore } from "../src/stores/use-user-store";
import { defaultConfig, modelOptionLabel, modelOptionName } from "../src/stores/use-config-store";

const image = { id: "image-uuid", modelId: "image-uuid", name: "出图模型2", publicName: "出图模型2", modelIdentityHidden: true, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const real = { ...image, modelId: "gpt-image-2.5-flare", name: "Private Image Name", modelIdentityHidden: false };
const video = { ...image, id: "video", modelId: "wan2.7", name: "Wan", capabilities: ["video"] };
const originalModels = useBusinessConfigStore.getState().models;
const originalUser = useUserStore.getState().user;

test("export retains opaque model references and user prompts without disclosing real names", () => {
    useBusinessConfigStore.setState({ models: [real] });
    useUserStore.setState({ user: null });
    const source = { modelId: real.modelId, modelName: real.name, settings: { imageModels: [real.modelId] }, prompt: "请写 gpt-image-2", meta: `模型 ${real.modelId}` };
    expect(exportModelMetadata(source)).toEqual({ modelId: real.id, modelName: real.publicName, settings: { imageModels: [real.id] }, prompt: source.prompt, meta: `模型 ${real.publicName}` });
    expect(source.modelId).toBe(real.modelId);
});
afterEach(() => { useBusinessConfigStore.setState({ models: originalModels }); useUserStore.setState({ user: originalUser }); });

test("designers see stable names for opaque ids without changing request identity", () => {
    expect(imageModelDisplayName(image.modelId, [image], "designer")).toBe("出图模型2");
    expect(imageModelDisplayName("default::image-uuid", [image], "designer")).toBe("出图模型2");
    expect(imageModelIdentityHidden(image.id, [image], "designer")).toBe(true);
    expect(modelOptionName("default::image-uuid")).toBe("image-uuid");
    expect(image.modelId).toBe("image-uuid");
});

test("stale real names never surface for designers; administrators keep the mapping", () => {
    expect(imageModelDisplayName(real.modelId, [real], "designer")).toBe("出图模型2");
    expect(imageModelDisplayName(real.modelId, [real], "super_admin")).toBe(real.name);
    expect(imageModelDisplayName("default::gpt-image-2", [], "designer")).toBe("出图模型（旧记录）");
    expect(imageModelDisplayName("midjourney-blend", [], "department_admin")).toBe("midjourney-blend");
    expect(imageModelIdentityHidden("gpt-6-astra", [], "designer")).toBe(false);
    expect(imageModelDisplayName(video.modelId, [video], "designer")).toBe("wan2.7");
});

test("current generic model label and old generation metadata are safely displayed", () => {
    useBusinessConfigStore.setState({ models: [image] });
    useUserStore.setState({ user: null });
    expect(modelOptionLabel(defaultConfig, image.id)).toBe("出图模型2");
    expect(modelOptionLabel(defaultConfig, "default::gpt-image-2")).not.toContain("gpt");
    expect(maskImageModelText("2 张 · gpt-image-2.5-flare · high", [], "designer")).toBe("2 张 · 出图模型 · high");
    const data = { model: real.modelId, prompt: "请写 gpt-image-2", meta: "模型 gpt-image-2.5-flare", settings: { imageModel: real.modelId } };
    const displayed = displayModelMetadata(data, [real], "designer");
    expect(displayed).toEqual({ model: "出图模型2", prompt: data.prompt, meta: "模型 出图模型2", settings: { imageModel: "出图模型2" } });
    expect(data.model).toBe(real.modelId);
    expect(displayModelMetadata(data, [real], "super_admin")).toBe(data);
});
