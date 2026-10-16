import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { imageModelProfile, imageModelSettingsError, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageTaskParameters } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";

test("new configurations retain the configured image catalog and prefer the APIMart GPT2 alias", () => {
    const models = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-3.1-flash-image"];
    expect(defaultConfig.imageModels).toEqual(models.map(model => `default::${model}`));
    for (const model of models) {
        expect(defaultConfig.channels[0]!.models).toContain(model);
        expect(defaultConfig.models).toContain(`default::${model}`);
    }
    expect(defaultConfig.model).toBe("aplmart-gpt2");
    expect(defaultConfig.imageModel).toBe(defaultConfig.model);
    expect(defaultConfig.quality).toBe("high");
});

test("configured image models expose only their adapter's supported options", () => {
    for (const model of ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
        const profile = imageModelProfile(model, []);
        expect(profile.qualityLabel).toBe("画质");
        expect(profile.sizes).toEqual(["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840", "2880x2880", "auto"]);
        expect(profile.customSize).toBe(true);
        expect(imageTaskParameters({ ...defaultConfig, model, size: "auto", quality: "auto" })).toEqual({ size: "auto", quality: "auto" });
    }
    expect(imageModelProfile("vcen-gpt2", []).qualities).toEqual(["1k", "2k", "4k"]);
    expect(imageModelProfile("gemini-3.1-flash-image-preview", []).qualities).toEqual(["0.5k", "1k", "2k", "4k"]);
    expect(imageModelProfile("midjourney", []).maxCount).toBe(1);
    expect(imageModelProfile("midjourney-blend", []).requiresPrompt).toBe(false);
    expect(imageModelProfile("gemini-3.1-flash-image", []).verified).toBe(false);
    expect(imageModelProfile("vcen-gpt2", []).sizes).not.toContain("1:8");
    expect(imageModelProfile("gemini-3.1-flash-image-preview", []).sizes).not.toContain("3:1");
    expect(imageTaskParameters({ ...defaultConfig, model: "gemini-3.1-flash-image" })).toEqual({});
});

test("custom dimensions stay editable while validation catches invalid GPT size constraints", () => {
    const profile = imageModelProfile("gpt-image-2", []);
    for (const size of ["640x1024", "2880x2880", "3840x2160", "1152x2048", "1536x864"]) expect(imageModelSettingsError(size, profile)).toBe("");
    for (const size of ["512x512", "1025x1024", "4096x2048", "3840x3840", "3072x768", "wrong"]) expect(imageModelSettingsError(size, profile)).not.toBe("");
    expect(normalizeImageModelSettings({ size: "1025x1024", quality: "high", count: "1" }, profile).size).toBe("1025x1024");
    for (const [size, expected] of [["16:9", "1536x864"], ["9:16", "864x1536"], ["4:3", "1536x1152"], ["3:4", "1152x1536"]]) {
        expect(imageModelSettingsError(size!, profile)).toBe("");
        expect(normalizeImageModelSettings({ size: size!, quality: "high", count: "1" }, profile).size).toBe(expected!);
    }
    const mj = imageModelProfile("midjourney", []);
    expect(mj.customAspect).toBe(true);
    expect(normalizeImageModelSettings({ size: "7:5", quality: "fast", count: "1" }, mj).size).toBe("7:5");
    expect(imageModelProfile("gemini-3.1-flash-image-preview", []).customAspect).toBe(false);
});

test("server capability metadata wins over name heuristics and aliases resolve consistently", () => {
    const model = { id: "configured-id", name: "设计专用", modelId: "gpt-image-2", capabilities: ["generate"], creditCost: 0, rmbCost: 0, imageParameterProfile: "gpt" as const };
    expect(imageModelProfile("设计专用", [model]).kind).toBe("gpt");
    expect(imageModelProfile("configured-id", [model]).kind).toBe("gpt");
});

test("opaque public profiles preserve every model parameter capability", () => {
    const profiles = [
        ["standard-flex", "gpt-image-2"], ["standard-flex-plus", "gpt-image-2.5-flare"], ["pixel", "vcen-gpt2"], ["resolution", "gemini-3.1-flash-image-preview"],
        ["speed", "midjourney"], ["blend", "midjourney-blend"], ["unverified", "gemini-3.1-flash-image"],
    ] as const;
    for (const [imageParameterProfile, original] of profiles) {
        const model = { id: "opaque-config-id", modelId: "opaque-config-id", name: "出图模型1", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0, imageParameterProfile };
        expect(imageModelProfile(model.id, [model], "designer")).toEqual(imageModelProfile(original, [], "designer"));
    }
});

test("opaque configured models retain pixel resolution and speed request payloads", () => {
    const saved = useBusinessConfigStore.getState().models;
    try {
        const cases = [
            { profile: "pixel" as const, size: "1280x960", quality: "2k", expected: { size: "1280x960", resolution: "2k" } },
            { profile: "resolution" as const, size: "4:3", quality: "0.5k", expected: { size: "4:3", resolution: "0.5k" } },
            { profile: "speed" as const, size: "16:9", quality: "turbo", expected: { size: "16:9", midjourneySpeed: "turbo" } },
        ];
        for (const item of cases) {
            useBusinessConfigStore.setState({ models: [{ id: "opaque-config-id", modelId: "opaque-config-id", name: "出图模型1", capabilities: ["generate"], creditCost: 0, rmbCost: 0, imageParameterProfile: item.profile }] });
            expect(imageTaskParameters({ ...defaultConfig, model: "opaque-config-id", size: item.size, quality: item.quality })).toEqual(item.expected);
        }
    } finally { useBusinessConfigStore.setState({ models: saved }); }
});

test("only administrators receive branded guidance and model documentation", () => {
    for (const model of ["gpt-image-2", "vcen-gpt2", "gemini-3.1-flash-image-preview", "midjourney", "midjourney-blend"]) {
        const designer = imageModelProfile(model, [], "designer");
        expect(designer.documentationUrl).toBe("");
        expect(designer.tip).not.toMatch(/GPT|Gemini|Midjourney|\bMJ\b|APIMart|OpenAI/i);
        for (const role of ["super_admin", "department_admin"] as const) expect(imageModelProfile(model, [], role).documentationUrl).toStartWith("https://docs.");
    }
    expect(imageModelProfile("midjourney", [], "super_admin").tip).toContain("MJ");
});

test("changing models resets unsupported quality, dimensions and output counts", () => {
    const initial = { ...defaultConfig, quality: "0.5k", size: "21:9", count: "10" };
    expect(normalizeImageModelSettings(initial, imageModelProfile("gpt-image-2", []))).toEqual({ quality: "auto", size: "1024x1024", count: "1" });
    expect(normalizeImageModelSettings(initial, imageModelProfile("midjourney-blend", []))).toEqual({ quality: "relax", size: "21:9", count: "1" });
});

test("actual image task payloads preserve ultrawide, custom size, Gemini half-K and Midjourney speed", () => {
    expect(imageTaskParameters({ ...defaultConfig, model: "gpt-image-2", size: "auto", quality: "auto" })).toEqual({ size: "auto", quality: "auto" });
    expect(imageTaskParameters({ ...defaultConfig, model: "vcen-gpt2", size: "21:9", quality: "4k" })).toEqual({ size: "21:9", resolution: "4k" });
    expect(imageTaskParameters({ ...defaultConfig, model: "vcen-gpt2", size: "1280x960", quality: "2k" })).toEqual({ size: "1280x960", resolution: "2k" });
    expect(imageTaskParameters({ ...defaultConfig, model: "gemini-3.1-flash-image-preview", size: "4:3", quality: "0.5k" })).toEqual({ size: "4:3", resolution: "0.5k" });
    expect(imageTaskParameters({ ...defaultConfig, model: "midjourney", size: "16:9", quality: "turbo" })).toEqual({ size: "16:9", midjourneySpeed: "turbo" });
});

test("shared node and image-page settings render model-specific controls without fake resolutions", () => {
    const render = (model: string) => renderToStaticMarkup(<ImageSettingsPanel config={{ ...defaultConfig, model }} theme={canvasThemes.light} onConfigChange={() => undefined} />);
    const openai = render("gpt-image-2");
    expect(openai).toContain("画质");
    expect(openai).toContain("自适应");
    expect(openai).toContain("仅影响下次 AI 生成，不改变已有图片");
    expect(openai).not.toContain("0.5K");
    expect(openai).toContain("16倍数对齐");
    expect(render("vcen-gpt2")).toContain("16倍数对齐");
    expect(render("gemini-3.1-flash-image-preview")).toContain("0.5K");
    const midjourney = render("midjourney-blend");
    expect(midjourney).toContain("生成速度");
    expect(midjourney).not.toContain("2 张");
});

test("flexible image profiles retain legal custom sizes and extended quality without widening other models", () => {
    const flare = imageModelProfile("gpt-image-2.5-flare", []);
    expect(flare.qualities).toEqual(["auto", "max", "xhigh", "high", "medium", "low"]);
    expect(flare.outputFormats).toEqual(["png", "jpeg", "webp"]);
    expect(flare.backgrounds).toEqual(["auto", "opaque", "transparent"]);
    expect(flare.outputCompression).toBe(true);
    expect(normalizeImageModelSettings({ size: "1536x864", quality: "max", count: "2" }, flare)).toEqual({ size: "1536x864", quality: "max", count: "1" });
    expect(imageModelProfile("gpt-image-2", []).qualities).not.toContain("xhigh");
    expect(imageModelProfile("gpt-image-1", []).customSize).toBe(false);
    expect(imageModelProfile("gemini-3.1-flash-image", []).outputFormats).toEqual([]);
});
