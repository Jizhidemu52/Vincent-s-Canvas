import { deploymentFeatures } from "@/lib/deployment-features";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import type { DesignLibraryEntry, DesignLibraryList, DesignLibraryPublishInput, DesignLibraryReceiptInput, DesignLibraryReuse, DesignLibraryStats } from "@/types/design-library";

export type DesignLibraryRequestOptions = { signal?: AbortSignal; expectedOwnerId?: string };
export type DesignLibraryListParams = { scope?: "company" | "mine" | "all"; q?: string; tag?: string; page?: number; pageSize?: number };

export class DesignLibraryRequestError extends Error {
    constructor(message: string, public readonly status: number | null) {
        super(message);
        this.name = "DesignLibraryRequestError";
    }
}

/** Capture this identity before multi-step work; never attribute its result to a new session. */
export function requireDesignLibraryOwner(admin = false, expectedOwnerId?: string): string {
    if (!deploymentFeatures.oaLoginEnabled) throw new Error("公司设计灵感库仅限企业模式使用，本机试用不能发布或访问公司内容");
    const { user, status } = useUserStore.getState();
    if (status !== "authenticated" || !user?.id || user.status !== "active" || (admin ? !isAdminRole(user.role) : user.role !== "designer")) {
        throw new Error(admin ? "请使用有效的公司管理员身份进入" : "员工会话已变化，请从公司 OA 重新进入");
    }
    if (expectedOwnerId && user.id !== expectedOwnerId) throw new Error("员工会话已变化，请从公司 OA 重新进入");
    return user.id;
}

function responseMessage(body: unknown, fallback: string) {
    if (body && typeof body === "object") {
        const values = body as Record<string, unknown>;
        for (const key of ["msg", "message", "error"]) {
            if (typeof values[key] === "string" && values[key].trim()) return values[key];
        }
    }
    return fallback;
}

async function request<T>(path: string, init: RequestInit = {}, options: DesignLibraryRequestOptions = {}, admin = false, blob = false): Promise<T> {
    const owner = requireDesignLibraryOwner(admin, options.expectedOwnerId);
    const timeout = AbortSignal.timeout(blob ? 60_000 : 20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
        const response = await fetch(path, {
            ...init, credentials: "include", cache: "no-store", signal,
            headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers, "X-Canvas-Owner-Id": owner },
        });
        requireDesignLibraryOwner(admin, owner);
        if (blob && response.ok) {
            const result = await response.blob();
            requireDesignLibraryOwner(admin, owner);
            if (!result.size) throw new DesignLibraryRequestError("图片内容为空，请稍后重试", response.status);
            return result as T;
        }
        const body: unknown = await response.json().catch(() => null);
        requireDesignLibraryOwner(admin, owner);
        if (!response.ok) throw new DesignLibraryRequestError(responseMessage(body, `设计灵感库请求失败（${response.status}）`), response.status);
        if (!body || typeof body !== "object" || !("code" in body) || body.code !== 0 || !("data" in body)) {
            throw new DesignLibraryRequestError(responseMessage(body, "设计灵感库返回了无效响应"), response.status);
        }
        return body.data as T;
    } catch (error) {
        requireDesignLibraryOwner(admin, owner);
        if (options.signal?.aborted) throw options.signal.reason;
        if (timeout.aborted) throw new DesignLibraryRequestError("设计灵感库请求超时，请稍后重试", null);
        if (error instanceof TypeError) throw new DesignLibraryRequestError("暂时无法连接设计灵感库，请检查网络后重试", null);
        throw error;
    }
}

const prefix = (admin: boolean) => admin ? "/api/admin/design-library" : "/api/design-library";
const entryPath = (id: string, admin = false) => `${prefix(admin)}/${encodeURIComponent(id)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export function listDesignLibrary(params: DesignLibraryListParams = {}, admin = false, signal?: AbortSignal) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
    return request<DesignLibraryList>(`${prefix(admin)}?${query}`, {}, { signal }, admin);
}

export async function getDesignLibraryEntry(id: string, admin = false, signal?: AbortSignal) {
    return (await request<{ entry: DesignLibraryEntry }>(entryPath(id, admin), {}, { signal }, admin)).entry;
}

export async function publishDesignLibrary(input: DesignLibraryPublishInput, options?: DesignLibraryRequestOptions) {
    return (await request<{ entry: DesignLibraryEntry }>(prefix(false), post(input), options)).entry;
}

export async function withdrawDesignLibrary(id: string, options?: DesignLibraryRequestOptions) {
    return (await request<{ entry: DesignLibraryEntry }>(`${entryPath(id)}/withdraw`, post({}), options)).entry;
}

export async function moderateDesignLibrary(id: string, reason: string, options?: DesignLibraryRequestOptions) {
    return (await request<{ entry: DesignLibraryEntry }>(`${entryPath(id, true)}/moderate`, post({ reason }), options, true)).entry;
}

export function getDesignLibraryStats(id: string, page = 1, admin = false, signal?: AbortSignal) {
    return request<DesignLibraryStats>(`${entryPath(id, admin)}/stats?page=${encodeURIComponent(page)}&pageSize=20`, {}, { signal }, admin);
}

export function recordDesignLibraryEvent(id: string, input: DesignLibraryReceiptInput, options?: DesignLibraryRequestOptions) {
    return request<{ recorded: boolean }>(`${entryPath(id)}/events`, post(input), options);
}

export function downloadDesignLibraryImage(id: string, imageId: string, requestId: string, options?: DesignLibraryRequestOptions) {
    return request<Blob>(`${entryPath(id)}/images/${encodeURIComponent(imageId)}/download`, post({ requestId }), options, false, true);
}

export function reuseDesignLibraryImage(id: string, imageId: string, requestId: string, options?: DesignLibraryRequestOptions) {
    return request<DesignLibraryReuse>(`${entryPath(id)}/images/${encodeURIComponent(imageId)}/reuse`, post({ requestId }), options);
}

/** Never fetch an arbitrary URL from a response with an employee identity header. */
export function fetchDesignLibraryReusedImage(assetId: string, options?: DesignLibraryRequestOptions) {
    return request<Blob>(`/api/assets/${encodeURIComponent(assetId)}/content`, {}, options, false, true);
}
