export type ProviderProtocol = "openai" | "gemini" | "apimart" | "volcengine" | "runninghub" | "comfyui" | "custom";
export type ServerProvider = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; enabled: boolean; hasCredentials: boolean; createdAt: string; updatedAt: string };
export type ServerModel = { id: string; providerId: string; providerName: string; workflowConfigId:string|null;workflowName:string|null; replacementModelConfigId?:string|null; name: string; modelId: string; capabilities: Array<"generate" | "edit" | "upscale" | "remove_background" | "batch"|"chat"|"video"|"audio">; creditCost: number; rmbCost: number; concurrencyLimit: number; enabled: boolean };
export type ServerWorkflow={id:string;providerId:string;providerName:string;name:string;protocol:"runninghub"|"comfyui"|"custom";capability:"generate"|"edit"|"upscale"|"batch";workflowId:string|null;submitPath:string;statusPath:string|null;cancelPath:string|null;requestTemplate:Record<string,unknown>;externalTaskPath:string|null;statusValuePath:string|null;successValues:string[];failureValues:string[];outputPath:string;pollIntervalMs:number;timeoutSeconds:number;enabled:boolean};
export type PriceVersion = { id: string; operationType: string; label: string; credits: number; rmbCost: number; version: number; status: "draft" | "testing" | "published" | "retired"; createdAt?: string; publishedAt?: string | null };
export type ToolApiConfiguration = {
    toolKey: "detail-enhance" | "image-edit" | "angle-control" | "seamless-stitch" | "image" | "video";
    label: string;
    operationType: PriceVersion["operationType"];
    capabilities: ServerModel["capabilities"];
    modelConfigId: string | null;
    enabled: boolean;
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
export const updateToolApiConfiguration = (toolKey: ToolApiConfiguration["toolKey"], input: { modelConfigId: string; enabled: boolean }) => request<{ tool: { toolKey: string; modelConfigId: string; enabled: boolean; updatedAt: string } }>(`${root}/tool-configurations/${toolKey}`, { method: "PUT", body: JSON.stringify(input) });
export const listPriceVersions = () => request<{ prices: PriceVersion[] }>(`${root}/prices`);
export const createPriceDraft = (input: Pick<PriceVersion, "operationType" | "label" | "credits" | "rmbCost">) => request<{ price: PriceVersion }>(`${root}/prices`, { method: "POST", body: JSON.stringify(input) });
export const markPriceTesting = (id: string) => request<void>(`${root}/prices/${id}/test`, { method: "POST" });
export const publishPrice = (id: string) => request<void>(`${root}/prices/${id}/publish`, { method: "POST" });
export const listServerWorkflows=()=>request<{workflows:ServerWorkflow[]}>("/api/admin/workflows");
export const createServerWorkflow=(input:Omit<ServerWorkflow,"id"|"providerName">)=>request<{workflow:ServerWorkflow}>("/api/admin/workflows",{method:"POST",body:JSON.stringify(input)});
export const updateServerWorkflow=(id:string,input:Partial<Omit<ServerWorkflow,"id"|"providerName">>)=>request<{workflow:ServerWorkflow}>(`/api/admin/workflows/${id}`,{method:"PATCH",body:JSON.stringify(input)});
