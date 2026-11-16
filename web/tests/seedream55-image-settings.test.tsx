import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImagePrimarySettings, ImageSettingsPanel } from "@/components/image-settings-panel";
import { CanvasQuickQualityOptions, CanvasQuickSettingsPopovers } from "@/components/canvas/canvas-quick-settings-popovers";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasImageModelDetails, canvasModelPresentation } from "@/lib/canvas/canvas-model-picker-options";
import { adaptImageModelSettings, imageModelProfile } from "@/lib/image-model-settings";
import { imageOptionFields } from "@/lib/image-advanced-settings";
import { imageTaskParameters } from "@/services/api/image";
import { referencePolicyForModel, validateImageReferences } from "@/lib/image-reference-policy";
import { getModelPickerOptions, resolveCapabilityModel } from "@/lib/model-picker-options";
import { imageModelDisplayName } from "@/lib/model-display";
import { chatImageQualitySettings, filterChatImageModels, selectChatImageModel } from "@/pages/chat/image-quality";
import { mergePromptEditorParameters, promptImageSettings } from "@/lib/prompt-editor-parameters";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { PublicModel } from "@/services/api/business-config";

const doubao: PublicModel = { id: "opaque-doubao", modelId: "opaque-doubao", name: "豆包生图", publicName: "豆包生图", imageParameterProfile: "seedream55", imageSupportsMask: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const flare: PublicModel = { ...doubao, id: "opaque-flare", modelId: "opaque-flare", name: "aplmart-gpt2.6-flare", publicName: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2" };
const models = [doubao, flare];
const profile = imageModelProfile(doubao.id, models, "designer");
const previous = useBusinessConfigStore.getState();
afterEach(() => useBusinessConfigStore.setState(previous));
const config = { ...defaultConfig, model: doubao.id, imageModel: doubao.id, size: "16:9", quality: "auto", imageOptions: '{"resolution":"1.5k"}' };
const refs = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `ref-${index}`, name: `${index}.png`, type: "image/png", dataUrl: "data:image/png;base64,AAAA" }));

test("Doubao opaque public profile exposes documented controls without GPT or layer options", () => {
    expect(profile.kind).toBe("seedream55");
    expect(imageModelProfile("seedream-5-5", []).kind).toBe("seedream55");
    expect(profile.resolutions).toEqual(["1k", "1.5k", "2k"]);
    expect(profile.qualities).toEqual(["auto"]);
    expect(profile.sizes).toEqual(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9", "2:1", "1:2", "auto"]);
    expect(profile).toMatchObject({ maxCount: 1, upstreamCount: 1, customSize: false, supportsMask: false, supportsGif: false, supportsMarkup: false, supportsComplexity: false, supportsOfficialFallback: false });
    expect(imageOptionFields(profile).map(field => field.key)).toEqual(["resolution", "background", "output_format", "negative_prompt"]);
});

test.each(["1k", "1.5k", "2k"])("Doubao %s requests use one image and no quality, MJ or decomposition fields", resolution => {
    const draft = { ...config, count: "8", quality: "max", imageOptions: JSON.stringify({ resolution, quality: "high", midjourneyQuality: "2", midjourneySpeed: "turbo", background: "transparent", output_format: "jpeg", output_compression: "80", layer_decomposition: "true", complexity: "high", google_search: "true", official_fallback: "true", negative_prompt: "watermark" }) };
    const before = structuredClone(draft);
    expect(imageTaskParameters(draft, profile, { referenceCount: 10 })).toEqual({ size: "16:9", resolution, n: 1, background: "transparent", output_format: "png", negative_prompt: "watermark" });
    expect(draft).toEqual(before);
    expect(() => imageTaskParameters({ ...config, imageOptions: '{"resolution":"4k"}' }, profile)).toThrow("不支持 4k");
    expect(() => imageTaskParameters({ ...config, imageOptions: '{"output_format":"webp"}' }, profile)).toThrow("不支持 webp");
});

test("explicit selection adapts only the supplied draft; shared defaults and originals remain unchanged", () => {
    const beforeDefault = structuredClone(defaultConfig);
    const draft = { ...config, size: "3840x2160", quality: "max", count: "4", imageOptions: '{"resolution":"4k","background":"transparent","output_format":"webp","complexity":"high","layer_decomposition":"true"}' };
    const before = structuredClone(draft);
    const adapted = adaptImageModelSettings(draft, profile);
    expect(adapted).toMatchObject({ size: "16:9", quality: "auto", count: "1" });
    expect(JSON.parse(adapted.imageOptions)).toEqual({ resolution: "1k", background: "transparent", output_format: "png" });
    expect(draft).toEqual(before);
    expect(defaultConfig).toEqual(beforeDefault);
});

test("Doubao reference limits do not truncate or mutate original input", () => {
    const references = refs(11), before = structuredClone(references);
    expect(validateImageReferences(doubao.id, refs(10), profile).valid).toBe(true);
    expect(validateImageReferences(doubao.id, references, profile)).toMatchObject({ valid: false, maximum: 10 });
    expect(references).toEqual(before);
    expect(validateImageReferences(doubao.id, [{ ...refs(1)[0]!, bytes: 30 * 1024 * 1024 + 1 }], profile).valid).toBe(false);
    expect(validateImageReferences(doubao.id, [{ ...refs(1)[0]!, type: "image/avif" }], profile).valid).toBe(false);
});

test("public candidate name is Doubao in image lists, never text/video/audio, with Flare default preserved", () => {
    useBusinessConfigStore.setState({ models });
    expect(getModelPickerOptions(defaultConfig, "image", models, "server")).toEqual([flare.id, doubao.id]);
    for (const capability of ["text", "video", "audio"] as const) expect(getModelPickerOptions(defaultConfig, capability, models, "server")).toEqual([]);
    expect(resolveCapabilityModel({ ...defaultConfig, imageModel: flare.id }, "image", models)).toBe(flare.id);
    for (const role of ["designer", "admin"] as const) expect(imageModelDisplayName(doubao.id, models, role)).toBe("豆包生图");
    expect(canvasModelPresentation("豆包生图")).toMatchObject({ name: "豆包生图", family: "豆包" });
    expect(canvasImageModelDetails(profile, referencePolicyForModel(doubao.id, profile))).toEqual(["1K / 1.5K / 2K", "最多 10 张参考图"]);
    expect(filterChatImageModels(models).map(model => model.id)).toContain(doubao.id);
    expect(selectChatImageModel(doubao.id, { imageSize: "16:9", imageQuality: "high", imageResolution: "1.5k" })).toMatchObject({ imageModelId: doubao.id, imageSize: "16:9", imageQuality: "auto", imageResolution: "1.5k" });
    expect(chatImageQualitySettings(profile, "auto", "1.5k")).toMatchObject({ adjustable: false, independentResolution: true, resolution: "1.5k" });
});

test("standalone, canvas and primary UI share three tiers without a fake quality control", () => {
    const panel = renderToStaticMarkup(<ImageSettingsPanel config={config} profile={profile} theme={canvasThemes.light} onConfigChange={() => undefined} />);
    expect(panel).toContain('aria-label="清晰度 / 分辨率"');
    expect(panel).not.toContain('aria-label="图片质量"');
    expect(panel).not.toContain('aria-label="分辨率"');
    const quality = renderToStaticMarkup(<CanvasQuickQualityOptions config={config} profile={profile} referenceCount={1} onConfigChange={() => undefined} />);
    for (const resolution of ["1K", "1.5K", "2K"]) expect(quality).toContain(resolution);
    expect(quality).not.toContain("4K");
    const canvas = renderToStaticMarkup(<CanvasQuickSettingsPopovers config={config} profile={profile} referenceCount={1} theme={canvasThemes.dark} disabled={false} onConfigChange={() => undefined} />);
    expect(canvas).toContain('aria-label="清晰度 / 分辨率"');
    expect(canvas).toContain("1.5K");
    const primary = renderToStaticMarkup(<ImagePrimarySettings config={config} profile={profile} modelControl={<span>豆包生图</span>} onConfigChange={() => undefined} />);
    expect(primary).toContain("豆包生图");
    expect(primary).toContain("1.5K");
});

test("template editor keeps Doubao resolution, strips quality/layer values and restores its settings", () => {
    const original = { quality: "max", layer_decomposition: true, layer_decomposition_options: { max_images: 30 }, midjourneySpeed: "turbo", description: "用户原文" };
    const before = structuredClone(original);
    const merged = mergePromptEditorParameters(original, { size: "16:9", quality: "auto", imageOptions: '{"resolution":"1.5k","background":"transparent","output_format":"jpeg"}' }, profile);
    expect(merged).toMatchObject({ size: "16:9", resolution: "1.5k", background: "transparent", output_format: "png", n: 1, quantity: 1, description: "用户原文" });
    expect(JSON.parse(String(merged.imageOptions))).toMatchObject({ resolution: "1.5k", background: "transparent", output_format: "png" });
    for (const key of ["quality", "layer_decomposition", "layer_decomposition_options", "midjourneySpeed"]) expect(merged).not.toHaveProperty(key);
    expect(promptImageSettings(merged, doubao.id, models)).toMatchObject({ size: "16:9", quality: "auto", count: "1" });
    expect(original).toEqual(before);
});
