import { promptInputSchema, promptRecipeVersionSchema, type AdminPromptRecipeVersion, type PromptInput, type PromptRecipeVersionContent, type PublicPromptCompilation } from "../../../../../shared/prompt-contracts";
import type { AdminPromptTestInput } from "@/services/api/admin-prompt-recipes";
import type { TaskSubmission } from "../../../../../shared/task-contracts";

export function jsonObject(text: string, label: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error(`${label}必须是有效 JSON`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象，不能是数组或空值`);
    return value as Record<string, unknown>;
}

export type VersionEditorValue = Omit<PromptRecipeVersionContent, "modelOverrides"> & { overridesJson: string };
export function editVersion(version: AdminPromptRecipeVersion): VersionEditorValue {
    return {
        systemPrompt: version.systemPrompt,
        fieldTemplate: version.fieldTemplate,
        overridesJson: JSON.stringify(version.modelOverrides, null, 2),
        fallbackPrompt: version.fallbackPrompt,
        outputLanguage: version.outputLanguage,
        changeNote: version.changeNote,
    };
}
export function parseVersion(value: VersionEditorValue): PromptRecipeVersionContent {
    const modelOverrides = jsonObject(value.overridesJson, "模型覆盖规则");
    if (Object.values(modelOverrides).some((entry) => typeof entry !== "string")) throw new Error("模型覆盖规则的每个值必须是字符串");
    return promptRecipeVersionSchema.parse({ ...value, modelOverrides });
}
export function assertFallback(policy: "stop" | "fallback", version?: Pick<PromptRecipeVersionContent, "fallbackPrompt">) {
    if (policy === "fallback" && !version?.fallbackPrompt.trim()) throw new Error("选择回退策略前，目标版本必须保存非空回退提示词");
}
export function buildTestPromptInput(value: { scene: string; fieldsJson: string; userText: string; rolesText: string; mode: "generate" | "edit"; outputLanguage: "en" | "zh" }): PromptInput {
    return promptInputSchema.parse({
        scene: value.scene,
        fields: jsonObject(value.fieldsJson, "场景字段"),
        userText: value.userText,
        referenceRoles: value.rolesText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        mode: value.mode,
        outputLanguage: value.outputLanguage,
        hasMask: false,
    });
}
export function buildTestImage(input: AdminPromptTestInput, compilation: PublicPromptCompilation, requestId: string, parametersJson: string): TaskSubmission {
    if (compilation.status !== "success" || !compilation.prompt?.trim()) throw new Error("请先完成提示词优化测试");
    const edit = input.promptInput.mode === "edit";
    return {
        requestId,
        projectId: "admin-prompt-tests",
        operationType: edit ? "inpaint" : "image_generation",
        toolKey: edit ? "image-edit" : "image",
        modelConfigId: input.modelConfigId,
        prompt: compilation.prompt,
        promptInput: { ...input.promptInput, compilationId: compilation.id },
        parameters: { ...jsonObject(parametersJson, "出图参数"), count: 1 },
        priority: "normal",
        sourceUrls: [...input.sourceUrls],
    };
}
export function messageOf(error: unknown) {
    if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) return error.issues.map((issue) => issue.message).join("；");
    return error instanceof Error ? error.message : "操作失败，请稍后重试";
}
