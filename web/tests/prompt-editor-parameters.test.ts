import { expect, test } from "bun:test";
import { mergePromptEditorParameters, promptImageSettings } from "@/lib/prompt-editor-parameters";
import { imageModelProfile } from "@/lib/image-model-settings";

const markModels = [
    { id: "mark-gpt-uuid", modelId: "mark-gpt-uuid", name: "Mark GPT", imageParameterProfile: "quality-resolution" as const, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "mark-nano-uuid", modelId: "mark-nano-uuid", name: "Mark Nano", imageParameterProfile: "resolution-1k" as const, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
];

test("editing common fields preserves video and provider parameters without mutating the template", () => {
    const original = { videoMode: "first-last", videoSeconds: 6, resolution: "1080p", size: "16:9", count: 2, nested: { seed: 42 } };
    const result = mergePromptEditorParameters(original, { size: " 1:1 ", quality: "high", quantity: 3 });
    expect(result).toEqual({ ...original, size: "1:1", quality: "high", quantity: 1, count: 1 });
    expect(original.size).toBe("16:9");
    expect(original.count).toBe(2);
});

test("clearing a field removes only that field; new templates start with clean parameters", () => {
    expect(mergePromptEditorParameters({ size: "16:9", quality: "high", videoSeconds: 4 }, {})).toEqual({ videoSeconds: 4, quantity: 1 });
    expect(mergePromptEditorParameters(undefined, {})).toEqual({ quantity: 1 });
});

test("Mark GPT templates save and restore independent max quality and 4k resolution", () => {
    const profile = imageModelProfile("mark-gpt-uuid", markModels);
    const result = mergePromptEditorParameters(undefined, { size: "21:9", quality: "max", quantity: 2, imageOptions: '{"resolution":"4k","output_format":"webp","output_compression":"85"}' }, profile);
    expect(result).toMatchObject({ size: "21:9", quality: "max", resolution: "4k", output_format: "webp", output_compression: 85, quantity: 1 });
    expect(promptImageSettings(result, "mark-gpt-uuid", markModels)).toEqual({ size: "21:9", quality: "max", count: "1", imageOptions: '{"resolution":"4k","output_format":"webp","output_compression":"85"}' });
});

test("all exposed Mark GPT image options survive template round-trip, including zero compression and exact pixels", () => {
    const profile = imageModelProfile("mark-gpt-uuid", markModels);
    const parameters = mergePromptEditorParameters(undefined, { size: "2048x1152", quality: "xhigh", quantity: 3, imageOptions: '{"resolution":"4k","background":"transparent","output_format":"webp","output_compression":"0"}' }, profile);
    expect(parameters).toMatchObject({ size: "2048x1152", quality: "xhigh", quantity: 1, resolution: "4k", background: "transparent", output_format: "webp", output_compression: 0 });
    const restored = promptImageSettings(parameters, "mark-gpt-uuid", markModels);
    expect(restored).toMatchObject({ size: "2048x1152", quality: "xhigh", count: "1" });
    expect(JSON.parse(restored.imageOptions)).toEqual({ resolution: "4k", background: "transparent", output_format: "webp", output_compression: "0" });
    const cleared = mergePromptEditorParameters(parameters, { size: "auto", quality: "low", quantity: 1, imageOptions: '{"resolution":"2k"}' }, profile);
    expect(cleared).toEqual({ size: "auto", quality: "low", quantity: 1, imageOptions: '{"resolution":"2k"}', resolution: "2k" });
    expect(JSON.parse(promptImageSettings(cleared, "mark-gpt-uuid", markModels).imageOptions)).toEqual({ resolution: "2k" });
});

test("task snapshots with flat image parameters restore without a legacy imageOptions wrapper", () => {
    const settings = promptImageSettings({ size: "3:4", quality: "xhigh", resolution: "2k", background: "transparent", output_format: "png" }, "mark-gpt-uuid", markModels);
    expect(settings).toMatchObject({ quality: "xhigh", size: "3:4", count: "1" });
    expect(JSON.parse(settings.imageOptions)).toEqual({ resolution: "2k", background: "transparent", output_format: "png" });
});

test("Nano templates serialize only resolution and do not retain stale GPT output controls", () => {
    const profile = imageModelProfile("mark-nano-uuid", markModels);
    const result = mergePromptEditorParameters({ quality: "max", resolution: "4k", output_format: "jpeg", background: "opaque" }, { size: "1:1", quality: "2k", quantity: 1, imageOptions: '{"resolution":"4k","output_format":"jpeg"}' }, profile);
    expect(result).toMatchObject({ resolution: "2k", imageOptions: "{}" });
    expect(result).not.toHaveProperty("quality"); expect(result).not.toHaveProperty("output_format"); expect(result).not.toHaveProperty("background");
    expect(promptImageSettings(result, "mark-nano-uuid", markModels)).toEqual({ size: "1:1", quality: "2k", count: "1", imageOptions: "{}" });
});

test("missing image fields clear stale options and use selected model defaults", () => {
    expect(promptImageSettings({}, "mark-gpt-uuid", markModels)).toEqual({ size: "auto", quality: "auto", count: "1", imageOptions: '{"resolution":"1k"}' });
    expect(promptImageSettings({}, "mark-nano-uuid", markModels)).toMatchObject({ quality: "1k", imageOptions: "{}" });
});
