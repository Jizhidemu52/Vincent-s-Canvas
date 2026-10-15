import { getBusinessConfig, type BusinessConfig } from "./business-config";
import { getToolDefinition, resolveToolKey, type ToolKey } from "../../../../shared/feature-catalog";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function requireToolKey(operationType: string, key?: string): ToolKey {
    const resolved = resolveToolKey(operationType, key);
    const definition = getToolDefinition(resolved);
    if (!resolved || !definition || !(definition.operations as readonly string[]).includes(operationType)) throw new Error("当前板块与生成操作不匹配，请刷新页面后重试。");
    return resolved;
}

/** A disabled or stale binding must never fall through to a global model. */
export function resolveConfiguredToolModel(business: BusinessConfig, toolKey: ToolKey, requestedModel: string) {
    const binding = business.tools.find(item => item.toolKey === toolKey);
    const parent = getToolDefinition(toolKey)?.parent;
    const parentBinding = parent ? business.tools.find(item => item.toolKey === parent) : undefined;
    if (binding?.enabled === false || parentBinding?.enabled === false) throw new Error("当前板块或所属入口已停用，请联系管理员。");
    const requested = binding?.modelConfigId || requestedModel;
    const normalized = modelOptionName(requested);
    const model = business.models.find(item => binding?.modelConfigId ? item.id === binding.modelConfigId : item.id === requested || item.modelId === normalized || item.name === requested);
    if (!model) throw new Error(binding?.modelConfigId ? "此板块绑定的模型暂不可用，请联系管理员。" : "所选模型暂不可用，请重新选择或联系管理员启用。");
    if (toolKey === "midjourney-blend" && model.imageParameterProfile !== "blend" && model.imageParameterProfile !== "midjourney-blend" && model.modelId !== "midjourney-blend") throw new Error("MJ 多图融合板块仅支持 Blend 模型，请管理员检查绑定。");
    return model;
}

export function applyToolModel(config: AiConfig, business: BusinessConfig, toolKey: ToolKey): AiConfig {
    const definition = getToolDefinition(toolKey)!;
    const key = definition.operationType === "chat" ? "textModel" : definition.operationType === "video_generation" ? "videoModel" : definition.operationType === "audio_generation" ? "audioModel" : "imageModel";
    const model = resolveConfiguredToolModel(business, toolKey, config.model || config[key]);
    return { ...config, model: model.modelId, [key]: model.modelId };
}

/** Resolve before model-specific normalization and before uploading references. */
export async function resolveToolConfig(config: AiConfig, operationType: string, key?: string) {
    const toolKey = requireToolKey(operationType, key);
    const ownerId = useUserStore.getState().user?.id;
    const business = await getBusinessConfig();
    if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，已取消生成提交");
    const effectiveConfig = applyToolModel(config, business, toolKey);
    const model = resolveConfiguredToolModel(business, toolKey, effectiveConfig.model);
    const requiredCapabilities: Record<string, string[]> = { image_generation: ["generate"], inpaint: ["edit"], upscale: ["upscale", "edit"], seamless_stitch: ["edit"], batch_image: ["batch", "edit"], video_generation: ["video"], audio_generation: ["audio"], chat: ["chat"] };
    if (!requiredCapabilities[operationType]?.some(capability => model.capabilities.includes(capability))) throw new Error("此板块当前模型不支持所请求的操作，请联系管理员调整绑定。");
    return { toolKey, config: effectiveConfig, model };
}
