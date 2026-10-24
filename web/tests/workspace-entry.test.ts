import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isWorkspaceRole } from "../../shared/workspace-access";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/workspace-entry.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function entry(enterprise: boolean, role?: string, authenticationEnabled = enterprise) {
    const calls: string[] = [];
    const state: any = {
        user: role ? { id: "verified", role } : null, status: role ? "authenticated" : "guest",
        async exchangeOaToken(token: string) { calls.push(`exchange:${token}`); if (token === "invalid") { state.user = null; state.status = "guest"; } },
        async hydrateSession() { calls.push("session"); },
    };
    const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = {
        "../../../shared/workspace-access": { isWorkspaceRole },
        "@/lib/deployment-features": { deploymentFeatures: { oaLoginEnabled: enterprise, authenticationEnabled } },
        "@/stores/use-user-store": { useUserStore: { getState: () => state }, isAdminRole: (value: string) => value === "super_admin" || value === "department_admin" },
    };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name], module, module.exports);
    return { calls, state, prepare: module.exports.prepareWorkspaceEntry as (token: string | null, path: string) => Promise<string> };
}

test("trial mode never exchanges an old OA link and does not require an employee session", async () => {
    const trial = entry(false);
    expect(await trial.prepare("old-token", "/canvas")).toBe("workspace");
    expect(trial.calls).toEqual([]);
});

test("OA entry exchanges an explicit token or restores a cookie before opening employee workspaces", async () => {
    const employee = entry(true, "designer");
    expect(await employee.prepare("fresh", "/canvas/p")).toBe("workspace");
    expect(employee.calls).toEqual(["exchange:fresh"]);
    employee.calls.length = 0;
    expect(await employee.prepare(null, "/creative/edit")).toBe("workspace");
    expect(employee.calls).toEqual(["session"]);
});

test("invalid explicit credentials never fall back to a previous employee or maintenance session", async () => {
    for (const path of ["/", "/admin/login"]) {
        const employee = entry(true, "designer");
        expect(await employee.prepare("invalid", path)).toBe("oa-required");
        expect(employee.calls).toEqual(["exchange:invalid"]);
    }
    expect(await entry(true).prepare(null, "/canvas")).toBe("oa-required");
});

test("super admins keep maintenance and gain a personal workspace without accepting privileged OA identities", async () => {
    const administrator = entry(true, "super_admin");
    expect(await administrator.prepare(null, "/admin")).toBe("maintenance");
    expect(await administrator.prepare(null, "/change-password")).toBe("password-change");
    expect(await administrator.prepare(null, "/canvas")).toBe("workspace");
    expect(await administrator.prepare("oa-token", "/canvas")).toBe("oa-required");
    expect(await entry(true, "department_admin").prepare(null, "/canvas")).toBe("oa-required");
    expect(await entry(true).prepare(null, "/admin/login")).toBe("maintenance-login");
    expect(await entry(true, "designer").prepare(null, "/admin")).toBe("maintenance-login");
});

test("password mode verifies session first, ignores old OA tokens and never grants a guest workspace", async () => {
    const guest = entry(false, undefined, true);
    expect(await guest.prepare("old-oa-token", "/canvas/private")).toBe("password-login");
    expect(guest.calls).toEqual(["session"]);
    expect(await guest.prepare(null, "/admin")).toBe("maintenance-login");
    const designer = entry(false, "designer", true);
    expect(await designer.prepare(null, "/canvas/private")).toBe("workspace");
    expect(designer.calls).toEqual(["session"]);
    expect(await designer.prepare(null, "/admin")).toBe("maintenance-login");
    expect(await designer.prepare(null, "/login")).toBe("password-login");
    expect(await entry(false, "super_admin", true).prepare(null, "/admin/login")).toBe("maintenance-login");
    expect(await entry(false, "super_admin", true).prepare(null, "/canvas/private")).toBe("workspace");
    expect(await entry(false, "department_admin", true).prepare(null, "/canvas/private")).toBe("maintenance");
});

test("first-login password changes for both designers and admins precede workspace imports", async () => {
    for (const role of ["designer", "department_admin", "super_admin"]) {
        const login = entry(false, role, true);
        login.state.user.mustChangePassword = true;
        expect(await login.prepare(null, "/")).toBe("password-change");
        expect(await login.prepare(null, "/change-password")).toBe("password-change");
    }
});
