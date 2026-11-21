import { toolDefinitions } from "@/services/api/modules";
import { IMAGE_CONVERSATION_PLANNER_MODEL_ID, plannerProtocols } from "../../../../../shared/image-conversation-planner-policy";
import { missingChatModelMessage } from "../../../../../shared/chat-model-binding";
import { isLayerStudioPricingModel, type ServerModel, type ServerProvider, type ServerWorkflow, type ToolApiConfiguration, type ToolApiConfigurationInput } from "@/services/api/model-configuration";

export function completeToolConfigurations(configurations: ToolApiConfiguration[]): ToolApiConfiguration[] {
    return toolDefinitions.map((definition) => ({
        ...definition, modelConfigId: null, enabled: definition.toolKey !== "layer-studio",
        creditCostOverride: null, rmbCostOverride: null, configurationVersion: 0, price: null,
        ...configurations.find((item) => item.toolKey === definition.toolKey),
        capabilities: [...definition.capabilities],
    }));
}

export function compatibleToolModels(tool: ToolApiConfiguration, models: ServerModel[], providers: ServerProvider[], workflows: ServerWorkflow[]) {
    return models.filter((model) => {
        const provider = providers.find((item) => item.id === model.providerId);
        const workflow = model.workflowConfigId ? workflows.find((item) => item.id === model.workflowConfigId) : undefined;
        return model.enabled && (tool.toolKey !== "midjourney-blend" || model.modelId === "midjourney-blend")
            && (tool.toolKey !== "canvas-mask-edit" || model.modelId !== "seedream-5-5")
            && (tool.toolKey !== "layer-studio" && model.modelId !== "seedream-5-5" || isLayerStudioPricingModel(model, providers))
            && tool.capabilities.some((capability) => model.capabilities.includes(capability))
            && provider?.enabled && (provider.hasCredentials || provider.protocol === "comfyui" || provider.protocol === "custom")
            && (!model.workflowConfigId || workflow?.enabled);
    });
}

export function buildToolConfigurationInput(tool: ToolApiConfiguration, values: Partial<ToolApiConfigurationInput>): ToolApiConfigurationInput {
    return {
        modelConfigId: tool.toolKey === "canvas-chat" ? null : values.modelConfigId || null, enabled: values.enabled ?? (tool.toolKey !== "layer-studio"),
        creditCostOverride: values.creditCostOverride === undefined ? tool.creditCostOverride : values.creditCostOverride,
        rmbCostOverride: values.rmbCostOverride === undefined ? tool.rmbCostOverride : values.rmbCostOverride,
        ...(tool.toolKey === "video" ? { allowRawPrompt: values.allowRawPrompt === true } : {}),
    };
}

export function toolConfigurationState(tool: ToolApiConfiguration, compatibleModels: ServerModel[], imageConversationsEnabled = false) {
    const unavailable = (label: string, reason: string) => ({ ready: false, label, reason });
    if (!tool.enabled) return unavailable("已停用", "本板块 API 已停用，不会回退到其他模型。");
    if (imageConversationsEnabled && (tool.toolKey === "gpt-chat" || tool.toolKey === "canvas-chat")) {
        const model = compatibleModels.find(candidate => candidate.id === tool.modelConfigId);
        if (!model || model.modelId !== IMAGE_CONVERSATION_PLANNER_MODEL_ID || model.workflowConfigId || !model.capabilities.includes("vision") || !plannerProtocols.includes(tool.protocol ?? "") || !tool.hasCredentials)
            return unavailable("规划模型不可用", `${tool.modelConfigId ? "对话规划绑定不可用" : missingChatModelMessage(tool.toolKey)}。请在“对话改图”绑定启用且支持图文理解的 ${IMAGE_CONVERSATION_PLANNER_MODEL_ID} 直连模型，并启用对应 API；配置前不会创建新轮次或扣费。`);
    }
    if (tool.toolKey === "layer-studio" && !tool.modelConfigId) return unavailable("待配置", "须由管理员绑定专属模型后才能启用；前台没有模型选择器，也不会自动使用其他模型。");
    if (tool.toolKey === "canvas-design-chat" && !tool.modelConfigId) return unavailable("待配置", "请在本板块独立指定设计讨论模型；不继承其他聊天，也不会使用前端传入的模型。");
    if (tool.operationType === "chat" && !tool.modelConfigId) return unavailable("待配置", "请在“对话改图”中指定统一对话模型；设计师不能自行选择，也不会自动使用其他模型。");
    if (!tool.modelConfigId) return compatibleModels.length
        ? { ready: true, label: "继承 / 用户选择", reason: `未固定模型，可选择 ${compatibleModels.length} 个可用模型。` }
        : unavailable("待配置", "尚无可用模型，请先配置 API 服务并新增兼容模型。");
    if (!compatibleModels.some((model) => model.id === tool.modelConfigId)) return unavailable("绑定不可用", "绑定模型、API 凭据或工作流不可用；不会自动换用其他模型。");
    if (tool.toolKey === "canvas-design-chat") return { ready: true, label: "独立模型已配置", reason: "仅用于自由画布设计讨论，不影响对话改图或画布 Agent；前台不显示模型名称或选择控件。" };
    if (tool.operationType === "chat") return { ready: true, label: tool.toolKey === "canvas-chat" ? "跟随统一模型" : "统一模型已配置", reason: tool.toolKey === "canvas-chat" ? "模型跟随“对话改图”的后台设置；本板块开关仍单独生效。" : "此模型同时用于对话改图与画布 Agent，不影响自由画布设计讨论；设计师端不显示模型名称或选择控件。" };
    return { ready: true, label: "已绑定", reason: `独立绑定：${tool.modelName || compatibleModels.find((model) => model.id === tool.modelConfigId)?.name || tool.modelConfigId}` };
}
