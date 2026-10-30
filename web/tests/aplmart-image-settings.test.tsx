import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { imageTaskParameters } from "@/services/api/image";
import { imageOptionFields } from "@/lib/image-advanced-settings";
import type { PublicModel } from "@/services/api/business-config";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canvasThemes } from "@/lib/canvas-theme";

const original = useBusinessConfigStore.getState();
const initial = useBusinessConfigStore.getInitialState();
const initialModels = initial.models;
afterEach(() => { useBusinessConfigStore.setState(original); initial.models = initialModels; });
const models: PublicModel[] = [
  { id: "mark-blend", modelId: "mark-blend", name: "aplmart-mj-blend", imageParameterProfile: "midjourney-blend", imageSupportsMask: false, capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
  { id: "mark-gpt2", modelId: "mark-gpt2", name: "aplmart-gpt2", imageParameterProfile: "gpt", imageSupportsMask: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
  { id: "mark-grok", modelId: "mark-grok", name: "aplmart-grok2", imageParameterProfile: "grok-image", imageSupportsMask: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
  { id: "mark-nano2", modelId: "mark-nano2", name: "aplmart-nano2", imageParameterProfile: "resolution", imageSupportsMask: false, imageSupportsOfficialFallback: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
];
const refs = (count: number) => Array.from({ length: count }, (_, i) => ({ id: String(i), name: "ref.png", type: "image/png", dataUrl: "https://example.test/ref.png" }));

test("Grok UUID exposes exactly 14 ratios, two resolutions, two qualities and three references", () => {
  const profile = imageModelProfile("mark-grok", models);
  expect(profile.sizes).toEqual(["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "auto"]);
  expect(profile.resolutions).toEqual(["1k", "2k"]);
  expect(profile.qualities).toEqual(["low", "medium"]);
  expect(normalizeImageModelSettings(defaultConfig, profile).quality).toBe("medium");
  expect(profile.customSize).toBe(false);
  expect(profile.supportsMask).toBe(false);
  expect(validateImageReferences("mark-grok", refs(3), profile).valid).toBe(true);
  expect(validateImageReferences("mark-grok", refs(4), profile).valid).toBe(false);
});

test("Grok reference mode hides quality and strips it plus unsupported fields from actual parameters", () => {
  initial.models = models; useBusinessConfigStore.setState({ models });
  const profile = imageModelProfile("mark-grok", models);
  const config = { ...defaultConfig, model: "mark-grok", size: "9:19.5", quality: "low", imageOptions: '{"resolution":"2k","nsfw_check":"false","output_format":"webp","background":"transparent","metadata":"{}"}' };
  expect(imageTaskParameters(config, profile)).toEqual({ size: "9:19.5", quality: "low", resolution: "2k", nsfw_check: false });
  expect(imageTaskParameters(config, profile, { referenceCount: 1 })).toEqual({ size: "9:19.5", resolution: "2k", nsfw_check: false });
  const html = renderToStaticMarkup(<ImageSettingsPanel config={config} theme={canvasThemes.light} referenceCount={1} onConfigChange={() => undefined} />);
  expect(html).not.toContain('aria-label="图片质量"');
  expect(html).toContain("参考图模式不提交 quality");
  expect(html).toContain('value="2k" selected=""');
  expect(html).not.toContain('value="4k"');
});

test("Blend promotes dimensions, accepts custom aspect, fixes one task and rejects reference boundaries", () => {
  initial.models = models; useBusinessConfigStore.setState({ models });
  const profile = imageModelProfile("mark-blend", models);
  expect(profile.requiresPrompt).toBe(false);
  for (const count of [0, 1, 5]) expect(validateImageReferences("mark-blend", refs(count), profile).valid).toBe(false);
  for (const count of [2, 4]) expect(validateImageReferences("mark-blend", refs(count), profile).valid).toBe(true);
  const config = { ...defaultConfig, model: "mark-blend", size: "7:5", quality: "turbo", count: "9", imageOptions: JSON.stringify({ dimensions: "PORTRAIT", nsfw_check: "false", metadata: '{"tag":"qa"}', resolution: "4k" }) };
  expect(normalizeImageModelSettings(config, profile)).toEqual({ size: "7:5", quality: "turbo", count: "1" });
  expect(imageTaskParameters(config, profile)).toEqual({ size: "7:5", midjourneySpeed: "turbo", dimensions: "PORTRAIT", nsfw_check: false, metadata: { tag: "qa" } });
  const html = renderToStaticMarkup(<ImageSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={() => undefined} />);
  expect(html.indexOf('aria-label="比例预设"')).toBeLessThan(html.indexOf("全部高级参数"));
  expect(html).not.toContain("1 个任务");
  expect(html).not.toContain('aria-label="生成张数"');
  expect(html).toContain("size 优先于 dimensions");
});

test("public mask declaration overrides the legacy GPT heuristic without changing old channels", () => {
  expect(imageModelProfile("mark-gpt2", models).supportsMask).toBe(false);
  expect(imageModelProfile("vcen-gpt2", []).supportsMask).toBe(true);
});

test("Nano2 Official keeps its four resolution tiers, strips fallback and never submits a quality field", () => {
  const profile = imageModelProfile("mark-nano2", models);
  expect(profile.kind).toBe("gemini");
  expect(profile.qualities).toEqual(["0.5k", "1k", "2k", "4k"]);
  expect(profile.supportsMask).toBe(false);
  expect(profile.supportsOfficialFallback).toBe(false);
  expect(imageOptionFields(profile).map(field => field.key)).toEqual(["nsfw_check", "google_search", "google_image_search"]);
  const config = { ...defaultConfig, model: "mark-nano2", size: "3:4", quality: "0.5k", count: "8", imageOptions: '{"quality":"high","resolution":"4k","official_fallback":"true","google_image_search":"true","output_format":"webp","background":"transparent"}' };
  expect(normalizeImageModelSettings(config, profile)).toEqual({ size: "3:4", quality: "0.5k", count: "1" });
  expect(imageTaskParameters(config, profile)).toEqual({ size: "3:4", resolution: "0.5k", google_image_search: true, google_search: true });
  const html = renderToStaticMarkup(<ImageSettingsPanel config={config} profile={profile} theme={canvasThemes.light} onConfigChange={() => undefined} />);
  expect(html).toContain('aria-pressed="true">0.5K</button>');
  expect(html).not.toContain("official_fallback");
  expect(html).not.toContain('aria-label="图片质量"');
  expect(imageOptionFields(imageModelProfile("gemini-3.1-flash-image-preview", [])).some(field => field.key === "official_fallback")).toBe(true);
});

test("Nano2 UUID validates 14 references, a 10 MiB per-image boundary and supported image MIME types", () => {
  const profile = imageModelProfile("mark-nano2", models);
  expect(validateImageReferences("mark-nano2", refs(14), profile).valid).toBe(true);
  expect(validateImageReferences("mark-nano2", refs(15), profile).valid).toBe(false);
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    expect(validateImageReferences("mark-nano2", [{ ...refs(1)[0]!, type, bytes: 10 * 1024 * 1024 }], profile).valid).toBe(true);
  }
  expect(validateImageReferences("mark-nano2", [{ ...refs(1)[0]!, bytes: 10 * 1024 * 1024 + 1 }], profile).message).toContain("10 MiB");
  expect(validateImageReferences("mark-nano2", [{ ...refs(1)[0]!, type: "image/gif" }], profile).message).toContain("JPEG、PNG 或 WebP");
});
