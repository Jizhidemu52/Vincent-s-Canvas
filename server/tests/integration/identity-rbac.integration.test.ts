import { describe, expect, test } from "bun:test";

import { totpCode } from "../../src/security";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "true";
const integration = runIntegration ? describe : describe.skip;
const baseUrl = process.env.INTEGRATION_BASE_URL ?? "http://127.0.0.1:3100";

type ApiResponse<T> = { response: Response; body: T };

async function api<T>(path: string, options: RequestInit = {}, cookie?: string): Promise<ApiResponse<T>> {
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: "manual" });
    const contentType = response.headers.get("content-type") ?? "";
    const body = (contentType.includes("application/json") ? await response.json() : await response.text()) as T;
    return { response, body };
}

async function login(identifier: string, password: string, portal: "designer" | "admin") {
    const result = await api<{ user: { id: string; mustChangePassword: boolean; mfaEnabled: boolean } }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password, portal }),
    });
    expect(result.response.status).toBe(200);
    const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    return { cookie: cookie!, user: result.body.user };
}

async function changePassword(cookie: string, currentPassword: string, newPassword: string) {
    const result = await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
    }, cookie);
    expect(result.response.status).toBe(204);
}

integration("production identity and RBAC", () => {
    test("enforces onboarding, account scope, 100-user import, durable sessions and project isolation", async () => {
        const admin = await login("admin", "AdminStart2026", "admin");
        expect(admin.user.mustChangePassword).toBe(true);

        const beforePassword = await api<{ error: string }>("/api/admin/departments", {}, admin.cookie);
        expect(beforePassword.response.status).toBe(403);
        expect(beforePassword.body.error).toBe("PASSWORD_CHANGE_REQUIRED");

        await changePassword(admin.cookie, "AdminStart2026", "AdminReady2026");
        const beforeMfa = await api<{ error: string }>("/api/admin/departments", {}, admin.cookie);
        expect(beforeMfa.response.status).toBe(403);
        expect(beforeMfa.body.error).toBe("MFA_SETUP_REQUIRED");

        const setup = await api<{ secret: string }>("/api/auth/mfa/setup", { method: "POST" }, admin.cookie);
        expect(setup.response.status).toBe(200);
        const enable = await api("/api/auth/mfa/enable", {
            method: "POST",
            body: JSON.stringify({ code: totpCode(setup.body.secret) }),
        }, admin.cookie);
        expect(enable.response.status).toBe(204);

        const restoredSession = await api<{ user: { mustChangePassword: boolean; mfaEnabled: boolean } }>("/api/auth/session", {}, admin.cookie);
        expect(restoredSession.response.status).toBe(200);
        expect(restoredSession.body.user).toMatchObject({ mustChangePassword: false, mfaEnabled: true });

        const integrations = await api<{ wecom: { configured: boolean; missing: string[] }; objectStorage: { configured: boolean } }>("/api/admin/integrations/status", {}, admin.cookie);
        expect(integrations.response.status).toBe(200);
        expect(integrations.body.wecom).toMatchObject({ configured: false, missing: ["WECOM_CORP_ID", "WECOM_AGENT_ID", "WECOM_SECRET", "WECOM_CALLBACK_URL"] });
        expect(JSON.stringify(integrations.body)).not.toContain("server-secret");

        const createDepartment = async (name: string, code: string) => {
            const result = await api<{ department: { id: string } }>("/api/admin/departments", {
                method: "POST",
                body: JSON.stringify({ name, code }),
            }, admin.cookie);
            if (result.response.status !== 201) {
                throw new Error(`Department creation failed (${result.response.status}): ${JSON.stringify(result.body)}`);
            }
            return result.body.department.id;
        };
        const departmentA = await createDepartment("设计一部", "design-a");
        const departmentB = await createDepartment("设计二部", "design-b");

        const createAccount = async (input: Record<string, unknown>) => {
            const result = await api<{ user: { id: string; departmentId: string; role: string } }>("/api/admin/accounts", {
                method: "POST",
                body: JSON.stringify(input),
            }, admin.cookie);
            if (result.response.status !== 201) {
                throw new Error(`Account creation failed (${result.response.status}): ${JSON.stringify(result.body)}`);
            }
            return result.body.user;
        };
        const designerA = await createAccount({
            username: "设计师甲",
            displayName: "设计师甲",
            email: "designer-a@company.test",
            employeeNo: "D-A-001",
            password: "DesignerStart2026",
            role: "designer",
            departmentId: departmentA,
            creditBalance: 500,
            creditLimit: 500,
        });
        const designerB = await createAccount({
            username: "designer-b",
            displayName: "Designer B",
            email: "designer-b@company.test",
            employeeNo: "D-B-001",
            password: "DesignerStart2026",
            role: "designer",
            departmentId: departmentB,
            creditBalance: 500,
            creditLimit: 500,
        });
        await createAccount({
            username: "manager-a",
            displayName: "设计一部管理员",
            email: "manager-a@company.test",
            employeeNo: "M-A-001",
            password: "ManagerStart2026",
            role: "department_admin",
            departmentId: departmentA,
            creditBalance: 0,
            creditLimit: 0,
        });

        const bulkAccounts = Array.from({ length: 100 }, (_, index) => ({
            username: `batch-designer-${String(index + 1).padStart(3, "0")}`,
            displayName: `批量设计师 ${index + 1}`,
            email: `batch-${index + 1}@company.test`,
            employeeNo: `BATCH-${String(index + 1).padStart(3, "0")}`,
            password: "BatchDesigner2026",
            role: "designer",
            departmentId: departmentA,
            creditBalance: 100,
            creditLimit: 100,
        }));
        const bulk = await api<{ created: number; failures: unknown[] }>("/api/admin/accounts/bulk", {
            method: "POST",
            body: JSON.stringify({ accounts: bulkAccounts }),
        }, admin.cookie);
        expect(bulk.response.status).toBe(201);
        expect(bulk.body).toEqual({ created: 100, failures: [] });

        const chineseLogin = await login("设计师甲", "DesignerStart2026", "designer");
        const emailLogin = await login("designer-b@company.test", "DesignerStart2026", "designer");
        const employeeLogin = await login("M-A-001", "ManagerStart2026", "admin");

        const designerBeforePassword = await api<{ error: string }>("/api/projects", {}, chineseLogin.cookie);
        expect(designerBeforePassword.body.error).toBe("PASSWORD_CHANGE_REQUIRED");
        await changePassword(chineseLogin.cookie, "DesignerStart2026", "DesignerReady2026");
        await changePassword(emailLogin.cookie, "DesignerStart2026", "DesignerBReady2026");
        await changePassword(employeeLogin.cookie, "ManagerStart2026", "ManagerReady2026");

        const designerAdminAttempt = await api<{ error: string }>("/api/admin/accounts", {}, chineseLogin.cookie);
        expect(designerAdminAttempt.response.status).toBe(403);
        expect(designerAdminAttempt.body.error).toBe("FORBIDDEN");
        const designerIntegrationAttempt = await api<{ error: string }>("/api/admin/integrations/status", {}, chineseLogin.cookie);
        expect(designerIntegrationAttempt.response.status).toBe(403);
        expect(designerIntegrationAttempt.body.error).toBe("FORBIDDEN");
        const designerInternalAiAttempt = await api<{ error: string }>("/api/admin/internal-ai", {}, chineseLogin.cookie);
        expect(designerInternalAiAttempt.response.status).toBe(403);
        expect(designerInternalAiAttempt.body.error).toBe("FORBIDDEN");

        const configureInternalAi = await api<{ seamlessUrl: string; hasAppKey: boolean; appKeyPreview: string }>(
            "/api/admin/internal-ai",
            {
                method: "PUT",
                body: JSON.stringify({ seamlessUrl: "https://internal-ai.company.test/std/tohwkdpj", appKey: "integration-internal-app-key" }),
            },
            admin.cookie,
        );
        expect(configureInternalAi.response.status).toBe(200);
        expect(configureInternalAi.body).toMatchObject({ seamlessUrl: "https://internal-ai.company.test/std/tohwkdpj", hasAppKey: true });
        expect(JSON.stringify(configureInternalAi.body)).not.toContain("integration-internal-app-key");

        const publicModels = await api<{ models: Array<{ id: string; modelId: string; creditCost: number }>; prices: Array<{ operationType: string; credits: number }> }>("/api/models", {}, chineseLogin.cookie);
        expect(publicModels.response.status).toBe(200);
        expect(publicModels.body.models.find((model) => model.modelId === "internal-seamless")?.creditCost).toBe(0);
        expect(publicModels.body.prices.find((price) => price.operationType === "seamless_stitch")?.credits).toBe(2);

        const managerAccounts = await api<{ users: Array<{ id: string; departmentId: string; role: string }> }>("/api/admin/accounts", {}, employeeLogin.cookie);
        expect(managerAccounts.response.status).toBe(200);
        expect(managerAccounts.body.users).toHaveLength(101);
        expect(managerAccounts.body.users.every((user) => user.departmentId === departmentA && user.role === "designer")).toBe(true);
        expect(managerAccounts.body.users.some((user) => user.id === designerB.id)).toBe(false);

        const crossDepartmentUpdate = await api<{ error: string }>(`/api/admin/accounts/${designerB.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "disabled" }),
        }, employeeLogin.cookie);
        expect(crossDepartmentUpdate.response.status).toBe(403);
        expect(crossDepartmentUpdate.body.error).toBe("FORBIDDEN");

        const syncProject = async (cookie: string) => api<{ project: { id: string; externalId: string } }>("/api/projects/sync", {
            method: "POST",
            body: JSON.stringify({ externalId: "same-local-project-id", name: "同名本地项目" }),
        }, cookie);
        const projectA = await syncProject(chineseLogin.cookie);
        const projectB = await syncProject(emailLogin.cookie);
        expect(projectA.response.status).toBe(200);
        expect(projectB.response.status).toBe(200);
        expect(projectA.body.project.id).not.toBe(projectB.body.project.id);

        const projectsA = await api<{ projects: Array<{ id: string }> }>("/api/projects", {}, chineseLogin.cookie);
        const projectsB = await api<{ projects: Array<{ id: string }> }>("/api/projects", {}, emailLogin.cookie);
        expect(projectsA.body.projects.map((project) => project.id)).toEqual([projectA.body.project.id]);
        expect(projectsB.body.projects.map((project) => project.id)).toEqual([projectB.body.project.id]);

        const disableDesignerB = await api(`/api/admin/accounts/${designerB.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "disabled" }),
        }, admin.cookie);
        expect(disableDesignerB.response.status).toBe(200);
        const disabledSession = await api<{ error: string }>("/api/auth/session", {}, emailLogin.cookie);
        expect(disabledSession.response.status).toBe(401);
        expect(disabledSession.body.error).toBe("SESSION_EXPIRED");

        const audit = await api<{ auditLogs: Array<{ action: string }> }>("/api/admin/audit-logs?limit=500", {}, admin.cookie);
        expect(audit.response.status).toBe(200);
        expect(audit.body.auditLogs.some((entry) => entry.action === "account.bulk_created")).toBe(true);
        expect(audit.body.auditLogs.some((entry) => entry.action === "auth.password_changed")).toBe(true);
        expect(audit.body.auditLogs.some((entry) => entry.action === "account.updated")).toBe(true);

        expect(designerA.departmentId).toBe(departmentA);
    }, 180_000);
});
