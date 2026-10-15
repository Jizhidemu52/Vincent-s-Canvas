import type { ModuleKey, ToolKey } from "../../../../shared/feature-catalog";

export type ProviderProtocol = "openai" | "openai-chat" | "anthropic" | "gemini" | "apimart" | "volcengine" | "runninghub" | "comfyui" | "custom";
export type ServerProvider = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; enabled: boolean; hasCredentials: boolean; createdAt: string; updatedAt: string };
export type ServerModel = { id: string; providerId: string; providerName: string; workflowConfigId:string|null;workflowName:string|null; replacementModelConfigId?:string|null; name: string; publicName?: string; modelId: string; capabilities: Array<"generate" | "edit" | "upscale" | "remove_background" | "batch"|"chat"|"video"|"audio">; creditCost: number; rmbCost: number; concurrencyLimit: number; enabled: boolean };
export type ServerWorkflow={id:string;providerId:string;providerName:string;name:string;protocol:"runninghub"|"comfyui"|"custom";capability:"generate"|"edit"|"upscale"|"batch";workflowId:string|null;submitPath:string;statusPath:string|null;cancelPath:string|null;requestTemplate:Record<string,unknown>;externalTaskPath:string|null;statusValuePath:string|null;successValues:string[];failureValues:string[];outputPath:string;pollIntervalMs:number;timeoutSeconds:number;enabled:boolean};
export type PriceVersion = { id: string; operationType: string; label: string; credits: number; rmbCost: number; version: number; status: "draft" | "testing" | "published" | "retired"; createdAt?: string; publishedAt?: string | null };
export type ToolApiConfiguration = {
    toolKey: ToolKey;
    label: string;
    group: string;
    parent: ModuleKey | null;
    operationType: PriceVersion["operationType"];
    capabilities: ServerModel["capabilities"];
    modelConfigId: string | null;
    enabled: boolean;
    creditCostOverride: number | null;
    rmbCostOverride: number | null;
    configurationVersion: number;
    modelName?: string;
    modelId?: string;
    modelCreditCost?: number;
    modelRmbCost?: number;
    modelEnabled?: boolean;
    providerId?: string;
    providerName?: string;
    protocol?: ProviderProtocol;
    baseUrl?: string;
    providerEnabled?: boolean;
    hasCredentials?: boolean;
    workflowConfigId?: string | null;
    workflowName?: string | null;
    workflowEnabled?: boolean | null;
    price: { operationType: string; credits: number; rmbCost: number; version: number } | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, credentials: "include", headers: { "content-type": "application/json", ...init?.headers } });
    if (!response.ok) { const payload = await response.json().catch(() => ({})) as { message?: string }; throw new Error(payload.message || `请求失败（${response.status}）`); }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

const root = "/api/admin/model-configuration";
export const listServerProviders = () => request<{ providers: ServerProvider[] }>(`${root}/providers`);
export const createServerProvider = (input: Omit<ServerProvider, "id" | "hasCredentials" | "createdAt" | "updatedAt"> & { credentials?: Record<string, string> }) => request<{ provider: ServerProvider }>(`${root}/providers`, { method: "POST", body: JSON.stringify(input) });
export const updateServerProvider = (id: string, input: Partial<Omit<ServerProvider, "id" | "hasCredentials" | "createdAt" | "updatedAt">> & { credentials?: Record<string, string> }) => request<{ provider: ServerProvider }>(`${root}/providers/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const listServerModels = () => request<{ models: ServerModel[] }>(`${root}/models`);
export const createServerModel = (input: Omit<ServerModel, "id" | "providerName" | "workflowName">) => request<{ model: ServerModel }>(`${root}/models`, { method: "POST", body: JSON.stringify(input) });
export const updateServerModel = (id: string, input: Partial<Omit<ServerModel, "id" | "providerName" | "workflowName">>) => request<{ model: ServerModel }>(`${root}/models/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const listToolApiConfigurations = () => request<{ tools: ToolApiConfiguration[] }>(`${root}/tool-configurations`);
export type ToolApiConfigurationInput = Pick<ToolApiConfiguration, "modelConfigId" | "enabled" | "creditCostOverride" | "rmbCostOverride">;
export const updateToolApiConfiguration = (toolKey: ToolApiConfiguration["toolKey"], input: ToolApiConfigurationInput) => request<{ tool: ToolApiConfigurationInput & { toolKey: string; configurationVersion: number; updatedAt: string } }>(`${root}/tool-configurations/${toolKey}`, { method: "PUT", body: JSON.stringify(input) });
export const listPriceVersions = () => request<{ prices: PriceVersion[] }>(`${root}/prices`);
export const createPriceDraft = (input: Pick<PriceVersion, "operationType" | "label" | "credits" | "rmbCost">) => request<{ price: PriceVersion }>(`${root}/prices`, { method: "POST", body: JSON.stringify(input) });
export const markPriceTesting = (id: string) => request<void>(`${root}/prices/${id}/test`, { method: "POST" });
export const publishPrice = (id: string) => request<void>(`${root}/prices/${id}/publish`, { method: "POST" });
export const listServerWorkflows=()=>request<{workflows:ServerWorkflow[]}>("/api/admin/workflows");
export const createServerWorkflow=(input:Omit<ServerWorkflow,"id"|"providerName">)=>request<{workflow:ServerWorkflow}>("/api/admin/workflows",{method:"POST",body:JSON.stringify(input)});
export const updateServerWorkflow=(id:string,input:Partial<Omit<ServerWorkflow,"id"|"providerName">>)=>request<{workflow:ServerWorkflow}>(`/api/admin/workflows/${id}`,{method:"PATCH",body:JSON.stringify(input)});

export type FeaturedModelCandidate = Omit<ServerModel, "workflowConfigId" | "workflowName"> & {
    protocol: "apimart";
    providerEnabled: boolean;
    hasCredentials: boolean;
    isFeatured: boolean;
    displayOrder: number;
};
export type FeaturedModelConfiguration = {
    models: FeaturedModelCandidate[];
    featuredModelIds: string[];
    maxFeatured: 5;
};

export class FeaturedModelConfigurationError extends Error {}

async function featuredModelsRequest(init?: RequestInit): Promise<FeaturedModelConfiguration> {
    try {
        const response = await fetch(`${root}/featured-models`, { ...init, credentials: "include", cache: "no-store", headers: { "content-type": "application/json" } });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({})) as { error?: string };
            const message = response.status === 401 ? "登录已失效，请重新登录后再配置热门模型。"
                : response.status === 403 ? "仅超级管理员可配置热门模型。"
                : response.status === 404 ? "当前服务未提供热门模型配置，请确认已连接最新正式后台。"
                : payload.error === "INVALID_FEATURED_MODEL" ? "所选模型已停用或不属于 Mark 图片接口，请重新加载后选择。"
                : response.status === 400 ? "热门模型最多选择 5 个且不可重复，请检查后重试。"
                : "热门模型配置请求失败，请稍后重试。";
            throw new FeaturedModelConfigurationError(message);
        }
        const result = await response.json() as FeaturedModelConfiguration;
        if (!Array.isArray(result.models) || !Array.isArray(result.featuredModelIds) || result.maxFeatured !== 5
            || result.featuredModelIds.some(id => typeof id !== "string") || new Set(result.featuredModelIds).size !== result.featuredModelIds.length
            || result.featuredModelIds.length > 5
            || result.models.some(model => !model || typeof model.id !== "string" || typeof model.name !== "string" || model.protocol !== "apimart"
                || typeof model.enabled !== "boolean" || typeof model.providerEnabled !== "boolean" || typeof model.hasCredentials !== "boolean")) {
            throw new FeaturedModelConfigurationError("热门模型配置响应无效，请重新加载。");
        }
        return result;
    } catch (error) {
        if (error instanceof FeaturedModelConfigurationError || (error instanceof Error && error.name === "AbortError")) throw error;
        throw new FeaturedModelConfigurationError("热门模型配置暂时不可用，请检查网络后重试。");
    }
}

export const getFeaturedModelConfiguration = (signal?: AbortSignal) => featuredModelsRequest({ signal });
export const saveFeaturedModelConfiguration = (modelConfigIds: string[], signal?: AbortSignal) => featuredModelsRequest({ method: "PUT", body: JSON.stringify({ modelConfigIds }), signal });
