import { getToolDefinition, moduleIsEnabled, resolveToolKey, type ModuleKey } from "../../shared/feature-catalog";
import { DEFAULT_CHAT_MODEL_TOOL_KEY } from "./chat-model-policy";
import { isQuickImageAction, matchesQuickImageTaskTarget } from "../../shared/quick-image-tools";
import { QUICK_IMAGE_SNAPSHOT, type QuickImageSnapshot } from "./quick-image-tools";

export class DemoToolConfigurationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export function resolveDemoToolConfiguration(
  input: { operationType: string; toolKey?: string; modelConfigId?: string | null; parameters?: Record<string, unknown>; [QUICK_IMAGE_SNAPSHOT]?: QuickImageSnapshot },
  bindings: Array<{ toolKey: string; modelConfigId: string | null; enabled: boolean; allowRawPrompt?: boolean }>,
  models: Array<Record<string, unknown>>,
  providers: Array<Record<string, unknown>>,
  flags: Partial<Record<ModuleKey, boolean>>,
) {
  const explicit = input.toolKey ?? (typeof input.parameters?.tool === "string" ? input.parameters.tool : undefined);
  const toolKey = resolveToolKey(input.operationType, explicit);
  const definition = getToolDefinition(toolKey);
  if (!toolKey || !definition) throw new DemoToolConfigurationError("INVALID_TOOL", "板块标识无效");
  if (!(definition.operations as readonly string[]).includes(input.operationType)) throw new DemoToolConfigurationError("TOOL_OPERATION_MISMATCH", "板块不支持该操作类型");
  const quickAction = input.parameters?.quickImageAction;
  if (quickAction !== undefined && (!isQuickImageAction(quickAction) || !matchesQuickImageTaskTarget(quickAction, toolKey, input.operationType))) {
    throw new DemoToolConfigurationError("QUICK_IMAGE_ACTION_INVALID", "一键图片操作与当前板块不匹配");
  }
  const binding = bindings.find(item => item.toolKey === toolKey);
  const parentBinding = bindings.find(item => item.toolKey === definition.parent);
  if (!moduleIsEnabled(flags, toolKey) || binding?.enabled === false || parentBinding?.enabled === false) throw new DemoToolConfigurationError("MODULE_DISABLED", "该功能板块已关闭", 403);
  const requested = models.find(model => model.id === input.modelConfigId || model.modelId === input.modelConfigId);
  const isChat = input.operationType === "chat";
  const isQuickImage = isQuickImageAction(quickAction);
  const snapshot = input[QUICK_IMAGE_SNAPSHOT];
  if (isQuickImage && (!snapshot || snapshot.action !== quickAction)) throw new DemoToolConfigurationError("QUICK_IMAGE_CONFIGURATION_REQUIRED", "一键工具缺少服务端配置快照");
  const modelBinding = isChat ? bindings.find(item => item.toolKey === DEFAULT_CHAT_MODEL_TOOL_KEY) : binding;
  if (isChat && !modelBinding?.modelConfigId) throw new DemoToolConfigurationError("CHAT_MODEL_NOT_CONFIGURED", "管理员尚未配置统一对话模型", 503);
  if (!isQuickImage && !isChat && binding?.modelConfigId && input.modelConfigId && requested?.id !== binding.modelConfigId) throw new DemoToolConfigurationError("TOOL_MODEL_CHANGED", "板块模型配置已更新，请刷新后重试");
  const model = isQuickImage ? models.find(item => item.id === snapshot!.modelConfigId)
    : modelBinding?.modelConfigId ? models.find(item => item.id === modelBinding.modelConfigId) : requested;
  const provider = model && providers.find(item => item.id === model.providerId);
  if (!model || model.enabled !== true || provider?.enabled !== true) throw new DemoToolConfigurationError("MODEL_DISABLED", "所选模型或 API 服务未启用");
  if (isQuickImage && (model.modelId !== snapshot!.modelId || provider.protocol !== "apimart" || model.workflowConfigId || !(model.capabilities as string[]).includes("edit"))) throw new DemoToolConfigurationError("TOOL_MODEL_MISMATCH", "一键图片模型已变化，请重新提交");
  if (toolKey === "midjourney-blend" && model.modelId !== "midjourney-blend") throw new DemoToolConfigurationError("TOOL_MODEL_MISMATCH", "MJ 多图融合板块仅支持 Midjourney Blend 模型");
  const required: Record<string, string[]> = { image_generation: ["generate"], inpaint: ["edit"], upscale: ["upscale", "edit"], seamless_stitch: ["edit"], batch_image: ["batch", "edit"], video_generation: ["video"], audio_generation: ["audio"], chat: ["chat"] };
  if (!(required[input.operationType] || []).some(capability => (model.capabilities as string[]).includes(capability))) throw new DemoToolConfigurationError("MODEL_CAPABILITY_MISMATCH", "所选模型不支持该板块的操作类型");
  return { toolKey, modelConfigId: String(model.id), allowRawPrompt: binding?.allowRawPrompt === true };
}
