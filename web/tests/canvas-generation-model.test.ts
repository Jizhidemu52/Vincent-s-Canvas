import { expect, test } from "bun:test";
import { resolveCanvasImageConfig } from "@/lib/canvas/canvas-generation-model";
import type { BusinessConfig, PublicModel, PublicToolConfiguration } from "@/services/api/business-config";
import { defaultConfig } from "@/stores/use-config-store";

const models: PublicModel[] = [
    { id: "gpt", modelId: "gpt-image-2", name: "GPT", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "blend", modelId: "opaque-blend", name: "Blend", imageParameterProfile: "blend", capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
];
const binding = (toolKey: string, modelConfigId: string | null, enabled = true): PublicToolConfiguration => ({ toolKey, modelConfigId, enabled, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 });
const business = (tools: PublicToolConfiguration[] = []): BusinessConfig => ({ models, tools, prices: [] });
const config = (model: string) => ({ ...defaultConfig, model, imageModel: model });

test("unbound image selections retain their model and adapter-specific route", () => {
    expect(resolveCanvasImageConfig(config("gpt-image-2"), business(), true)).toMatchObject({ config: { model: "gpt-image-2" }, toolKey: "canvas-edit", isBound: false });
    expect(resolveCanvasImageConfig(config("opaque-blend"), business(), true)).toMatchObject({ config: { model: "opaque-blend" }, toolKey: "canvas-image" });
    expect(resolveCanvasImageConfig(config("gpt-image-2"), business(), false).toolKey).toBe("canvas-image");
});

test("stale or incompatible saved models resolve against the current image catalog", () => {
    const current = { ...business(), models: [models[0], { ...models[0], id: "text", modelId: "text-only", capabilities: ["chat"] }] };
    for (const saved of ["deleted-blend", "text-only"]) {
        expect(resolveCanvasImageConfig(config(saved), current, true)).toMatchObject({ config: { model: "gpt-image-2", imageModel: "gpt-image-2" }, toolKey: "canvas-edit" });
    }
});

test("a saved Blend selection converges through both GPT-bound image boards", () => {
    const source = config("opaque-blend");
    const result = resolveCanvasImageConfig(source, business([binding("canvas-image", "gpt"), binding("canvas-edit", "gpt")]), true);
    expect(result).toMatchObject({ config: { model: "gpt-image-2", imageModel: "gpt-image-2" }, toolKey: "canvas-edit" });
    expect(source.model).toBe("opaque-blend");
});

test("an editing board bound to Blend settles on the unbound generation board", () => {
    expect(resolveCanvasImageConfig(config("gpt-image-2"), business([binding("canvas-edit", "blend")]), true)).toMatchObject({ config: { model: "opaque-blend" }, toolKey: "canvas-image", isBound: true });
});

test("binding provenance is retained when the final route has no binding", () => {
    expect(resolveCanvasImageConfig(config("opaque-blend"), business([binding("canvas-image", "gpt")]), true)).toMatchObject({ config: { model: "gpt-image-2" }, toolKey: "canvas-edit", isBound: true });
});

test("crossed Blend and GPT bindings reject rather than cycling or choosing a fallback", () => {
    const crossed = business([binding("canvas-edit", "blend"), binding("canvas-image", "gpt")]);
    expect(() => resolveCanvasImageConfig(config("gpt-image-2"), crossed, true)).toThrow("不一致");
    expect(() => resolveCanvasImageConfig(config("opaque-blend"), crossed, true)).toThrow("不一致");
});

test("disabled routes, parent modules and missing bound models never fall back", () => {
    for (const tools of [
        [binding("canvas-edit", null, false)],
        [binding("canvas", null, false)],
        [binding("canvas-edit", "missing")],
        [binding("canvas-image", "gpt"), binding("canvas-edit", null, false)],
        [binding("canvas-image", "gpt"), binding("canvas-edit", "missing")],
    ]) expect(() => resolveCanvasImageConfig(config(tools.length > 1 ? "opaque-blend" : "gpt-image-2"), business(tools), true)).toThrow();
});

test("an empty current image catalog is unavailable, not a stale saved model", () => {
    expect(() => resolveCanvasImageConfig(config("gpt-image-2"), { models: [], tools: [], prices: [] }, true)).toThrow("暂不可用");
});
