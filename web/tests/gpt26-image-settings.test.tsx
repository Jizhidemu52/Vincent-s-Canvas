import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { adaptImageModelSettings, imageModelProfile, imageModelSettingsError, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageAdvancedParameters, imageMarkupReference, imageOptionFields } from "@/lib/image-advanced-settings";
import { imageTaskParameters } from "@/services/api/image";
import { collectImageStorageKeys } from "@/services/image-storage";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import type { PublicModel } from "@/services/api/business-config";

const previous = useBusinessConfigStore.getState();
afterEach(() => useBusinessConfigStore.setState(previous));
const model = (id: string, profile: PublicModel["imageParameterProfile"]): PublicModel => ({ id, modelId: id, name: id, imageParameterProfile: profile, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 });
const models = [model("opaque-26", "quality-resolution-v2"), model("opaque-25", "quality-resolution"), model("opaque-mai", "mai-image")];
const profile = imageModelProfile("opaque-26", models, "designer");
const settings = (options: Record<string, string>, size = "512x512") => ({ ...defaultConfig, model: "opaque-26", size, quality: "high", imageOptions: JSON.stringify(options) });
const markup = { id: "markup-1", name: "独立标注.png", type: "image/png", dataUrl: "blob:original", storageKey: "image:markup-original", bytes: 100 };

test("opaque GPT 2.6 capabilities are distinct from 2.5 and exclude SVG", () => {
    expect(profile.kind).toBe("quality-resolution");
    expect(profile.qualities).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(profile.resolutions).toEqual(["1k", "2k", "4k"]);
    expect(profile.sizes).toHaveLength(16);
    expect(profile.outputFormats).toEqual(["png", "jpeg", "webp", "gif"]);
    expect(imageOptionFields(profile).map(field => field.key)).toEqual(expect.arrayContaining(["moderation", "complexity", "markup_reference", "frame_count", "frame_duration_ms"]));
    const older = imageModelProfile("opaque-25", models);
    expect(older.outputFormats).toEqual(["png", "jpeg", "webp"]);
    expect(imageOptionFields(older).map(field => field.key)).toContain("moderation");
    for (const field of ["complexity", "markup_reference", "frame_count", "frame_duration_ms"]) expect(imageOptionFields(older).some(item => item.key === field)).toBe(false);
});

test("GIF uses single-frame pixel validation and submits typed frame values without static resolution/compression", () => {
    const config = settings({ output_format: "gif", resolution: "4k", frame_count: "16", frame_duration_ms: "120", output_compression: "88", complexity: "medium", moderation: "auto" });
    expect(imageModelSettingsError(config.size, profile, config.imageOptions)).toBe("");
    expect(imageTaskParameters(config, profile)).toEqual({ size: "512x512", quality: "high", output_format: "gif", frame_count: 16, frame_duration_ms: 120, complexity: "medium", moderation: "auto" });
    expect(normalizeImageModelSettings(config, profile).size).toBe("512x512");
    for (const [size, count] of [["1024x1024", "2"], ["768x768", "16"], ["512x512", "17"], ["1:1", "9"], ["513x512", "9"]]) {
        expect(() => imageTaskParameters(settings({ output_format: "gif", frame_count: count! }, size), profile)).toThrow();
    }
    for (const duration of ["10", "25", "20.5", "Infinity"]) expect(() => imageTaskParameters(settings({ output_format: "gif", frame_duration_ms: duration }), profile)).toThrow();
    expect(imageTaskParameters(settings({ output_format: "gif", frame_count: "12" }, "768x768"), profile)).toMatchObject({ size: "768x768", frame_count: 12 });
});

test("GIF rejects references, masks and markup before submission; static output never forwards frame fields", () => {
    const config = settings({ output_format: "gif" });
    for (const options of [{ referenceCount: 1 }, { mask: true }]) expect(() => imageTaskParameters(config, profile, options)).toThrow("GIF");
    expect(() => imageTaskParameters(settings({ output_format: "gif", markup_reference: JSON.stringify(markup) }), profile, { referenceCount: 1 })).toThrow("GIF");
    expect(() => imageTaskParameters(settings({ output_format: "gif", background: "transparent" }), profile)).toThrow("透明");
    expect(imageAdvancedParameters(JSON.stringify({ output_format: "png", frame_count: "99", frame_duration_ms: "1", complexity: "high" }), profile)).toEqual({ output_format: "png", complexity: "high" });
});

test("markup metadata remains local and requires a reference while rejecting arbitrary external URLs and masks", () => {
    const options = { markup_reference: JSON.stringify(markup), moderation: "low", complexity: "low" };
    expect(imageMarkupReference(JSON.stringify(options))).toEqual(markup);
    expect(imageTaskParameters(settings(options, "1:1"), profile, { referenceCount: 1 })).toEqual({ size: "1:1", quality: "high", resolution: "1k", moderation: "low", complexity: "low" });
    expect(() => imageTaskParameters(settings(options, "1:1"), profile)).toThrow("需要至少一张参考图");
    expect(() => imageTaskParameters(settings(options, "1:1"), profile, { referenceCount: 1, mask: true })).toThrow("不能同时");
    expect(() => imageMarkupReference(JSON.stringify({ markup_reference: JSON.stringify({ ...markup, storageKey: undefined, dataUrl: "https://untrusted.test/overlay.png" }) }))).toThrow("不能直接填写外部地址");
});

test("model changes remove unsupported 2.6 controls and markup while preserving a valid explicit static size", () => {
    const config = settings({ output_format: "gif", markup_reference: JSON.stringify(markup), frame_count: "12", complexity: "high", moderation: "auto" });
    const adapted = adaptImageModelSettings(config, imageModelProfile("opaque-25", models));
    expect(JSON.parse(adapted.imageOptions)).toEqual({ moderation: "auto", resolution: "1k" });
    expect(imageModelSettingsError(adapted.size, imageModelProfile("opaque-25", models))).toBe("");
    expect(adaptImageModelSettings(settings({ output_format: "webp", complexity: "low" }, "1600x1200"), imageModelProfile("opaque-25", models)).size).toBe("1600x1200");
});

test("shared settings show GIF-only fields and safe PNG upload, with no SVG or mistaken resolution tier", () => {
    const gif = renderToStaticMarkup(<ImageSettingsPanel profile={profile} config={settings({ output_format: "gif" })} theme={canvasThemes.light} referenceCount={0} onConfigChange={() => {}} spacious />);
    for (const text of ["GIF 帧数", "GIF 每帧时长", "512x512", "规划强度", "内容审核强度"]) expect(gif).toContain(text);
    expect(gif).not.toContain('aria-label="清晰度 / 分辨率"');
    expect(gif).not.toContain('value="svg"');
    expect(gif).not.toContain('value="transparent"');
    expect(gif).not.toContain("在需要时转换");
    expect(gif).toContain("保留渠道原始 GIF 动画");
    const staticHtml = renderToStaticMarkup(<ImageSettingsPanel profile={profile} config={settings({ output_format: "png" }, "1:1")} theme={canvasThemes.light} referenceCount={1} uploadContextKey="draft:one|ref:one" onConfigChange={() => {}} />);
    expect(staticHtml).toContain('aria-label="上传独立透明 PNG 标注层"');
    expect(staticHtml).not.toContain("GIF 帧数");
});

test("surfaces without stable upload scope never expose an unsupported markup upload", () => {
    const html = renderToStaticMarkup(<ImageSettingsPanel profile={profile} config={settings({ output_format: "png" }, "1:1")} theme={canvasThemes.light} referenceCount={1} onConfigChange={() => {}} spacious />);
    expect(html).not.toContain('aria-label="上传独立透明 PNG 标注层"');
});

test("MAI accepts every documented integer ratio in range and rejects unsupported ratios", () => {
    const mai = imageModelProfile("opaque-mai", models);
    expect(mai.customAspect).toBe(true);
    for (const size of ["7:5", "5:7", "1:4", "4:1"]) {
        expect(normalizeImageModelSettings({ ...defaultConfig, size }, mai).size).toBe(size);
        expect(imageModelSettingsError(size, mai)).toBe("");
        expect(imageTaskParameters({ ...defaultConfig, size }, mai)).toMatchObject({ size });
    }
    expect(imageModelSettingsError("5:1", mai)).not.toBe("");
});

test("markup stored inside imageOptions remains protected from cleanup, ignoring unrelated JSON strings", () => {
    const document = { nodes: [{ metadata: { imageOptions: JSON.stringify({ markup_reference: JSON.stringify(markup) }) } }], prompt: JSON.stringify({ storageKey: "image:not-media" }) };
    expect([...collectImageStorageKeys(document)]).toEqual(["image:markup-original"]);
    expect([...collectImageStorageKeys({ imageOptions: "broken", other: JSON.stringify(markup) })]).toEqual([]);
});
