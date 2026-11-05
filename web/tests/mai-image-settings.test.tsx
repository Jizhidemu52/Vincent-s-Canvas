import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { CanvasQuickSettingsPopovers } from "@/components/canvas/canvas-quick-settings-popovers";
import { canvasThemes } from "@/lib/canvas-theme";
import { adaptImageModelSettings, imageModelProfile, imageModelSettingsError, imageReferenceSizeIsAutomatic, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageOptionFields, normalizeImageOptions } from "@/lib/image-advanced-settings";
import { imageTaskParameters } from "@/services/api/image";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { quickImageModelId } from "@/lib/quick-image-tools";
import { getModelPickerOptions } from "@/lib/model-picker-options";
import { selectChatImageModel, chatImageQualitySettings } from "@/pages/chat/image-quality";
import { resolveChatImageSize } from "@/pages/chat/image-size";
import { resolveAgentImageGenerationSettings, type AgentGenerationSettings } from "@/lib/agent-direct-generation";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { PublicModel } from "@/services/api/business-config";

const make = (id: string, kind: PublicModel["imageParameterProfile"], name = id): PublicModel => ({ id, modelId: id, name, publicName: name, imageParameterProfile: kind, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 });
const models = [make("opaque-gpt", "quality-resolution", "aplmart-gpt2.6-flare"), make("opaque-mai", "mai-image", "aplmart-mai2.6-flash"), make("opaque-nano", "resolution-1k"), make("opaque-grok", "grok-image")];
const mai = imageModelProfile("opaque-mai", models, "designer");
const previous = useBusinessConfigStore.getState();
afterEach(() => useBusinessConfigStore.setState(previous));
const config = { ...defaultConfig, model: "opaque-mai", imageModel: "opaque-mai", size: "16:9", quality: "auto", imageOptions: '{"resolution":"2k"}' };
const refs = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `ref-${index}`, name: `${index}.png`, type: "image/png", dataUrl: `data:image/png;base64,AA${index}` }));

test("opaque MAI profile exposes only documented modes and no quality, mask or format control", () => {
    expect(mai.kind).toBe("mai-image");
    expect(imageModelProfile("mai-image-2.6-flash", []).kind).toBe("mai-image");
    expect(mai.resolutions).toEqual(["1k", "2k"]);
    expect(mai.qualities).toEqual(["auto"]);
    expect(mai.supportsMask).toBe(false);
    expect(mai.backgrounds).toEqual([]);
    expect(mai.outputFormats).toEqual([]);
    expect(mai.sizes).toContain("1:4"); expect(mai.sizes).toContain("4:1"); expect(mai.sizes).not.toContain("8:1");
    expect(imageOptionFields(mai).map(field => field.key)).toEqual(["resolution", "web_grounding", "negative_prompt"]);
    expect(imageTaskParameters(config, mai)).toEqual({ size: "16:9", resolution: "2k" });
});

test("MAI custom pixels enforce 768px minimum and 2359296 total pixels but only recommend 32 alignment", () => {
    for (const size of ["768x768", "800x769", "1000x1000", "1025x1024", "1024x1024", "1536x1536", "3072x768", "768x3072", "16:9", "1:4", "auto"]) expect(imageModelSettingsError(size, mai)).toBe("");
    for (const size of ["767x1024", "512x1024", "1537x1536", "2048x2048", "3840x2160", "8:1", "wrong"]) expect(imageModelSettingsError(size, mai)).not.toBe("");
    expect(imageTaskParameters({ ...config, size: "1000x1000" }, mai)).toEqual({ size: "1000x1000", resolution: "2k" });
    expect(mai.sizeConstraintMessage).toContain("建议使用 32 的倍数");
    expect(mai.sizeConstraintMessage).toContain("实际输出宽高各向下取整");
    expect(normalizeImageModelSettings({ size: "2048x2048", quality: "auto", count: "1" }, mai).size).toBe("2048x2048");
    expect(adaptImageModelSettings({ size: "3840x2160", quality: "max", count: "3" }, mai)).toEqual({ size: "16:9", quality: "auto", count: "1", imageOptions: '{"resolution":"1k"}' });
});

test("explicit GPT 4K to MAI to Nano and Grok removes unsupported fields and retains valid explicit choices", () => {
    const old = { ...config, size: "3840x2160", quality: "max", count: "4", imageOptions: '{"resolution":"4k","background":"transparent","output_format":"webp","output_compression":"80","web_grounding":"true","negative_prompt":"text"}' };
    const snapshot = structuredClone(old);
    const next = adaptImageModelSettings(old, mai);
    expect(JSON.parse(next.imageOptions)).toEqual({ resolution: "1k", web_grounding: "true", negative_prompt: "text" });
    expect(imageTaskParameters({ ...old, ...next }, mai)).toEqual({ size: "16:9", resolution: "1k", web_grounding: true, negative_prompt: "text" });
    const nano = imageModelProfile("opaque-nano", models);
    const nanoSettings = adaptImageModelSettings(next, nano);
    expect(JSON.parse(nanoSettings.imageOptions)).toEqual({ negative_prompt: "text" });
    expect(imageTaskParameters({ ...old, ...nanoSettings }, nano)).toEqual({ size: "16:9", resolution: "1k", negative_prompt: "text" });
    const grok = imageModelProfile("opaque-grok", models);
    const grokSettings = adaptImageModelSettings({ ...next, quality: "high" }, grok);
    expect(imageTaskParameters({ ...old, ...grokSettings }, grok)).toEqual({ size: "16:9", resolution: "1k", quality: "medium", negative_prompt: "text" });
    const explicit = adaptImageModelSettings({ ...config, size: "1536x1024", imageOptions: '{"resolution":"2k","web_grounding":"false"}' }, mai);
    expect(explicit.size).toBe("1536x1024");
    expect(JSON.parse(explicit.imageOptions)).toEqual({ resolution: "2k", web_grounding: "false" });
    expect(old).toEqual(snapshot);
});

test("adding and removing MAI references changes only request shape, not text-only preferences", () => {
    const selected = { ...config, imageOptions: '{"resolution":"2k","web_grounding":"true","quality":"max","width":"2048","height":"2048","style":"vivid","output_format":"jpeg"}' };
    const snapshot = structuredClone(selected);
    expect(imageReferenceSizeIsAutomatic(mai, 0)).toBe(false);
    expect(imageReferenceSizeIsAutomatic(mai, 1)).toBe(true);
    expect(imageTaskParameters(selected, mai, { referenceCount: 0 })).toEqual({ size: "16:9", resolution: "2k", web_grounding: true });
    for (const count of [1, 5]) expect(imageTaskParameters({ ...selected, size: "3840x2160" }, mai, { referenceCount: count })).toEqual({ web_grounding: true });
    expect(imageTaskParameters(selected, mai, { referenceCount: 0 })).toEqual({ size: "16:9", resolution: "2k", web_grounding: true });
    expect(selected).toEqual(snapshot);
    const references = refs(6); const before = structuredClone(references);
    expect(validateImageReferences("opaque-mai", refs(5), mai).valid).toBe(true);
    expect(validateImageReferences("opaque-mai", references, mai)).toMatchObject({ valid: false, maximum: 5 });
    expect(references).toEqual(before);
});

test("submission rejects invalid active-model options; only explicit selection adapts old values", () => {
    expect(() => imageTaskParameters({ ...config, imageOptions: '{"resolution":"4k"}' }, mai)).toThrow("不支持 4k");
    expect(() => imageTaskParameters({ ...config, imageOptions: '{"web_grounding":"yes"}' }, mai)).toThrow("必须为开或关");
    expect(() => imageTaskParameters({ ...config, imageOptions: '{"output_format":"gif"}' }, imageModelProfile("opaque-gpt", models))).toThrow("不支持 gif");
    expect(imageTaskParameters({ ...config, imageOptions: '{"resolution":"4k","web_grounding":"false"}' }, mai, { referenceCount: 1 })).toEqual({ web_grounding: false });
});

test("standalone and canvas MAI controls make model-determined edit dimensions visible", () => {
    const render = (referenceCount: number) => renderToStaticMarkup(<ImageSettingsPanel config={config} profile={mai} referenceCount={referenceCount} theme={canvasThemes.light} onConfigChange={() => undefined} />);
    const generate = render(0), edit = render(1), restored = render(0);
    expect(generate).toContain('aria-label="清晰度 / 分辨率"');
    expect(generate).not.toContain('aria-label="图片质量"');
    expect(generate).toContain("2K"); expect(generate).not.toContain('value="4k"');
    expect(edit).toContain("约 100 万像素");
    expect(edit).not.toContain('aria-label="清晰度 / 分辨率"');
    expect(edit).not.toContain('aria-label="自定义宽度"');
    expect(restored).toBe(generate);
    const canvas = renderToStaticMarkup(<CanvasQuickSettingsPopovers config={config} profile={mai} referenceCount={1} disabled={false} theme={canvasThemes.light} onConfigChange={() => undefined} />);
    expect(canvas).toContain("模型决定尺寸"); expect(canvas).toContain("约 100 万像素");
    expect(canvas).toMatch(/disabled="" aria-label="宽高比"/);
});

test("chat and agent MAI references do not perform irrelevant source-size validation", async () => {
    useBusinessConfigStore.setState({ models });
    const selected = selectChatImageModel("opaque-mai", { imageSize: "3840x2160", imageQuality: "max", imageResolution: "4k" });
    expect(selected).toEqual({ imageModelId: "opaque-mai", imageSize: "16:9", imageQuality: "auto", imageResolution: "1k" });
    expect(chatImageQualitySettings(mai, "auto", "2k")).toMatchObject({ quality: "auto", resolution: "2k", adjustable: false, independentResolution: true });
    const shouldNotRead = async () => { throw new Error("Editing must not measure a fixed MAI output size"); };
    expect(await resolveChatImageSize(config, "3840x2160", "edit", refs(1)[0], () => undefined, shouldNotRead)).toBe("auto");
    const settings = { mode: "image", imageModel: "opaque-mai", videoModel: "", size: "16:9", requestedImageSize: "3840x2160", quality: "auto", imageOptions: '{"resolution":"2k"}', imageCount: "1", videoSeconds: "5", videoQuality: "720p", afterImage: "images_only" } as AgentGenerationSettings;
    const snapshot = structuredClone(settings);
    await expect(resolveAgentImageGenerationSettings(settings, refs(1), "ref-0", mai, () => undefined, shouldNotRead)).resolves.toMatchObject({ size: "16:9", imageOptions: '{"resolution":"2k"}' });
    expect(settings).toEqual(snapshot);
});

test("new defaults prefer Flare 2.6 without forcing selection and quick actions use separate server models", () => {
    const order = getModelPickerOptions(defaultConfig, "image", [models[1]!, models[2]!, models[0]!], "server");
    expect(order).toEqual(["opaque-gpt", "opaque-mai", "opaque-nano"]);
    expect(quickImageModelId("remove-background")).toBe("mai-image-2.6-flash");
    expect(quickImageModelId("hd-upscale")).toBe("gemini-nano-banana-2.1");
    expect(JSON.parse(normalizeImageOptions('{"resolution":"4k","google_image_search":"true","web_grounding":"false"}', mai))).toEqual({ resolution: "1k", web_grounding: "false" });
});
