export type CreditPolicy = { creditsEnabled: boolean; updatedAt: string | null };

async function requestCreditPolicy(init?: RequestInit): Promise<CreditPolicy> {
    const response = await fetch("/api/admin/credit-policy", {
        ...init, credentials: "include", cache: "no-store", headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
        if (response.status === 401) throw new Error("登录已失效，请重新登录后台");
        if (response.status === 403) throw new Error("仅超级管理员可修改积分计费开关");
        throw new Error(`积分计费配置请求失败（${response.status}），请刷新重试`);
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("creditsEnabled" in value) || typeof value.creditsEnabled !== "boolean"
        || !("updatedAt" in value) || (value.updatedAt !== null && typeof value.updatedAt !== "string")) {
        throw new Error("积分计费配置响应无效，无法确认当前状态");
    }
    return value as CreditPolicy;
}

export const getCreditPolicy = (signal?: AbortSignal) => requestCreditPolicy({ signal });
export const saveCreditPolicy = (creditsEnabled: boolean, signal?: AbortSignal) => requestCreditPolicy({ method: "PATCH", body: JSON.stringify({ creditsEnabled }), signal });
