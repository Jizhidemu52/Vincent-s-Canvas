import { expect, test } from "bun:test";
import { assertFallback, buildTestImage, buildTestPromptInput, jsonObject, parseVersion } from "../src/pages/admin/prompt-recipes/model";

test("editor rejects malformed/object-shape input and nontext model overrides before posting", () => {
    expect(() => jsonObject("{broken", "字段")).toThrow("有效 JSON");
    expect(() => jsonObject("[]", "字段")).toThrow("JSON 对象");
    expect(() => jsonObject("null", "字段")).toThrow("JSON 对象");
    const version = { systemPrompt: "rules", fieldTemplate: "{{fields}}", fallbackPrompt: "", outputLanguage: "en" as const, changeNote: "draft", overridesJson: '{"image-model": "specific rule"}' };
    expect(parseVersion(version).modelOverrides).toEqual({ "image-model": "specific rule" });
    expect(() => parseVersion({ ...version, overridesJson: '{"x":3}' })).toThrow("必须是字符串");
    expect(() => parseVersion({ ...version, systemPrompt: " " })).toThrow();
    expect(() => assertFallback("fallback", version)).toThrow("非空回退");
    expect(() => assertFallback("stop", version)).not.toThrow();
    expect(() => assertFallback("fallback", { fallbackPrompt: "local fallback" })).not.toThrow();
});

test("test input uses explicit scene, object fields, image roles and language without authoring content", () => {
    expect(buildTestPromptInput({ scene: "local-restyle", fieldsJson: '{"material":"cotton"}', userText: "modify", rolesText: " front \n\n back ", mode: "edit", outputLanguage: "zh" })).toEqual({
        scene: "local-restyle",
        fields: { material: "cotton" },
        userText: "modify",
        referenceRoles: ["front", "back"],
        mode: "edit",
        outputLanguage: "zh",
        hasMask: false,
    });
});

test("test image uses frozen compilation snapshot, one image, and the normal route for each mode", () => {
    const input = {
        requestId: "request-1",
        modelConfigId: "10000000-0000-4000-8000-000000000001",
        versionId: "v1",
        sourceUrls: ["/api/assets/source/content"],
        promptInput: buildTestPromptInput({ scene: "local-restyle", fieldsJson: "{}", userText: "original", rolesText: "front", mode: "edit", outputLanguage: "en" }),
    };
    const compilation = { id: "20000000-0000-4000-8000-000000000001", requestId: input.requestId, status: "success" as const, optimized: true, prompt: "optimized original" };
    const task = buildTestImage(input, compilation, "image-request-1", '{"count":8,"size":"1024x1024"}');
    expect(task).toMatchObject({ operationType: "inpaint", toolKey: "image-edit", prompt: "optimized original", promptInput: { userText: "original", compilationId: compilation.id }, parameters: { count: 1, size: "1024x1024" } });
    expect(task.sourceUrls).toEqual(input.sourceUrls);
    expect(task.sourceUrls).not.toBe(input.sourceUrls);
    expect(input.promptInput).not.toHaveProperty("compilationId");
    const generate = buildTestImage({ ...input, promptInput: { ...input.promptInput, mode: "generate" } }, compilation, "image-request-2", "{}");
    expect(generate.operationType).toBe("image_generation");
    expect(generate.toolKey).toBe("image");
    expect(() => buildTestImage(input, { ...compilation, status: "uncertain" }, "image-request-3", "{}")).toThrow("先完成");
});
