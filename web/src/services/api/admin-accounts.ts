import type { ApiUser, ApiUserRole } from "./auth";

export type Department = { id: string; name: string; code: string; createdAt: string };
export type AuditLog = { id: string; action: string; targetType: string; targetId: string | null; result: "success" | "denied" | "failed"; detail: Record<string, unknown>; createdAt: string; actorName: string | null; actorRole: ApiUserRole | null; departmentName: string | null };
export type AccountInput = {
    username: string; displayName: string; email?: string | null; employeeNo?: string | null; password: string;
    role: ApiUserRole; departmentId?: string | null; creditBalance: number; creditLimit: number;
};
export type AccountUpdate = Partial<Pick<ApiUser, "displayName" | "email" | "employeeNo" | "departmentId" | "status" | "creditLimit">> & { role?: "department_admin" | "designer" };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, credentials: "include", headers: { "content-type": "application/json", ...init?.headers } });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || `请求失败（${response.status}）`);
    }
    return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

export const listAccounts = () => request<{ users: ApiUser[] }>("/api/admin/accounts");
export const createAccount = (input: AccountInput) => request<{ user: ApiUser }>("/api/admin/accounts", { method: "POST", body: JSON.stringify(input) });
export const updateAccount = (id: string, input: AccountUpdate) => request<{ user: ApiUser }>(`/api/admin/accounts/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const resetAccountPassword = (id: string, password: string) => request<void>(`/api/admin/accounts/${id}/reset-password`, { method: "POST", body: JSON.stringify({ password }) });
export const adjustAccountCredits = (id: string, amount: number, reason: string) => request<{ user: ApiUser }>(`/api/admin/accounts/${id}/credits`, { method: "POST", body: JSON.stringify({ amount, reason }) });
export const listDepartments = () => request<{ departments: Department[] }>("/api/admin/departments");
export const createDepartment = (name: string, code: string) => request<{ department: Department }>("/api/admin/departments", { method: "POST", body: JSON.stringify({ name, code }) });
export const listAuditLogs = () => request<{ auditLogs: AuditLog[] }>("/api/admin/audit-logs?limit=500");
export const bulkCreateAccounts = (accounts: AccountInput[]) => request<{ created: number; failures: Array<{ index: number; message: string }> }>("/api/admin/accounts/bulk", { method: "POST", body: JSON.stringify({ accounts }) });
