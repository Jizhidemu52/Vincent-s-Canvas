import { expect, test } from "bun:test";
import { buildApiMartImageRequest } from "../src/apimart-image";
import { imageAdmissionParameters } from "../src/image-admission-defaults";
import { imageComplexityForTool } from "../../shared/image-complexity";

const defaults = { quality: "medium", complexity: "low" } as const;
const flare = { modelId: "gpt-image-2.6-flare", protocol: "apimart" };
const sourceDataUrls = ["https://example.com/owned.png"];
const payload = (parameters: Record<string, unknown>, toolKey: string) => buildApiMartImageRequest({ ...flare, prompt: "保留款式", sourceDataUrls,
    parameters: imageAdmissionParameters(parameters, flare, toolKey, true, defaults) }).payload;

test("native editing follows the reference without a size key; composition tasks retain their own planning default", () => {
    for (const key of ["canvas-edit", "creative-local-restyle", "creative-garment-colorway"]) {
        for (const parameters of [{}, { quality: "auto", size: "follow" }]) {
            const request = payload(parameters, key);
            expect(request).toMatchObject({ quality: "medium", complexity: "low" });
            expect(request).not.toHaveProperty("size");
        }
    }
    for (const key of ["creative-text-to-style", "creative-virtual-try-on", "creative-back-design"])
        expect(payload({}, key).complexity).toBe("medium");
    expect(imageComplexityForTool("unspecified-tool", "high")).toBe("high");
    expect(payload({ quality: "high", complexity: "high", size: "3:4" }, "canvas-edit")).toMatchObject({ quality: "high", complexity: "high", size: "3:4" });
});

test("rollout off, other protocols and workflows stay unchanged; Nano receives no GPT-only fields", () => {
    const original = Object.freeze({ size: "1:1", quality: "auto" });
    expect(imageAdmissionParameters(original, flare, "canvas-edit", true)).toBe(original);
    for (const target of [{ ...flare, protocol:"openai" }, { ...flare, workflowConfigId:"wrapped" }, { ...flare, modelId:"seedream-5-5" }])
        expect(imageAdmissionParameters(original, target, "canvas-edit", true, defaults)).toBe(original);
    expect(imageAdmissionParameters({ size:"follow" }, { ...flare, modelId: "gemini-nano-banana-2.1" }, "canvas-edit", true, defaults)).toEqual({});
    expect(() => imageAdmissionParameters({size:"follow"}, flare, "image", false, defaults)).toThrow("跟随原图需要参考图");
});
