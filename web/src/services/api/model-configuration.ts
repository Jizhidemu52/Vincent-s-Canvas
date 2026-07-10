export type ProviderProtocol = "openai" | "gemini" | "volcengine" | "runninghub" | "comfyui" | "custom";
export type ServerProvider = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; enabled: boolean; hasCredentials: boolean; createdAt: string; updatedAt: string };
export type ServerModel = { id: string; providerId: string; providerName: string; name: string; modelId: string; capabilities: Array<"generate" | "edit" | "upscale" | "remove_background" | "batch">; creditCost: number; rmbCost: number; concurrencyLimit: number; enabled: boolean };
export type PriceVersion = { id: string; operationType: string; label: string; credits: number; rmbCost: number; version: number; status: "draft" | "testing" | "published" | "retired"; createdAt?: string; publishedAt?: string | null };

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
export const createServerModel = (input: Omit<ServerModel, "id" | "providerName">) => request<{ model: ServerModel }>(`${root}/models`, { method: "POST", body: JSON.stringify(input) });
export const updateServerModel = (id: string, input: Partial<Omit<ServerModel, "id" | "providerName">>) => request<{ model: ServerModel }>(`${root}/models/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const listPriceVersions = () => request<{ prices: PriceVersion[] }>(`${root}/prices`);
export const createPriceDraft = (input: Pick<PriceVersion, "operationType" | "label" | "credits" | "rmbCost">) => request<{ price: PriceVersion }>(`${root}/prices`, { method: "POST", body: JSON.stringify(input) });
export const markPriceTesting = (id: string) => request<void>(`${root}/prices/${id}/test`, { method: "POST" });
export const publishPrice = (id: string) => request<void>(`${root}/prices/${id}/publish`, { method: "POST" });
