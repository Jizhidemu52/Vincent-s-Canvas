import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { imageAdvancedParameters, imageOptionFields } from "@/lib/image-advanced-settings";
import { imageModelProfile } from "@/lib/image-model-settings";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { imageTaskParameters } from "@/services/api/image";
import { generationDraftInput } from "@/services/api/generation-history";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { canvasThemes } from "@/lib/canvas-theme";

const before = useBusinessConfigStore.getState();
afterEach(() => useBusinessConfigStore.setState(before));
const options = (value: Record<string, string>) => JSON.stringify(value);

test("new defaults resolve APIMart GPT2 even when employee-facing IDs are opaque; explicit choices remain", () => {
    const models = [{ id: "old", modelId: "old", publicName: "gpt-image-2", capabilities: ["generate"] }, { id: "fine", modelId: "fine", publicName: "aplmart-gpt2", capabilities: ["generate"] }];
    expect(defaultConfig.quality).toBe("high");
    expect(resolveCapabilityModel(defaultConfig, "image", models)).toBe("fine");
    expect(resolveCapabilityModel(defaultConfig, "image", models, "old")).toBe("old");
    expect(resolveCapabilityModel({ ...defaultConfig, imageModel: "old" }, "image", models)).toBe("old");
});

test("GPT 2 and 2.5 selected size, quality and advanced values reach task and archived draft", () => {
    useBusinessConfigStore.setState({ models: [] });
    for (const model of ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
        const config = { ...defaultConfig, model, size: "3840x2160", quality: model === "gpt-image-2" ? "high" : "max", imageOptions: options({ background: "opaque", output_format: "webp", output_compression: "97" }) };
        expect(imageTaskParameters(config)).toEqual({ size: "3840x2160", quality: config.quality, background: "opaque", output_format: "webp", output_compression: 97 });
        expect(generationDraftInput(config, "cloth").config.imageOptions).toBe(config.imageOptions);
    }
});

test("PNG does not submit compression and other-model settings do not leak into a request", () => {
    const value = options({ output_format: "png", output_compression: "95", google_search: "true", seed: "42" });
    expect(imageAdvancedParameters(value, imageModelProfile("gpt-image-2", []))).toEqual({ output_format: "png" });
    expect(imageAdvancedParameters(value, imageModelProfile("gemini-3.1-flash-image", []))).toEqual({});
});

test("APIMart Gemini, GPT and MJ options remain typed and image search implies text search", () => {
    expect(imageAdvancedParameters(options({ nsfw_check: "false", official_fallback: "true" }), { kind: "gpt" })).toEqual({ nsfw_check: false, official_fallback: true });
    expect(imageAdvancedParameters(options({ google_image_search: "true" }), { kind: "gemini" })).toEqual({ google_image_search: true, google_search: true });
    expect(imageAdvancedParameters(options({ quality: "2", seed: "0", iw: "1.5", tile: "true", metadata: '{"job":"cloth"}' }), { kind: "midjourney" })).toEqual({ midjourneyQuality: "2", seed: 0, iw: 1.5, tile: true, metadata: { job: "cloth" } });
    expect(imageOptionFields({ kind: "midjourney-blend" }).map(field => field.key)).not.toContain("quality");
});

test("invalid numeric, boolean and metadata input is rejected instead of silently discarded", () => {
    for (const value of [{ seed: "-1" }, { chaos: "101" }, { stop: "9" }, { tile: "yes" }, { metadata: "[]" }, { metadata: "no" }]) expect(() => imageAdvancedParameters(options(value), { kind: "midjourney" })).toThrow();
});

test("MJ single-image settings omit repeat while retaining every other advanced field", () => {
    const profile = imageModelProfile("midjourney", []);
    expect(imageOptionFields(profile).map(field => field.key)).toEqual([
        "nsfw_check", "quality", "version", "style", "seed", "negative_prompt", "stylize", "chaos", "weird",
        "tile", "niji", "raw", "draft", "hd", "iw", "cw", "sw", "cref", "sref", "dref", "dw", "stop", "extra", "metadata",
    ]);
    const imageOptions = options({ repeat: "40", seed: "42", stop: "50", metadata: '{"job":"cloth"}' });
    expect(imageAdvancedParameters(imageOptions, profile)).toEqual({ seed: 42, stop: 50, metadata: { job: "cloth" } });
    const html = renderToStaticMarkup(<ImageSettingsPanel profile={profile} config={{ ...defaultConfig, model: "midjourney", count: "9", imageOptions }} theme={canvasThemes.light} onConfigChange={() => {}} />);
    expect(html).not.toContain("repeat");
    expect(html).not.toContain("重复生成");
    expect(html).toContain("1 个任务");
    for (const label of ["随机种子", "提前停止 --stop", "其他原生参数", "任务附加信息 JSON"]) expect(html).toContain(label);
});

test("shared settings renders real quality names and all documented advanced fields", () => {
    useBusinessConfigStore.setState({ models: [] });
    const html = renderToStaticMarkup(<ImageSettingsPanel config={{ ...defaultConfig, model: "gpt-image-2.5-sunburst" }} theme={canvasThemes.light} onConfigChange={() => {}} />);
    for (const label of ["max", "xhigh", "high", "3840x2160", "background", "output_format", "output_compression", "全部高级参数"]) expect(html).toContain(label);
});
