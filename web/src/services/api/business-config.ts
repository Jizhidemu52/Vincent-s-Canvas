import { deploymentFeatures } from "@/lib/deployment-features";
import { getToolDefinition } from "../../../../shared/feature-catalog";

export type PublicModel = {
    id: string;
    name: string;
    modelId: string;
    /** Protocol parameter identity only; never use this value to select a provider. */
    parameterModelId?: string;
    publicName?: string;
    publicDescription?: string;
    /** Server-curated Mark image models only; an absent flag is never featured. */
    isFeatured?: boolean;
    displayOrder?: number;
    modelIdentityHidden?: boolean;
    imageParameterProfile?: import("@/lib/image-model-settings").ImageParameterProfile;
    imageSupportsMask?: boolean;
    imageSupportsOfficialFallback?: boolean;
    capabilities: string[];
    creditCost: number;
    rmbCost: number;
};

export type PublicPrice = {
    operationType: string;
    label: string;
    credits: number;
    rmbCost: number;
    version: number;
};

export type PublicToolConfiguration = {
    toolKey: string;
    modelConfigId: string | null;
    enabled: boolean;
    creditCostOverride: number | null;
    rmbCostOverride: number | null;
    configurationVersion: number;
    label?: string;
    group?: string;
    parent?: string | null;
    operationType?: string;
    capabilities?: readonly string[];
};

export type BusinessConfig = {
    models: PublicModel[];
    prices: PublicPrice[];
    tools: PublicToolConfiguration[];
};

export type UsageEstimate = {
    credits: number;
    rmbCost: number;
    configured: boolean;
};

export async function getBusinessConfig(): Promise<BusinessConfig> {
    const response = await fetch("/api/models", { credentials: "include" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw Object.assign(new Error(payload.message || `业务配置同步失败（${response.status}）`), { status: response.status });
    }
    return response.json() as Promise<BusinessConfig>;
}

export function estimateServerUsage(config: BusinessConfig, input: { operationType: string; modelId?: string; toolKey?: string; quantity?: number }): UsageEstimate {
    const quantity = Math.max(1, Math.floor(input.quantity || 1));
    const price = config.prices.find((item) => item.operationType === input.operationType);
    const tool = input.toolKey ? config.tools.find((item) => item.toolKey === input.toolKey) : undefined;
    const model = input.toolKey ? resolveToolModel(config, input.toolKey, input.modelId) : findModel(config, input.modelId);
    const available = input.toolKey ? tool?.enabled !== false && Boolean(model) : !input.modelId || Boolean(model);
    if (!available) return { credits: 0, rmbCost: 0, configured: false };
    const credits = tool?.creditCostOverride ?? ((price?.credits ?? 0) + (model?.creditCost ?? 0));
    const rmbCost = tool?.rmbCostOverride ?? ((price?.rmbCost ?? 0) + (model?.rmbCost ?? 0));
    return {
        credits: deploymentFeatures.creditsEnabled ? credits * quantity : 0,
        rmbCost: Math.round(rmbCost * quantity * 10_000) / 10_000,
        configured: !deploymentFeatures.creditsEnabled || input.operationType === "chat" || Boolean(price)
            || (tool?.creditCostOverride != null && tool?.rmbCostOverride != null),
    };
}

function findModel(config: BusinessConfig, requestedModelId?: string | null) {
    return requestedModelId ? config.models.find((item) => item.id === requestedModelId || item.modelId === requestedModelId || item.name === requestedModelId) : undefined;
}

/** A disabled or broken binding never falls back to a different model. */
export function resolveToolModel(config: BusinessConfig, toolKey: string, requestedModelId?: string) {
    const tool = config.tools.find((item) => item.toolKey === toolKey);
    if (tool?.enabled === false) return undefined;
    const definition = getToolDefinition(toolKey);
    if (definition?.parent && config.tools.some(item => item.toolKey === definition.parent && !item.enabled)) return undefined;
    if (!tool && !definition) return undefined;
    const capabilities = tool?.capabilities ?? definition?.capabilities;
    const compatible = (model: PublicModel) => !capabilities?.length || capabilities.some((capability) => model.capabilities.includes(capability));
    // All designer LLM calls share this administrative binding. The caller's
    // own switch and pricing remain independent, including canvas-chat.
    if (definition?.operationType === "chat") {
        const managedModelId = config.tools.find(item => item.toolKey === "gpt-chat")?.modelConfigId;
        const managed = managedModelId ? config.models.find(item => item.id === managedModelId) : undefined;
        return managed && compatible(managed) ? managed : undefined;
    }
    if (tool?.modelConfigId) {
        const bound = config.models.find((item) => item.id === tool.modelConfigId);
        return bound && compatible(bound) ? bound : undefined;
    }
    if (requestedModelId) {
        const requested = findModel(config, requestedModelId);
        return requested && compatible(requested) ? requested : undefined;
    }
    return config.models.find(compatible);
}
