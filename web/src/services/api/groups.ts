import type { ApiUser } from "./auth";

export type GroupMember = {
  id: string; groupId: string; userId: string; role: "member" | "leader";
  displayName: string; username: string; status: ApiUser["status"];
  departmentId: string; effectiveAt: string;
};
export type DesignerGroup = {
  id: string; name: string; code: string; status: "active" | "disabled";
  departmentId: string; departmentName: string; createdAt: string; members: GroupMember[];
};
export type TeamOverview = {
  group: { id: string; name: string; code: string; departmentName: string; memberCount: number };
  members: Array<{ id: string; displayName: string; username: string; status: ApiUser["status"]; role: "member" | "leader"; effectiveAt: string; creditBalance: number; monthlyCreditLimit: number }>;
  summary: { taskCount: number; successCount: number; credits: number; rmbCost: number };
};
export type TeamHistory = { id: string; userId: string; userName: string; operationType: string; modelName: string | null; prompt: string; credits: number; rmbCost: number; status: string; failureReason: string | null; createdAt: string };
export type TeamAuditLog = { id: string; action: string; targetType: string; targetId: string | null; result: string; detail: Record<string, unknown>; createdAt: string; actorName: string | null };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include", headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || `请求失败（${response.status}）`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const listGroups = () => request<{ groups: DesignerGroup[] }>("/api/admin/groups");
export const createGroup = (input: { name: string; code: string; departmentId: string }) => request<{ group: DesignerGroup }>("/api/admin/groups", { method: "POST", body: JSON.stringify(input) });
export const updateGroup = (id: string, input: Partial<Pick<DesignerGroup, "name" | "code" | "status">>) => request<{ group: DesignerGroup }>(`/api/admin/groups/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteGroup = (id: string) => request<void>(`/api/admin/groups/${id}`, { method: "DELETE" });
export const putGroupMember = (groupId: string, userId: string, role: "member" | "leader") => request<void>(`/api/admin/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId, role }) });
export const removeGroupMember = (groupId: string, userId: string) => request<void>(`/api/admin/groups/${groupId}/members/${userId}`, { method: "DELETE" });
export const getTeamOverview = () => request<TeamOverview>("/api/team");
export const getTeamHistory = () => request<{ history: TeamHistory[] }>("/api/team/history");
export const getTeamAudit = () => request<{ auditLogs: TeamAuditLog[] }>("/api/team/audit");
export async function exportTeamHistory() {
  const response = await fetch("/api/team/history/export", { credentials: "include" });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { message?: string }).message || "报表导出失败");
  return response.blob();
}
