import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { imageModelProfile, imageModelSettingsError, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageTaskParameters } from "@/services/api/image";
import { referencePolicyForModel, validateImageReferences } from "@/lib/image-reference-policy";
import { getModelPickerOptions, resolveCapabilityModel } from "@/lib/model-picker-options";
import { applyToolModel } from "@/services/api/tool-runtime";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildAgentGenerationPlan, normalizeAgentImageSettings, type AgentGenerationSettings } from "@/lib/agent-direct-generation";
import { onlineAgentConfig, onlineAgentMediaSettings } from "@/lib/canvas/online-agent-execution";

const original = useBusinessConfigStore.getState();
const initial = useBusinessConfigStore.getInitialState();
const initialModels = initial.models;
afterEach(() => { useBusinessConfigStore.setState(original); initial.models = initialModels; });
const model = (id: string, profile: "quality-resolution" | "resolution-1k", name = "aplmart-gpt2.5-flare") => ({ id, modelId: id, name, publicName: name, imageParameterProfile: profile, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 });
const models = [
  { id: "opentoken-id", modelId: "gpt-image-2.5-flare", name: "gpt-image-2.5-flare", imageParameterProfile: "standard-flex-plus" as const, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
  model("mark-flare-id", "quality-resolution"), model("mark-sunburst-id", "quality-resolution", "aplmart-gpt2.5-sunburst"), model("mark-nano-id", "resolution-1k", "aplmart-nano2.1"),
];

test("all three Mark choices stay distinct from identical OpenToken upstream names through picker and runtime", () => {
  const business = { models, tools: [], prices: [] };
  expect(getModelPickerOptions(defaultConfig, "image", models, "server")).toEqual(["gpt-image-2.5-flare", "mark-flare-id", "mark-sunburst-id", "mark-nano-id"]);
  for (const item of models) {
    expect(resolveCapabilityModel(defaultConfig, "image", models, item.modelId)).toBe(item.modelId);
    expect(applyToolModel({ ...defaultConfig, model: item.modelId }, business, "canvas-image").model).toBe(item.modelId);
  }
  expect(resolveCapabilityModel(defaultConfig, "image", models, "aplmart-gpt2.5-flare")).toBe("mark-flare-id");
});

test.each(["mark-flare-id", "mark-sunburst-id"])("%s keeps quality, resolution, ratio and format independent", id => {
  useBusinessConfigStore.setState({ models });
  initial.models = models;
  const profile = imageModelProfile(id, models, "designer");
  expect(profile.qualities).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
  expect(profile.resolutions).toEqual(["1k", "2k", "4k"]);
  expect(profile.sizes).toHaveLength(16);
  expect(profile.sizes).toContain("21:9");
  const config = { ...defaultConfig, model: id, size: "21:9", quality: "max", imageOptions: JSON.stringify({ resolution: "4k", output_format: "webp", output_compression: "88", background: "opaque", google_search: "true" }) };
  expect(imageTaskParameters(config)).toEqual({ size: "21:9", quality: "max", resolution: "4k", output_format: "webp", output_compression: 88, background: "opaque" });
  for (const size of [...profile.sizes, "640x1024", "3840x2160"]) expect(imageModelSettingsError(size, profile)).toBe("");
  expect(imageModelSettingsError("21:9", imageModelProfile("gpt-image-2.5-flare", models))).not.toBe("");
  for (const size of ["512x512", "1025x1024", "4096x2048", "3840x3840", "3072x768", "8:1"]) expect(imageModelSettingsError(size, profile)).not.toBe("");
  const html = renderToStaticMarkup(<ImageSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={() => undefined} />);
  expect(html).toContain('aria-label="图片质量"');
  expect(html).toContain('aria-label="清晰度 / 分辨率"');
  expect(html).toContain('value="4k" selected=""');
  expect(html).toContain('value="max" selected=""');
});

test("exact Mark pixel sizes visibly suspend the resolution tier without changing pixels or quality", () => {
  useBusinessConfigStore.setState({ models });
  initial.models = models;
  for (const size of ["1024x1024", "2048x1152"]) {
    const config = { ...defaultConfig, model: "mark-flare-id", size, quality: "max", imageOptions: '{"resolution":"4k"}' };
    expect(imageTaskParameters(config)).toMatchObject({ size, quality: "max", resolution: "4k" });
    const html = renderToStaticMarkup(<ImageSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={() => undefined} />);
    expect(html).toMatch(/<select[^>]*aria-label="清晰度 \/ 分辨率"[^>]*disabled=""/);
    expect(html).toMatch(/<p[^>]*role="status"/);
    expect(html).toContain(size.replace("x", " × "));
    expect(html).toMatch(/<select[^>]*aria-label="图片质量"(?![^>]*disabled)/);
  }
});

test("Mark ratio and auto sizes leave resolution selectable independently of quality", () => {
  useBusinessConfigStore.setState({ models });
  initial.models = models;
  for (const size of ["1:1", "21:9", "auto"]) {
    const config = { ...defaultConfig, model: "mark-sunburst-id", size, quality: "xhigh", imageOptions: '{"resolution":"4k"}' };
    const html = renderToStaticMarkup(<ImageSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={() => undefined} />);
    expect(html).toMatch(/<select[^>]*aria-label="清晰度 \/ 分辨率"(?![^>]*disabled)/);
    expect(html).not.toMatch(/<p[^>]*role="status"/);
    expect(imageTaskParameters(config)).toMatchObject({ size, resolution: "4k", quality: "xhigh" });
  }
});

test("switching to Nano removes GPT-only fields and only offers 1K, 2K and 4K", () => {
  useBusinessConfigStore.setState({ models });
  initial.models = models;
  const profile = imageModelProfile("mark-nano-id", models, "designer");
  expect(profile.qualities).toEqual(["1k", "2k", "4k"]);
  const config = { ...defaultConfig, model: "mark-nano-id", quality: "max", size: "4:3", imageOptions: JSON.stringify({ resolution: "4k", quality: "max", output_format: "webp", output_compression: "88", background: "transparent", google_search: "true", official_fallback: "true" }) };
  expect(normalizeImageModelSettings(config, profile).quality).toBe("1k");
  expect(imageTaskParameters(config)).toEqual({ size: "4:3", resolution: "1k" });
  expect(imageTaskParameters({ ...config, quality: "4k" })).toEqual({ size: "4:3", resolution: "4k" });
  expect(imageTaskParameters({ ...config, quality: "0.5k" })).toEqual({ size: "4:3", resolution: "1k" });
  expect(profile.outputFormats).toEqual([]);
  expect(profile.customSize).toBe(false);
  expect(profile.supportsMask).toBe(false);
  const html = renderToStaticMarkup(<ImageSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={() => undefined} />);
  expect(html).toContain('aria-label="清晰度 / 分辨率"');
  for (const unsupported of ["0.5K", "图片质量", "output_format", "background", "google_search"]) expect(html).not.toContain(unsupported);
});

test("Mark reference validation allows GPT's 16 references and labels Nano's local cap as an application limit", () => {
  const references = (count: number) => Array.from({ length: count }, (_, i) => ({ id: String(i), name: "ref.png", dataUrl: "https://example.test/ref.png" }));
  const gpt = imageModelProfile("mark-flare-id", models);
  expect(validateImageReferences("mark-flare-id", references(16), gpt).valid).toBe(true);
  expect(validateImageReferences("mark-flare-id", references(17), gpt).valid).toBe(false);
  const nano = imageModelProfile("mark-nano-id", models);
  expect(referencePolicyForModel("mark-nano-id", nano).label).toContain("工作台");
  expect(validateImageReferences("mark-nano-id", references(16), nano).valid).toBe(true);
  expect(validateImageReferences("mark-nano-id", references(17), nano).message).toContain("工作台");
});

test("canvas Agent preserves independent resolution from its settings through direct and online generation", () => {
  useBusinessConfigStore.setState({ models });
  const settings: AgentGenerationSettings = { mode: "image", imageModel: "mark-flare-id", videoModel: "wan2.7", size: "16:9", quality: "max", imageOptions: '{"resolution":"4k"}', imageCount: "1", videoSeconds: "5", videoQuality: "720P", afterImage: "images_only" };
  expect(buildAgentGenerationPlan(settings, "flower", [])).toMatchObject({ quality: "max", imageOptions: '{"resolution":"4k"}' });
  expect(onlineAgentConfig(defaultConfig, settings).imageOptions).toBe('{"resolution":"4k"}');
  expect(onlineAgentMediaSettings(settings, "image", { imageOptions: '{"resolution":"2k"}' }).imageOptions).toBe('{"resolution":"2k"}');
  expect(normalizeAgentImageSettings({ ...settings, imageOptions: '{"resolution":"0.5k"}' }).imageOptions).toBe('{"resolution":"1k"}');
  const freshProfile = imageModelProfile("mark-flare-id", models);
  useBusinessConfigStore.setState({ models: [] });
  expect(buildAgentGenerationPlan(settings, "flower", [], freshProfile)).toMatchObject({ quality: "max", size: "16:9", imageOptions: '{"resolution":"4k"}' });
});
