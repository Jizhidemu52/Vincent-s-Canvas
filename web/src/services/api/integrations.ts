export type IntegrationStatus = {
    wecom: { configured: boolean; missing: string[]; callbackUrl: string | null; callbackUsesHttps: boolean };
    objectStorage: { configured: boolean; endpoint: string | null; bucket: string };
    providerEncryption: { configured: boolean };
    taskRuntime: { mockMode: boolean; workerConcurrency: number };
    ldap: { configured: boolean; status: "reserved" };
    oidc: { configured: boolean; status: "reserved" };
};

export async function getIntegrationStatus() {
    const response = await fetch("/api/admin/integrations/status", { credentials: "include" });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message || `系统集成状态加载失败（${response.status}）`);
    }
    return response.json() as Promise<IntegrationStatus>;
}
