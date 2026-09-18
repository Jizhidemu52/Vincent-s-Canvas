export type ApiUserRole = "super_admin" | "department_admin" | "designer";

export type ApiUser = {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    employeeNo: string | null;
    role: ApiUserRole;
    status: "active" | "disabled" | "locked";
    departmentId: string | null;
    departmentName: string | null;
    groupId: string | null;
    groupName: string | null;
    groupRole: "member" | "leader" | null;
    mustChangePassword: boolean;
    mfaEnabled: boolean;
    creditBalance: number;
    creditLimit: number;
    monthlyCreditLimit: number;
    temporaryCreditAdjustment: number;
    creditPeriodStart: string;
    creditResetAt: string;
};

type ErrorPayload = { message?: string };

export class AuthRequestError extends Error {
    constructor(message: string, public readonly status: number | null) {
        super(message);
        this.name = "AuthRequestError";
    }
}


async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        credentials: "include",
        headers: { "content-type": "application/json", ...init?.headers },
    }).catch(() => { throw new AuthRequestError("暂时无法连接认证服务", null); });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
        throw new AuthRequestError(payload.message || "认证请求失败", response.status);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json().catch(() => { throw new AuthRequestError("认证服务返回了无效响应", response.status); })) as T);
}

async function requestIdentity(path: string, init?: RequestInit) {
    const result = await apiRequest<{ user: ApiUser }>(path, init);
    if (!result?.user || typeof result.user.id !== "string" || !result.user.id.trim()) {
        throw new AuthRequestError("认证服务未返回有效身份", 200);
    }
    return result;
}

export async function loginWithPassword(identifier: string, password: string, portal: "designer" | "admin") {
    return requestIdentity("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password, portal }) });
}

export async function getCurrentSession() {
    return requestIdentity("/api/auth/session");
}

export async function exchangeOaToken(token: string) {
    return requestIdentity("/api/auth/oa/exchange", {
        method: "POST",
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
        referrerPolicy: "no-referrer",
    });
}


export async function logoutSession() {
    return apiRequest<void>("/api/auth/logout", { method: "POST" });
}

export async function changeOwnPassword(currentPassword: string, newPassword: string) {
    return apiRequest<void>("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
}
