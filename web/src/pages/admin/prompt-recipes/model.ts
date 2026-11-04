import { promptInputSchema, promptRecipeVersionSchema, type AdminPromptRecipeVersion, type PromptInput, type PromptRecipeVersionContent, type PublicPromptCompilation } from "../../../../../shared/prompt-contracts";
import type { AdminPromptTestInput } from "@/services/api/admin-prompt-recipes";
import type { TaskSubmission } from "../../../../../shared/task-contracts";
import { defaultVideoMotionSettings, normalizeVideoMotionSettings } from "../../../../../shared/video-motion-options";

export const defaultVideoTestFields = { ...defaultVideoMotionSettings, duration: 5, ratio: "adaptive", resolution: "720p", video_mode: "auto", generate_audio: false };

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
export function emptyVersion(outputLanguage: "en" | "zh"): VersionEditorValue {
    return { systemPrompt: "", fieldTemplate: "", overridesJson: "{}", fallbackPrompt: "", outputLanguage, changeNote: "" };
}
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
export function buildTestPromptInput(value: { scene: string; fieldsJson: string; userText: string; rolesText: string; mode: PromptInput["mode"]; outputLanguage: "en" | "zh"; referenceCount?: number }): PromptInput {
    const isVideo = value.scene === "video-motion";
    const fields = jsonObject(value.fieldsJson, "场景字段");
    const motion = normalizeVideoMotionSettings(fields);
    const count = value.referenceCount ?? 0;
    const videoMode = fields.video_mode && fields.video_mode !== "auto" ? fields.video_mode : count === 1 ? "first-frame" : count === 2 ? "first-last-frame" : count ? "reference" : "text";
    const roles = value.rolesText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return promptInputSchema.parse({
        scene: value.scene,
        fields: isVideo ? { ...defaultVideoTestFields, ...fields, ...motion, video_mode: videoMode, generate_audio: motion.audio !== "none" } : fields,
        userText: value.userText,
        referenceRoles: isVideo && !roles.length ? Array.from({ length: count }, (_, index) => (videoMode === "first-frame" ? "首帧" : videoMode === "first-last-frame" ? (index ? "尾帧" : "首帧") : `参考图片${index + 1}`)) : roles,
        mode: value.mode,
        outputLanguage: isVideo ? "zh" : value.outputLanguage,
        hasMask: false,
    });
}
export function buildTestImage(input: AdminPromptTestInput, compilation: PublicPromptCompilation, requestId: string, parametersJson: string): TaskSubmission {
    if (input.promptInput.mode === "video") throw new Error("视频动效测试仅规划提示词，请到视频创作页生成视频");
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
