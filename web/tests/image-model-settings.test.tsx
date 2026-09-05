import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageTaskParameters } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { ImageSettingsPanel } from "@/components/image-settings-panel";

test("the six configured image models expose only their adapter's supported options", () => {
    for (const model of ["gpt-image-2"]) {
        const profile = imageModelProfile(model, []);
        expect(profile.qualityLabel).toBe("画质");
        expect(profile.sizes).toEqual(["1024x1024", "1536x1024", "1024x1536"]);
        expect(profile.customSize).toBe(false);
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

test("server capability metadata wins over name heuristics and aliases resolve consistently", () => {
    const model = { id: "configured-id", name: "设计专用", modelId: "gpt-image-2", capabilities: ["generate"], creditCost: 0, rmbCost: 0, imageParameterProfile: "gpt" as const };
    expect(imageModelProfile("设计专用", [model]).kind).toBe("gpt");
    expect(imageModelProfile("configured-id", [model]).kind).toBe("gpt");
});

test("changing models resets unsupported quality, dimensions and output counts", () => {
    const initial = { ...defaultConfig, quality: "0.5k", size: "21:9", count: "10" };
    expect(normalizeImageModelSettings(initial, imageModelProfile("gpt-image-2", []))).toEqual({ quality: "auto", size: "1024x1024", count: "10" });
    expect(normalizeImageModelSettings(initial, imageModelProfile("midjourney-blend", []))).toEqual({ quality: "relax", size: "21:9", count: "1" });
});

test("actual image task payloads preserve ultrawide, custom size, Gemini half-K and Midjourney speed", () => {
    expect(imageTaskParameters({ ...defaultConfig, model: "vcen-gpt2", size: "21:9", quality: "4k" })).toEqual({ size: "21:9", resolution: "4k" });
    expect(imageTaskParameters({ ...defaultConfig, model: "vcen-gpt2", size: "1280x960", quality: "2k" })).toEqual({ size: "1280x960", resolution: "2k" });
    expect(imageTaskParameters({ ...defaultConfig, model: "gemini-3.1-flash-image-preview", size: "4:3", quality: "0.5k" })).toEqual({ size: "4:3", resolution: "0.5k" });
    expect(imageTaskParameters({ ...defaultConfig, model: "midjourney", size: "16:9", quality: "turbo" })).toEqual({ size: "16:9", midjourneySpeed: "turbo" });
});

test("shared node and image-page settings render model-specific controls without fake resolutions", () => {
    const render = (model: string) => renderToStaticMarkup(<ImageSettingsPanel config={{ ...defaultConfig, model }} theme={canvasThemes.light} onConfigChange={() => undefined} />);
    const openai = render("gpt-image-2");
    expect(openai).toContain("画质");
    expect(openai).not.toContain("0.5K");
    expect(openai).not.toContain("16倍数对齐");
    expect(render("vcen-gpt2")).toContain("16倍数对齐");
    expect(render("gemini-3.1-flash-image-preview")).toContain("0.5K");
    const midjourney = render("midjourney-blend");
    expect(midjourney).toContain("生成速度");
    expect(midjourney).not.toContain("2 张");
});
