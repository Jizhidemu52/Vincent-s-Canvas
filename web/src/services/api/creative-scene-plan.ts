import { createClientId } from "@/lib/client-id";
import { MAX_CREATIVE_CHAT_PREVIEW_BYTES } from "@/lib/creative-chat";
import { buildCreativeSceneGenerationPrompt, buildCreativeScenePlanMessages, parseCreativeScenePlan, snapshotCreativeScenePlanInput, type CreativeScenePlan, type CreativeScenePlanInput } from "@/lib/creative-scene-plan";
import { getDataUrlByteSize } from "@/lib/image-utils";
import { getBusinessConfig } from "@/services/api/business-config";
import { createPlanningPreview } from "@/services/api/creative-chat";
import { requestToolResponse } from "@/services/api/image";
import { resolveToolConfig } from "@/services/api/tool-runtime";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export type { CreativeScenePlan, CreativeScenePlanInput, CreativeScenePlanReference } from "@/lib/creative-scene-plan";

/** Exactly one managed LLM call. Failure never falls back to a template or starts image generation. */
export async function requestCreativeScenePlan(config: AiConfig, input: CreativeScenePlanInput, options: { signal?: AbortSignal; requestId?: string; onPhase?: (text: string) => void } = {}): Promise<CreativeScenePlan> {
    const ownerId = useUserStore.getState().user?.id;
    const assertCurrent = () => {
        options.signal?.throwIfAborted();
        if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，已停止场景规划");
    };
    assertCurrent();
    const snapshot = snapshotCreativeScenePlanInput(input);
    options.onPhase?.("正在读取统一 LLM 规划配置…");
    const resolved = await resolveToolConfig(config, "chat", "creative-planner");
    assertCurrent();
    if (snapshot.references.length && !resolved.model.capabilities.includes("vision")) throw new Error("当前统一 LLM 不支持视觉理解，不能分析本次参考图；请管理员配置支持 vision 的模型");
    options.onPhase?.("正在准备场景参考图预览…");
    const previews: ReferenceImage[] = [];
    for (const reference of snapshot.references) {
        assertCurrent();
        previews.push(await createPlanningPreview(reference, options.signal));
        assertCurrent();
    }
    if (previews.reduce((total, preview) => total + getDataUrlByteSize(preview.dataUrl), 0) > MAX_CREATIVE_CHAT_PREVIEW_BYTES) throw new Error("场景规划参考图预览超过 8MB，请减少图像复杂度后重试");
    const requestId = options.requestId || createClientId();
    options.onPhase?.(`正在由 ${resolved.model.name} 理解需求与参考图…`);
    assertCurrent();
    const result = await requestToolResponse({ ...resolved.config, systemPrompt: "" }, buildCreativeScenePlanMessages(snapshot, previews), [], "auto", undefined, { tool: "creative-planner", chatRequestId: requestId, signal: options.signal });
    assertCurrent();
    const plan = parseCreativeScenePlan(result);
    const modelId = result.modelConfigId || resolved.model.id;
    let modelName = modelId === resolved.model.id ? resolved.model.name : modelId;
    if (modelId !== resolved.model.id) {
        // Configuration may change between the preflight and the server's authoritative selection.
        const business = await getBusinessConfig().catch(() => undefined);
        assertCurrent();
        modelName = business?.models.find(model => model.id === modelId)?.name || modelId;
    }
    options.onPhase?.("LLM 规划已完成，正在准备图像任务…");
    return { ...plan, prompt: buildCreativeSceneGenerationPrompt(snapshot, plan), modelId, modelName, requestId: result.requestId || requestId };
}
