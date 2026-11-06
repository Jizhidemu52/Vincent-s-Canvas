export const ALL_PROMPTS_OPTION = "全部";

export type PromptScope = "personal" | "team" | "public";
export type PromptLibraryScope = "all" | "general" | PromptScope;
export type PromptTargetTool = "image-generation" | "detail-enhance" | "image-edit" | "angle-control" | "batch-edit" | "seamless-stitch" | "video" | "canvas";
export const promptTargetLabels: Record<PromptTargetTool, string> = {
    "image-generation": "图像生成", "detail-enhance": "细节增强", "image-edit": "图片编辑", "angle-control": "角度控制",
    "batch-edit": "批量改图", "seamless-stitch": "无缝拼接", video: "视频生成", canvas: "自由画布",
};
export type PromptTemplate = {
    id: string;
    scope: PromptScope;
    ownerUserId: string | null;
    groupId: string | null;
    departmentId: string | null;
    currentVersionId: string;
    version: number;
    title: string;
    prompt: string;
    targetTool: PromptTargetTool;
    modelConfigId: string | null;
    modelSnapshot: { id?: string; name?: string; modelId?: string; capabilities?: string[] };
    parameters: Record<string, unknown>;
    referenceAssetIds: string[];
    category: string;
    tags: string[];
    notes: string;
    sourceTaskId: string | null;
    sourceAssetId: string | null;
    favorite: boolean;
    useCount: number;
    lastUsedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type PromptSnapshotInput = Pick<PromptTemplate, "title" | "prompt" | "targetTool" | "parameters" | "referenceAssetIds" | "category" | "tags" | "notes"> & {
    modelConfigId?: string | null;
    sourceTaskId?: string | null;
    sourceAssetId?: string | null;
};

export type PromptSubmission = {
    id: string;
    status: "pending" | "approved" | "rejected" | "withdrawn";
    reviewNote: string;
    createdAt: string;
    reviewedAt: string | null;
    sourceTemplateId: string;
    sourceVersionId: string;
    targetGroupId: string;
    submitterName: string;
    title: string;
    prompt: string;
};

export type PromptPriceEstimate = {
    operationType: string;
    totalCredits: number;
    totalRmb: number;
    quantity: number;
    priceVersion: number;
};

export type PromptPricingResolution = {
    operationType: string;
    modelChanged: boolean;
    reason: string | null;
    selectedModel: { id: string; name: string; modelId: string } | null;
    estimate: PromptPriceEstimate | null;
    alternatives: Array<{ model: { id: string; name: string; modelId: string }; estimate: PromptPriceEstimate }>;
};

export type PromptReusePayload = {
    template: PromptTemplate;
    mode: "fill" | "fill_and_generate";
    pricing: PromptPricingResolution;
    warnings: string[];
};

export type Prompt = {
    id: string;
    scope: Exclude<PromptLibraryScope, "all">;
    templateId: string | null;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
    targetTool: PromptTargetTool;
    modelId: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...init, headers, credentials: "include" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || `提示词请求失败（${response.status}）`);
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function listPromptTemplates(input: { scope: PromptScope; query?: string; category?: string; tag?: string; favorite?: boolean; sort?: "updated" | "recent" | "used"; page?: number; pageSize?: number }, signal?: AbortSignal) {
    const params = new URLSearchParams({ scope: input.scope, page: String(input.page ?? 1), pageSize: String(input.pageSize ?? 24) });
    if (input.query) params.set("query", input.query);
    if (input.category) params.set("category", input.category);
    if (input.tag) params.set("tag", input.tag);
    if (input.favorite !== undefined) params.set("favorite", String(input.favorite));
    if (input.sort) params.set("sort", input.sort);
    return request<{ templates: PromptTemplate[]; total: number; page: number; pageSize: number }>(`/api/prompt-templates?${params}`, { signal, cache: "no-store" });
}

export const createPromptTemplate = (input: PromptSnapshotInput) => request<{ template: { id: string; currentVersionId: string } }>("/api/prompt-templates", { method: "POST", body: JSON.stringify(input) });
export const updatePromptTemplate = (id: string, input: PromptSnapshotInput) => request<{ template: PromptTemplate }>(`/api/prompt-templates/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const copyPromptTemplate = (id: string) => request<{ template: PromptTemplate }>(`/api/prompt-templates/${id}/copy`, { method: "POST" });
export const deletePromptTemplate = (id: string) => request<void>(`/api/prompt-templates/${id}`, { method: "DELETE" });
export const setPromptFavorite = (id: string, favorite: boolean) => request<{ favorite: boolean }>(`/api/prompt-templates/${id}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) });
export const savePromptFromTask = (taskId: string) => request<{ template: PromptTemplate }>(`/api/prompt-templates/from-task/${taskId}`, { method: "POST" });
export const savePromptFromAsset = (assetId: string) => request<{ template: PromptTemplate }>(`/api/prompt-templates/from-asset/${assetId}`, { method: "POST" });
export const submitPromptToTeam = (id: string, requestId = createClientId()) => request<{ submission: PromptSubmission & { duplicate: boolean } }>(`/api/prompt-templates/${id}/submit`, { method: "POST", body: JSON.stringify({ requestId: `prompt-submit:${requestId}` }) });
export const listPromptSubmissions = () => request<{ submissions: PromptSubmission[] }>("/api/prompt-templates/review/submissions");
export const reviewPromptSubmission = (id: string, decision: "approve" | "reject", note = "") => request<{ submission: PromptSubmission }>(`/api/prompt-templates/review/submissions/${id}`, { method: "POST", body: JSON.stringify({ decision, note }) });
export const promotePromptPublic = (id: string, requestId = createClientId()) => request<{ publication: { templateId: string; versionId: string; duplicate: boolean } }>(`/api/prompt-templates/${id}/promote-public`, { method: "POST", body: JSON.stringify({ requestId: `prompt-public:${requestId}` }) });
export const createPublicPrompt = (input: PromptSnapshotInput) => request<{ template: PromptTemplate }>("/api/admin/prompt-templates/public", { method: "POST", body: JSON.stringify(input) });
export const updatePublicPrompt = (id: string, input: PromptSnapshotInput) => request<{ template: PromptTemplate }>(`/api/admin/prompt-templates/public/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const archiveSharedPrompt = (id: string) => request<{ status: string }>(`/api/admin/prompt-templates/${id}/archive`, { method: "POST" });

export const resolvePromptReuse = (id: string, mode: "fill" | "fill_and_generate", requestId = createClientId()) =>
    request<{ reuseToken: string; expiresInSeconds: number; mode: "fill" | "fill_and_generate"; pricing: PromptPricingResolution }>(`/api/prompt-templates/${id}/resolve`, { method: "POST", body: JSON.stringify({ mode, requestId: `prompt-reuse:${requestId}` }) });
export async function hydratePromptReuse(token: string): Promise<PromptReusePayload> {
    const payload = await request<PromptReusePayload>(`/api/prompt-templates/reuse/${encodeURIComponent(token)}`);
    const archive = payload.template.parameters.inputArchive as import("./generation-history").GenerationInputArchive | undefined;
    const index = archive?.markupReferenceIndex;
    if (index === undefined) return payload;
    const { imageModelProfile } = await import("@/lib/image-model-settings");
    const { readImageOptions } = await import("@/lib/image-advanced-settings");
    const { fingerprintImage } = await import("./generation-history");
    const model = payload.pricing.selectedModel;
    if (!model || !imageModelProfile(model.modelId).supportsMarkup) throw new Error("原标注层模型已不可用，不能把标注层降级为普通参考图；当前草稿未修改");
    if (!["image-generation", "image-edit", "canvas"].includes(payload.template.targetTool)) throw new Error("当前工具不支持独立标注层复用；当前草稿未修改");
    if (!Number.isInteger(index) || index < 1 || index >= payload.template.referenceAssetIds.length || archive?.maskReferenceIndex !== undefined
        || !Array.isArray(archive?.references) || archive.references.length !== payload.template.referenceAssetIds.length) throw new Error("模板标注层顺序不完整，未套用任何内容");
    const original = archive.references[index]!;
    const assetId = payload.template.referenceAssetIds[index]!;
    if (original.type !== "image/png" || !/^[a-f0-9]{64}$/.test(original.sha256) || !Number.isSafeInteger(original.bytes) || original.bytes <= 0 || original.bytes > 50 * 1024 * 1024
        || !/^[a-zA-Z0-9_-]+$/.test(assetId)) throw new Error("模板标注层原件记录无效，未套用任何内容");
    const dataUrl = `/api/assets/${assetId}/content`;
    const response = await fetch(dataUrl, { credentials: "include" });
    if (!response.ok) throw new Error("模板标注层原件不可用，未套用任何内容");
    const blob = await response.blob();
    if (blob.size !== original.bytes || await fingerprintImage(blob) !== original.sha256) throw new Error("模板标注层不是原始 PNG 字节，未套用任何内容");
    const options = readImageOptions(typeof payload.template.parameters.imageOptions === "string" ? payload.template.parameters.imageOptions : archive.config?.imageOptions);
    const markup = { id: `template:${payload.template.id}:markup`, name: original.name, originalFileName: original.originalFileName, type: "image/png", bytes: original.bytes, dataUrl, sourceAssetId: assetId };
    // Keep the original archive and its source roles intact for provenance. Only
    // the UI reference list is split; the image request adds markup back last.
    return { ...payload, template: { ...payload.template,
        referenceAssetIds: payload.template.referenceAssetIds.filter((_, referenceIndex) => referenceIndex !== index),
        parameters: { ...payload.template.parameters, imageOptions: JSON.stringify({ ...options, markup_reference: JSON.stringify(markup) }) },
    } };
}

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page = 1, pageSize = 20, scope = "all" }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number; scope?: "all" | PromptScope } = {}, signal?: AbortSignal) {
    const activeCategory = category && category !== ALL_PROMPTS_OPTION ? category : undefined;
    const scopes: PromptScope[] = scope === "all" ? ["personal", "team", "public"] : [scope];
    // Each source keeps its own server pagination and access checks. Never cap
    // a user's library at the first 100 rows or enumerate another owner's data.
    const pages = await Promise.all(scopes.map(source => listPromptTemplates({ scope: source, query: keyword, category: activeCategory, tag: tag[0], page, pageSize }, signal)));
    const templates = pages.flatMap(result => result.templates);
    const items = templates.map(toLegacyPrompt);
    return {
        items,
        tags: Array.from(new Set(templates.flatMap((item) => item.tags))),
        categories: Array.from(new Set(templates.map((item) => item.category).filter(Boolean))),
        total: pages.reduce((total, result) => total + result.total, 0),
    };
}

function toLegacyPrompt(template: PromptTemplate): Prompt {
    return {
        id: template.id,
        scope: template.scope,
        templateId: template.id,
        title: template.title,
        coverUrl: "",
        prompt: template.prompt,
        tags: template.tags,
        category: template.category,
        preview: template.notes,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
        targetTool: template.targetTool,
        modelId: template.modelSnapshot.modelId || "",
    };
}

export function promptDestination(targetTool: PromptTargetTool, reuseToken: string) {
    const params = new URLSearchParams({ reuseToken });
    if (targetTool === "video") return `/video?${params}`;
    if (targetTool === "canvas" || targetTool === "batch-edit") {
        params.set("mode", "new");
        params.set("promptTool", targetTool);
        return `/canvas?${params}`;
    }
    if (targetTool !== "image-generation") params.set("tool", targetTool);
    return `/image?${params}`;
}

export function formatPromptDate(value: string, locale = "zh-CN") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
import { createClientId } from "@/lib/client-id";
