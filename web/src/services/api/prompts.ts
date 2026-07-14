export const ALL_PROMPTS_OPTION = "全部";

export type PromptScope = "personal" | "team" | "public";
export type PromptTargetTool = "image-generation" | "detail-enhance" | "image-edit" | "angle-control" | "batch-edit" | "seamless-stitch" | "video" | "canvas";
export const promptTargetLabels: Record<PromptTargetTool, string> = {
    "image-generation": "文生图", "detail-enhance": "细节增强", "image-edit": "图片编辑", "angle-control": "角度控制",
    "batch-edit": "批量改图", "seamless-stitch": "无缝拼接", video: "视频创作", canvas: "无线画布",
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

export function listPromptTemplates(input: { scope: PromptScope; query?: string; category?: string; tag?: string; favorite?: boolean; sort?: "updated" | "recent" | "used"; page?: number; pageSize?: number } ) {
    const params = new URLSearchParams({ scope: input.scope, page: String(input.page ?? 1), pageSize: String(input.pageSize ?? 24) });
    if (input.query) params.set("query", input.query);
    if (input.category) params.set("category", input.category);
    if (input.tag) params.set("tag", input.tag);
    if (input.favorite !== undefined) params.set("favorite", String(input.favorite));
    if (input.sort) params.set("sort", input.sort);
    return request<{ templates: PromptTemplate[]; total: number; page: number; pageSize: number }>(`/api/prompt-templates?${params}`);
}

export const createPromptTemplate = (input: PromptSnapshotInput) => request<{ template: { id: string; currentVersionId: string } }>("/api/prompt-templates", { method: "POST", body: JSON.stringify(input) });
export const updatePromptTemplate = (id: string, input: PromptSnapshotInput) => request<{ template: PromptTemplate }>(`/api/prompt-templates/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const copyPromptTemplate = (id: string) => request<{ template: PromptTemplate }>(`/api/prompt-templates/${id}/copy`, { method: "POST" });
export const deletePromptTemplate = (id: string) => request<void>(`/api/prompt-templates/${id}`, { method: "DELETE" });
export const setPromptFavorite = (id: string, favorite: boolean) => request<{ favorite: boolean }>(`/api/prompt-templates/${id}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) });
export const savePromptFromTask = (taskId: string) => request<{ template: PromptTemplate }>(`/api/prompt-templates/from-task/${taskId}`, { method: "POST" });
export const savePromptFromAsset = (assetId: string) => request<{ template: PromptTemplate }>(`/api/prompt-templates/from-asset/${assetId}`, { method: "POST" });
export const submitPromptToTeam = (id: string, requestId = crypto.randomUUID()) => request<{ submission: PromptSubmission & { duplicate: boolean } }>(`/api/prompt-templates/${id}/submit`, { method: "POST", body: JSON.stringify({ requestId: `prompt-submit:${requestId}` }) });
export const listPromptSubmissions = () => request<{ submissions: PromptSubmission[] }>("/api/prompt-templates/review/submissions");
export const reviewPromptSubmission = (id: string, decision: "approve" | "reject", note = "") => request<{ submission: PromptSubmission }>(`/api/prompt-templates/review/submissions/${id}`, { method: "POST", body: JSON.stringify({ decision, note }) });
export const promotePromptPublic = (id: string, requestId = crypto.randomUUID()) => request<{ publication: { templateId: string; versionId: string; duplicate: boolean } }>(`/api/prompt-templates/${id}/promote-public`, { method: "POST", body: JSON.stringify({ requestId: `prompt-public:${requestId}` }) });
export const createPublicPrompt = (input: PromptSnapshotInput) => request<{ template: PromptTemplate }>("/api/admin/prompt-templates/public", { method: "POST", body: JSON.stringify(input) });
export const updatePublicPrompt = (id: string, input: PromptSnapshotInput) => request<{ template: PromptTemplate }>(`/api/admin/prompt-templates/public/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const archiveSharedPrompt = (id: string) => request<{ status: string }>(`/api/admin/prompt-templates/${id}/archive`, { method: "POST" });

export const resolvePromptReuse = (id: string, mode: "fill" | "fill_and_generate", requestId = crypto.randomUUID()) =>
    request<{ reuseToken: string; expiresInSeconds: number; mode: "fill" | "fill_and_generate"; pricing: PromptPricingResolution }>(`/api/prompt-templates/${id}/resolve`, { method: "POST", body: JSON.stringify({ mode, requestId: `prompt-reuse:${requestId}` }) });
export const hydratePromptReuse = (token: string) => request<PromptReusePayload>(`/api/prompt-templates/reuse/${encodeURIComponent(token)}`);

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}) {
    const activeCategory = category && category !== ALL_PROMPTS_OPTION ? category : undefined;
    const [team, publicItems] = await Promise.all([
        listPromptTemplates({ scope: "team", query: keyword, category: activeCategory, tag: tag[0], page: 1, pageSize: 100 }),
        listPromptTemplates({ scope: "public", query: keyword, category: activeCategory, tag: tag[0], page: 1, pageSize: 100 }),
    ]);
    const templates = [...team.templates, ...publicItems.templates];
    const items = templates.map(toLegacyPrompt);
    const start = (Math.max(1, page) - 1) * pageSize;
    return {
        items: items.slice(start, start + pageSize),
        tags: Array.from(new Set(templates.flatMap((item) => item.tags))),
        categories: Array.from(new Set(templates.map((item) => item.category).filter(Boolean))),
        total: items.length,
    };
}

function toLegacyPrompt(template: PromptTemplate): Prompt {
    return {
        id: template.id,
        title: template.title,
        coverUrl: "",
        prompt: template.prompt,
        tags: template.tags,
        category: template.category || (template.scope === "team" ? "团队提示词" : "公共提示词"),
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

export function formatPromptDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
