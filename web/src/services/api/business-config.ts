export type PublicModel = {
    id: string;
    name: string;
    modelId: string;
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

export type BusinessConfig = {
    models: PublicModel[];
    prices: PublicPrice[];
    tools: Array<{ toolKey: string; modelConfigId: string }>;
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
        throw new Error(payload.message || `业务配置同步失败（${response.status}）`);
    }
    return response.json() as Promise<BusinessConfig>;
}

export function estimateServerUsage(config: BusinessConfig, input: { operationType: string; modelId?: string; toolKey?: string; quantity?: number }): UsageEstimate {
    const quantity = Math.max(1, Math.floor(input.quantity || 1));
    const price = config.prices.find((item) => item.operationType === input.operationType);
    const boundModelId = input.toolKey ? config.tools.find((item) => item.toolKey === input.toolKey)?.modelConfigId : undefined;
    const requestedModelId = input.modelId || boundModelId;
    const model = requestedModelId ? config.models.find((item) => item.id === requestedModelId || item.modelId === requestedModelId || item.name === requestedModelId) : undefined;
    return {
        credits: ((price?.credits || 0) + (model?.creditCost || 0)) * quantity,
        rmbCost: Math.round(((price?.rmbCost || 0) + (model?.rmbCost || 0)) * quantity * 10_000) / 10_000,
        configured: Boolean(price && (!input.toolKey || boundModelId) && (!requestedModelId || model)),
    };
}
