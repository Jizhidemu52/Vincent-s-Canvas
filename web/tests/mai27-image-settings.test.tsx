import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImagePrimarySettings, ImageSettingsPanel } from "@/components/image-settings-panel";
import { CanvasQuickSettingsPopovers } from "@/components/canvas/canvas-quick-settings-popovers";
import { designModels } from "../src/components/canvas/design-discussion/model-presets.mjs";
import { availableModels, imageParameters } from "../src/components/canvas/design-discussion/task-model.mjs";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasImageModelDetails, canvasModelPresentation } from "@/lib/canvas/canvas-model-picker-options";
import { adaptImageModelSettings, imageModelProfile, imageModelSettingsError, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageAdvancedParameters, imageOptionFields } from "@/lib/image-advanced-settings";
import { referencePolicyForModel, validateImageReferences } from "@/lib/image-reference-policy";
import { mergePromptEditorParameters, promptImageSettings } from "@/lib/prompt-editor-parameters";
import { getModelPickerOptions } from "@/lib/model-picker-options";
import { imageTaskParameters } from "@/services/api/image";
import { chatImageSizeOptions, resolveChatImageSize } from "@/pages/chat/image-size";
import { filterChatImageModels, selectChatImageModel } from "@/pages/chat/image-quality";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { PublicModel } from "@/services/api/business-config";

const model: PublicModel = { id: "opaque-mai27", modelId: "opaque-mai27", name: "aplmart-mai2.7-flash", publicName: "aplmart-mai2.7-flash", imageParameterProfile: "mai-image-v2", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
const profile = imageModelProfile(model.id, [model], "designer");
const config = { ...defaultConfig, model: model.id, imageModel: model.id, size: "16:9", quality: "auto", imageOptions: '{"resolution":"2k","nsfw_check":"true"}' };
const references = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `reference-${index}`, name: `${index}.png`, type: "image/png", dataUrl: "data:image/png;base64,AAAA" }));
const saved = useBusinessConfigStore.getState();
afterEach(() => useBusinessConfigStore.setState(saved));

test("MAI 2.7 opaque and raw identities expose their own profile without changing historical 2.6", () => {
    expect(profile).toMatchObject({ kind: "mai-image", mai27: true, supportsMask: false, maxCount: 1, resolutions: ["1k", "2k"], qualities: ["auto"], backgrounds: [], outputFormats: [] });
    expect(imageModelProfile("mai-image-2.7-flash", []).mai27).toBe(true);
    expect(imageModelProfile("mai-image-2.6-flash", [])).toMatchObject({ mai27: false, sizeConstraints: { maxPixels: 2359296 } });
    expect(profile.sizes).not.toContain("auto");
    expect(profile.tip).not.toContain("100 万像素");
    expect(imageOptionFields(profile).map(field => field.key)).toEqual(["resolution", "nsfw_check", "negative_prompt"]);
    expect(imageOptionFields(imageModelProfile("mai-image-2.6-flash", [])).map(field => field.key)).toContain("web_grounding");
    expect(canvasModelPresentation(model.name)).toMatchObject({ name: "MAI Image 2.7 Flash", family: "Microsoft", channel: "APIMart" });
    expect(canvasImageModelDetails(profile, referencePolicyForModel(model.id, profile))).toContain("图生图尺寸由模型决定 · PNG");
});

test("MAI 2.7 pixels follow the documented area limit without inventing a 2048 edge or 4:1 pixel limit", () => {
    for (const size of ["768x768", "1000x1000", "1025x1024", "2048x2048", "2560x1536", "4096x1024", "5461x768", "1:4", "4:1", "21:9"]) expect(imageModelSettingsError(size, profile)).toBe("");
    for (const size of ["767x1024", "5462x768", "2080x2048", "auto", "8:1", "1:8"]) expect(imageModelSettingsError(size, profile)).not.toBe("");
    expect(imageTaskParameters({ ...config, size: "1000x1000" }, profile)).toEqual({ size: "1000x1000", resolution: "2k", nsfw_check: true });
    expect(() => imageTaskParameters({ ...config, size: "auto" }, profile)).toThrow("不支持自适应");
    expect(normalizeImageModelSettings({ size: "auto", quality: "max", count: "5" }, profile)).toEqual({ size: "1:1", quality: "auto", count: "1" });
});

test("selecting 2.7 removes old unsupported settings while preserving explicit valid values", () => {
    const previous = { size: "auto", quality: "high", count: "2", imageOptions: '{"resolution":"2k","web_grounding":"true","auto_aspect_ratio":"true","background":"transparent","output_format":"jpeg","nsfw_check":"true","negative_prompt":"watermark"}' };
    const snapshot = structuredClone(previous);
    const selected = adaptImageModelSettings(previous, profile);
    expect(selected).toEqual({ size: "1:1", quality: "auto", count: "1", imageOptions: '{"resolution":"2k","nsfw_check":"true","negative_prompt":"watermark"}' });
    expect(imageTaskParameters({ ...config, ...selected }, profile)).toEqual({ size: "1:1", resolution: "2k", nsfw_check: true, negative_prompt: "watermark" });
    expect(previous).toEqual(snapshot);
    expect(() => imageAdvancedParameters('{"nsfw_check":"yes"}', profile)).toThrow("必须为开或关");
});

test("MAI 2.7 references omit size and resolution without changing saved preferences or exceeding five sources", () => {
    const snapshot = structuredClone(config);
    for (const referenceCount of [1, 5]) expect(imageTaskParameters({ ...config, size: "auto" }, profile, { referenceCount })).toEqual({ nsfw_check: true });
    expect(imageTaskParameters(config, profile)).toEqual({ size: "16:9", resolution: "2k", nsfw_check: true });
    expect(config).toEqual(snapshot);
    expect(validateImageReferences(model.id, references(5), profile).valid).toBe(true);
    expect(validateImageReferences(model.id, references(6), profile)).toMatchObject({ valid: false, maximum: 5 });
});

test("MAI 2.7 panels show model-determined editing dimensions, never old 1 MP or active 2K editing controls", () => {
    const props = { config, profile, referenceCount: 1, theme: canvasThemes.light, onConfigChange: () => undefined };
    const markup = renderToStaticMarkup(<><ImageSettingsPanel {...props} /><ImagePrimarySettings {...props} modelControl={<span>MAI Image 2.7 Flash</span>} /><CanvasQuickSettingsPopovers {...props} disabled={false} /></>);
    expect(markup).toContain("模型根据参考图决定");
    expect(markup).not.toContain("100 万像素");
    expect(markup).not.toContain('value="2k"');
    expect(markup).not.toContain('aria-label="自定义宽度"');
    const generation = renderToStaticMarkup(<ImageSettingsPanel {...props} referenceCount={0} spacious />);
    expect(generation).toContain("提交前内容检查");
    expect(generation).not.toContain('aria-label="联网参考"');
    expect(generation).toContain("向下对齐到最近的 32");
});

test("chat selects 2.7 without auto and editing never measures or promises fixed output pixels", async () => {
    useBusinessConfigStore.setState({ models: [model] });
    expect(selectChatImageModel(model.id, {})).toMatchObject({ imageModelId: model.id, imageSize: "1:1", imageQuality: "auto", imageResolution: "2k" });
    expect(chatImageSizeOptions(profile).some(option => option.value === "auto")).toBe(false);
    expect(await resolveChatImageSize(config, undefined, "generate", undefined, () => undefined)).toBe("16:9");
    expect(await resolveChatImageSize(config, "2048x2048", "edit", references(1)[0], () => undefined, async () => { throw new Error("Unneeded source measurement"); })).toBe("auto");
    expect(filterChatImageModels([model], "generate")).toEqual([model]);
    expect(filterChatImageModels([model], "edit")).toEqual([model]);
});

test("all image selection categories and design discussion expose 2.7 while respecting fixed-tool bindings", () => {
    expect(getModelPickerOptions(defaultConfig, "image", [model], "server")).toEqual([model.modelId]);
    for (const referenceCount of [0, 1]) {
        const catalog = { models: [model], tools: [{ toolKey: referenceCount ? "image-edit" : "image", enabled: true, modelConfigId: null }] };
        expect(availableModels(catalog, referenceCount)).toEqual([model]);
        expect(designModels(catalog, referenceCount)).toEqual([{ ...model, label: "MAI 2.7 Flash" }]);
        expect(imageParameters(model, referenceCount)).toEqual(referenceCount ? { count: 1 } : { size: "1:1", resolution: "1k", count: 1 });
        expect(availableModels({ ...catalog, tools: [{ ...catalog.tools[0], modelConfigId: "fixed-other" }] }, referenceCount)).toEqual([]);
    }
});

test("prompt editor 2.7 saves remove unsupported legacy fields and restore usable text-only defaults", () => {
    const old = { web_grounding: true, auto_aspect_ratio: true, quality: "high", width: 1024, height: 1024, size: "auto", resolution: "2k" };
    const snapshot = structuredClone(old);
    const edited = mergePromptEditorParameters(old, { size: "1:1", quality: "auto", imageOptions: '{"resolution":"2k","nsfw_check":"true"}', referenceAssetIds: ["reference"] }, profile);
    expect(edited).not.toHaveProperty("web_grounding");
    expect(edited).not.toHaveProperty("auto_aspect_ratio");
    expect(edited).not.toHaveProperty("size");
    expect(edited).not.toHaveProperty("resolution");
    expect(edited.nsfw_check).toBe(true);
    expect(promptImageSettings(edited, model.id, [model])).toMatchObject({ size: "1:1", quality: "auto", count: "1" });
    expect(old).toEqual(snapshot);
});
