export type UncertainTask = {
  id: string; requestId: string; displayName: string; modelName: string; operationType: string;
  credits: number; upstreamTaskId: string | null; failureReason: string | null;
  resultUrls: string[]; canAttachUpstream: boolean; billingStatus: string | null;
};
export type UncertainChat = { id: string; requestId: string; displayName: string; modelName: string; credits: number; createdAt: string };
export type TaskResolution = { reason: string; evidenceReference: string } & (
  { decision: "confirmed_failed" | "confirmed_not_submitted" } |
  { decision: "confirmed_success"; resultAssetIds?: string[] } |
  { decision: "attach_upstream"; upstreamTaskId: string }
);
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/admin/task-reconciliation${path}`, {
    credentials: "include", ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => null) as { code?: number | string; data?: T; msg?: string } | null;
  if (!response.ok || result?.code !== 0 || !result.data) throw new Error(result?.msg || "核查请求失败，请刷新原记录确认状态后再操作");
  return result.data;
}
export const listTaskReconciliation = () => request<{ tasks: UncertainTask[]; chats: UncertainChat[]; minimumChatAgeMinutes: number }>("?limit=100");
export const resolveUncertainTask = (id: string, body: TaskResolution) => request<{ queuePending?: boolean; status: string }>(`/tasks/${encodeURIComponent(id)}/resolve`, body);
export const resolveUncertainChat = (requestId: string, body: { action: "capture" | "release"; reason: string; evidenceReference: string }) => request("/chat/resolve", { ...body, requestId });
