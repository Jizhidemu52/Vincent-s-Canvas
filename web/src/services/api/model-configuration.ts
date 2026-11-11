import type { ModuleKey, ToolKey } from "../../../../shared/feature-catalog";
import type { ApimartImageCost } from "../../../../shared/apimart-image-costs";

export type ProviderProtocol = "openai" | "openai-chat" | "anthropic" | "gemini" | "apimart" | "volcengine" | "runninghub" | "comfyui" | "custom";
export type ServerProvider = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; enabled: boolean; hasCredentials: boolean; createdAt: string; updatedAt: string };
export type ServerModel = { id: string; providerId: string; providerName: string; workflowConfigId:string|null;workflowName:string|null; replacementModelConfigId?:string|null; name: string; publicName?: string; modelId: string; capabilities: Array<"generate" | "edit" | "upscale" | "remove_background" | "batch"|"chat"|"video"|"audio">; creditCost: number; rmbCost: number; imageCost?: ApimartImageCost; concurrencyLimit: number; enabled: boolean };
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
    allowRawPrompt?: boolean;
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
export async function exportConfigurationSnapshot(): Promise<Blob> {
    const response = await fetch(`${root}/export`, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录后导出。"
        : response.status === 403 ? "仅超级管理员可导出配置快照。" : `配置导出失败（${response.status}），请稍后重试。`);
    const snapshot = await response.json() as Record<string, unknown>;
    if (snapshot?.schemaVersion !== 1 || !["providers", "models", "toolConfigurations", "modules", "promptRecipes"].every(key => Array.isArray(snapshot[key]))) {
        throw new Error("配置快照格式无效，未生成下载文件。");
    }
    return new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: "application/json;charset=utf-8" });
}
export const listServerProviders = () => request<{ providers: ServerProvider[] }>(`${root}/providers`);
export const createServerProvider = (input: Omit<ServerProvider, "id" | "hasCredentials" | "createdAt" | "updatedAt"> & { credentials?: Record<string, string> }) => request<{ provider: ServerProvider }>(`${root}/providers`, { method: "POST", body: JSON.stringify(input) });
export const updateServerProvider = (id: string, input: Partial<Omit<ServerProvider, "id" | "hasCredentials" | "createdAt" | "updatedAt">> & { credentials?: Record<string, string> }) => request<{ provider: ServerProvider }>(`${root}/providers/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const listServerModels = () => request<{ models: ServerModel[] }>(`${root}/models`);
export const createServerModel = (input: Omit<ServerModel, "id" | "providerName" | "workflowName">) => request<{ model: ServerModel }>(`${root}/models`, { method: "POST", body: JSON.stringify(input) });
export const updateServerModel = (id: string, input: Partial<Omit<ServerModel, "id" | "providerName" | "workflowName">>) => request<{ model: ServerModel }>(`${root}/models/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const listToolApiConfigurations = () => request<{ tools: ToolApiConfiguration[] }>(`${root}/tool-configurations`);
export type ToolApiConfigurationInput = Pick<ToolApiConfiguration, "modelConfigId" | "enabled" | "creditCostOverride" | "rmbCostOverride" | "allowRawPrompt">;
export const updateToolApiConfiguration = (toolKey: ToolApiConfiguration["toolKey"], input: ToolApiConfigurationInput) => request<{ tool: ToolApiConfigurationInput & { toolKey: string; configurationVersion: number; updatedAt: string } }>(`${root}/tool-configurations/${toolKey}`, { method: "PUT", body: JSON.stringify(input) });
export const listPriceVersions = () => request<{ prices: PriceVersion[] }>(`${root}/prices`);
export const createPriceDraft = (input: Pick<PriceVersion, "operationType" | "label" | "credits" | "rmbCost">) => request<{ price: PriceVersion }>(`${root}/prices`, { method: "POST", body: JSON.stringify(input) });
export const markPriceTesting = (id: string) => request<void>(`${root}/prices/${id}/test`, { method: "POST" });
export const publishPrice = (id: string) => request<void>(`${root}/prices/${id}/publish`, { method: "POST" });

export type LayerStudioPriceInput = { inputRmb: number; lowOutputRmb: number; highOutputRmb: number; sourceNote: string };
export type LayerStudioPrice = LayerStudioPriceInput & { modelConfigId: string; version: number; updatedAt: string };

export function isLayerStudioPricingModel(model: Pick<ServerModel, "modelId" | "providerId" | "workflowConfigId">, providers: Pick<ServerProvider, "id" | "protocol">[]) {
    return model.modelId === "seedream-5-5" && !model.workflowConfigId && providers.some(provider => provider.id === model.providerId && provider.protocol === "apimart");
}

export function validateLayerStudioPriceInput(value: unknown): LayerStudioPriceInput {
    if (!value || typeof value !== "object") throw new Error("请明确填写三项费率与依据。");
    const input = value as LayerStudioPriceInput;
    if (typeof input.inputRmb !== "number" || !Number.isFinite(input.inputRmb) || input.inputRmb < 0 || input.inputRmb > 1000) throw new Error("输入图单价必须明确填写，范围 0–1000 元；不默认免费。");
    if ([input.lowOutputRmb, input.highOutputRmb].some(rate => typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1000)) throw new Error("两档输出单价都必须大于 0 且不超过 1000 元。");
    if (input.highOutputRmb < input.lowOutputRmb) throw new Error("高档输出单价不能低于低档。");
    if ([input.inputRmb, input.lowOutputRmb, input.highOutputRmb].some(rate => Number(rate.toFixed(6)) !== rate)) throw new Error("费率最多支持 6 位小数，请明确确认后填写；不会自动舍入。");
    if (typeof input.sourceNote !== "string" || !input.sourceNote.trim() || input.sourceNote.trim().length > 500) throw new Error("请填写 1–500 字的费率确认依据。");
    return { inputRmb: input.inputRmb, lowOutputRmb: input.lowOutputRmb, highOutputRmb: input.highOutputRmb, sourceNote: input.sourceNote.trim() };
}

export class LayerStudioPricingError extends Error {
    constructor(message: string, readonly uncertain = false) { super(message); this.name = "LayerStudioPricingError"; }
}
function parseLayerStudioPrice(value: unknown): LayerStudioPrice {
    const item = value as LayerStudioPrice;
    const input = validateLayerStudioPriceInput(item);
    if (typeof item.modelConfigId !== "string" || !item.modelConfigId || !Number.isInteger(item.version) || item.version < 1 || typeof item.updatedAt !== "string") throw new Error("费率记录格式无效。");
    return { ...input, modelConfigId: item.modelConfigId, version: item.version, updatedAt: item.updatedAt };
}
async function layerStudioPricingRequest(path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await fetch(path, { ...init, credentials: "include", cache: "no-store", headers: { "content-type": "application/json" } }); }
    catch (error) {
        if (init.signal?.aborted) throw error;
        throw new LayerStudioPricingError(init.method === "PUT" ? "保存结果待核对；编辑内容已保留，请先读取服务端配置，不要重复保存。" : "费率读取失败，请检查网络后重试。", init.method === "PUT");
    }
    if (!response.ok) throw new LayerStudioPricingError(response.status === 403 ? "仅超级管理员可配置图层专用费率。"
        : response.status === 401 ? "登录已失效，编辑内容保留，请重新登录。"
            : response.status === 400 ? "费率或模型条件不符合要求，请检查后保存。"
                : init.method === "PUT" ? "保存结果待核对；请先读取服务端配置，不要重复保存。" : "费率暂时无法读取。", init.method === "PUT" && response.status >= 500);
    try { return await response.json() as Record<string, unknown>; }
    catch { throw new LayerStudioPricingError("费率响应无法确认，请重新读取服务端配置。", init.method === "PUT"); }
}
export async function listLayerStudioPrices(signal?: AbortSignal) {
    const result = await layerStudioPricingRequest(`${root}/layer-studio-pricing`, { signal });
    if (!Array.isArray(result.prices)) throw new LayerStudioPricingError("费率列表格式无效，未覆盖当前编辑。");
    return { prices: result.prices.map(parseLayerStudioPrice) };
}
export async function saveLayerStudioPrice(modelConfigId: string, values: LayerStudioPriceInput, signal?: AbortSignal) {
    const input = validateLayerStudioPriceInput(values);
    const result = await layerStudioPricingRequest(`${root}/layer-studio-pricing/${encodeURIComponent(modelConfigId)}`, { method: "PUT", body: JSON.stringify(input), signal });
    try {
        const price = parseLayerStudioPrice(result.price);
        if (price.modelConfigId !== modelConfigId) throw new Error("费率模型不匹配");
        return { price };
    } catch { throw new LayerStudioPricingError("保存响应无法确认，编辑内容保留；请读取服务端配置核对。", true); }
}
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
