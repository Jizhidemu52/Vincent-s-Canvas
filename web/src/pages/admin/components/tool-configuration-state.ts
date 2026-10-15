import { toolDefinitions } from "@/services/api/modules";
import type { ServerModel, ServerProvider, ServerWorkflow, ToolApiConfiguration, ToolApiConfigurationInput } from "@/services/api/model-configuration";

export function completeToolConfigurations(configurations: ToolApiConfiguration[]): ToolApiConfiguration[] {
    return toolDefinitions.map((definition) => ({
        ...definition, modelConfigId: null, enabled: true,
        creditCostOverride: null, rmbCostOverride: null, configurationVersion: 0, price: null,
        ...configurations.find((item) => item.toolKey === definition.toolKey),
        capabilities: [...definition.capabilities],
    }));
}

export function compatibleToolModels(tool: ToolApiConfiguration, models: ServerModel[], providers: ServerProvider[], workflows: ServerWorkflow[]) {
    return models.filter((model) => {
        const provider = providers.find((item) => item.id === model.providerId);
        const workflow = model.workflowConfigId ? workflows.find((item) => item.id === model.workflowConfigId) : undefined;
        return model.enabled && tool.capabilities.some((capability) => model.capabilities.includes(capability))
            && provider?.enabled && (provider.hasCredentials || provider.protocol === "comfyui" || provider.protocol === "custom")
            && (!model.workflowConfigId || workflow?.enabled);
    });
}

export function buildToolConfigurationInput(tool: ToolApiConfiguration, values: Partial<ToolApiConfigurationInput>): ToolApiConfigurationInput {
    return {
        modelConfigId: values.modelConfigId || null, enabled: values.enabled ?? true,
        creditCostOverride: tool.operationType === "chat" ? null : values.creditCostOverride ?? null,
        rmbCostOverride: tool.operationType === "chat" ? null : values.rmbCostOverride ?? null,
    };
}

export function toolConfigurationState(tool: ToolApiConfiguration, compatibleModels: ServerModel[]) {
    const unavailable = (label: string, reason: string) => ({ ready: false, label, reason });
    if (!tool.enabled) return unavailable("已停用", "本板块 API 已停用，不会回退到其他模型。");
    if (!tool.modelConfigId) return compatibleModels.length
        ? { ready: true, label: "继承 / 用户选择", reason: `未固定模型，可选择 ${compatibleModels.length} 个可用模型。` }
        : unavailable("待配置", "尚无可用模型，请先配置 API 服务并新增兼容模型。");
    if (!compatibleModels.some((model) => model.id === tool.modelConfigId)) return unavailable("绑定不可用", "绑定模型、API 凭据或工作流不可用；不会自动换用其他模型。");
    return { ready: true, label: "已绑定", reason: `独立绑定：${tool.modelName || compatibleModels.find((model) => model.id === tool.modelConfigId)?.name || tool.modelConfigId}` };
}
