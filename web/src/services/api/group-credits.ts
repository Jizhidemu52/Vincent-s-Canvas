export type CreditRequestStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";

export type GroupCreditRequest = {
  id: string;
  requestId: string;
  userId?: string;
  userName?: string;
  amount: number;
  reason: string;
  status: CreditRequestStatus;
  decisionNote: string | null;
  reviewerName?: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type GroupCreditPolicy = {
  monthlySharedCreditLimit: number;
  perRequestLimit: number;
  dailyUserLimit: number;
  monthlyUserLimit: number;
};

export type MyGroupCredits = {
  groupId: string;
  periodStart: string;
  poolBalance: number;
  policy: GroupCreditPolicy;
  wallet: { grantedCredits: number; availableCredits: number; spentCredits: number };
  requests: GroupCreditRequest[];
};

export type ManagedGroupCredits = {
  groupId: string;
  period: {
    periodStart: string;
    fixedCredits: number;
    contributedCredits: number;
    allocatedCredits: number;
    expiredCredits: number;
    poolBalance: number;
  };
  policy: GroupCreditPolicy;
  requests: GroupCreditRequest[];
  wallets: Array<{
    userId: string; userName: string; grantedCredits: number; availableCredits: number; spentCredits: number;
  }>;
  ledger: Array<{
    id: string; entryType: string; userId: string | null; poolAmount: number; walletAmount: number;
    poolBalanceAfter: number | null; walletBalanceAfter: number | null; reason: string; createdAt: string;
  }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export const getMyGroupCredits = () => request<MyGroupCredits>("/api/group-credits");
export const submitGroupCreditRequest = (input: { requestId: string; amount: number; reason: string }) =>
  request<{ id: string; status: string; duplicate: boolean }>("/api/group-credits/requests", { method: "POST", body: JSON.stringify(input) });
export const contributeGroupCredits = (input: { requestId: string; amount: number }) =>
  request<{ poolBalance: number; personalBalance: number; duplicate: boolean }>("/api/group-credits/contributions", { method: "POST", body: JSON.stringify(input) });
export const getTeamGroupCredits = () => request<ManagedGroupCredits>("/api/team/group-credits");
export const decideTeamGroupCreditRequest = (id: string, decision: "approved" | "rejected", note?: string) =>
  request<{ status: string; duplicate: boolean }>(`/api/team/group-credits/requests/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, note }) });
export const getAdminGroupCredits = (groupId: string) => request<ManagedGroupCredits>(`/api/admin/group-credits/${groupId}`);
export const updateGroupCreditPolicy = (groupId: string, input: GroupCreditPolicy & { applyCurrentPeriod: boolean }) =>
  request(`/api/admin/group-credits/${groupId}/policy`, { method: "PATCH", body: JSON.stringify(input) });
export const decideAdminGroupCreditRequest = (groupId: string, id: string, decision: "approved" | "rejected", note?: string) =>
  request<{ status: string; duplicate: boolean }>(`/api/admin/group-credits/${groupId}/requests/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, note }) });
