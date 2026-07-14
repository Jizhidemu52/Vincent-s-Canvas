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

export type DemoLoginAccount = { identifier: string; password: string; label: string; portal: "designer" | "admin" };

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        credentials: "include",
        headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
        throw new Error(payload.message || `请求失败（${response.status}）`);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export async function loginWithPassword(identifier: string, password: string, portal: "designer" | "admin") {
    return apiRequest<{ user: ApiUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password, portal }) });
}

export async function getCurrentSession() {
    return apiRequest<{ user: ApiUser }>("/api/auth/session");
}

export async function getDemoAccounts() {
    return apiRequest<{ accounts: DemoLoginAccount[] }>("/api/demo/accounts");
}

export async function logoutSession() {
    return apiRequest<void>("/api/auth/logout", { method: "POST" });
}

export async function changeOwnPassword(currentPassword: string, newPassword: string) {
    return apiRequest<void>("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
}

export async function getWeComLoginUrl(portal: "designer" | "admin" = "designer") {
    return apiRequest<{ authorizationUrl: string }>(`/api/auth/wecom/start?portal=${portal}`);
}
