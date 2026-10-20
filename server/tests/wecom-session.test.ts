import { expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { requireAccountReady, sessionMiddleware } from "../src/session";
import type { AuthenticatedRequest } from "../src/types";
import type { UserRow } from "../src/user-mapper";

const config = {
    AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false",
    SESSION_COOKIE_NAME: "wecom_session_fixture", SESSION_TTL_SECONDS: 600, NODE_ENV: "test",
} as AppConfig;

type StoredSession = UserRow & { session_id: string; auth_provider: string };
type FixtureOptions = {
    row?: Partial<StoredSession>;
    deployment?: Partial<AppConfig>;
    policy?: Parameters<typeof sessionMiddleware>[3];
    refreshedRole?: UserRow["role"];
};

async function withSession(options: FixtureOptions, run: (fixture: {
    request: (path: "/session" | "/ready", forgedProvider?: boolean) => Promise<Response>;
    stored: StoredSession;
    statements: string[];
}) => Promise<void>) {
    const stored: StoredSession = {
        id: "same-designer-id", username: "designer", display_name: "Designer",
        email: null, employee_no: "employee-17", role: "designer", status: "active",
        department_id: null, department_name: null, group_id: null, group_name: null, group_role: null,
        is_guest: false, must_change_password: true, mfa_enabled: false,
        credit_balance: 20, credit_limit: 100, monthly_credit_limit: 100, temporary_credit_adjustment: 0,
        credit_period_start: options.refreshedRole ? "2031-12-01" : "2032-01-01",
        current_credit_period_start: "2032-01-01", credit_reset_at: "2032-02-01",
        session_id: "trusted-session-id", auth_provider: "wecom", ...options.row,
    };
    const statements: string[] = [];
    let sessionReads = 0;
    const query = async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM sessions")) {
            sessionReads++;
            return { rows: [{
                ...stored,
                ...(sessionReads > 1 && options.refreshedRole ? { role: options.refreshedRole } : {}),
            }] };
        }
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FOR NO KEY UPDATE")) return { rows: [{ ...stored, current_period_start: "2032-01-01" }] };
        if (sql.startsWith("UPDATE users SET credit_balance")) {
            stored.credit_period_start = "2032-01-01";
            return { rows: [] };
        }
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("INSERT INTO credit_ledger")) return { rows: [] };
        throw new Error(`Unexpected fixture SQL: ${sql}`);
    };
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
    const values = new Map<string, string>();
    const cache = {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => { values.set(key, value); return "OK"; },
        del: async (key: string) => Number(values.delete(key)),
    } as unknown as Cache;
    const deployment = { ...config, ...options.deployment };
    const app = express().use(express.json()).use(cookieParser());
    const authenticate = sessionMiddleware(db, cache, deployment, options.policy);
    const respond: express.RequestHandler = (request, response) => {
        const authenticated = request as AuthenticatedRequest;
        response.json({ user: authenticated.auth, sessionId: authenticated.sessionId });
    };
    app.get("/session", authenticate, respond);
    app.post("/ready", authenticate, requireAccountReady, respond);
    app.use(((_error, _request, response, _next) => response.status(500).json({ error: "FIXTURE_UNEXPECTED_ERROR" })) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        await run({
            stored, statements,
            request: (path, forgedProvider = false) => fetch(`${origin}${path}${forgedProvider ? "?auth_provider=wecom" : ""}`, {
                method: path === "/ready" ? "POST" : "GET",
                headers: {
                    cookie: `${deployment.SESSION_COOKIE_NAME}=trusted-token${forgedProvider ? "; auth_provider=wecom" : ""}`,
                    ...(path === "/ready" ? { "content-type": "application/json" } : {}),
                    ...(forgedProvider ? { "X-Auth-Provider": "wecom" } : {}),
                },
                ...(path === "/ready" ? { body: JSON.stringify(forgedProvider ? { auth_provider: "wecom", mustChangePassword: false } : {}) } : {}),
                signal: AbortSignal.timeout(5_000),
            }),
        });
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

test("a verified non-OA WeCom designer session skips only the effective password-change gate", async () => {
    await withSession({}, async ({ request, stored, statements }) => {
        const session = await request("/session");
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ user: { id: "same-designer-id", mustChangePassword: false } });
        const ready = await request("/ready");
        expect(ready.status).toBe(200);
        expect(await ready.json()).toMatchObject({ user: { id: "same-designer-id", mustChangePassword: false } });
        expect(stored.must_change_password).toBe(true);
        expect(statements.every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
    });
});

test("the same user's local session still requires a password change despite forged WeCom request metadata", async () => {
    await withSession({ row: { auth_provider: "local" } }, async ({ request, stored, statements }) => {
        const session = await request("/session", true);
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ user: { id: "same-designer-id", mustChangePassword: true } });
        const ready = await request("/ready", true);
        expect(ready.status).toBe(403);
        expect(await ready.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
        expect(stored.must_change_password).toBe(true);
        expect(statements.every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
    });
});

test.each([
    { name: "OA deployment", deployment: { OA_LOGIN_ENABLED: "true" }, row: {}, policy: {} },
    { name: "super administrator", deployment: {}, row: { role: "super_admin" }, policy: { allowAdminSession: true } },
    { name: "department administrator", deployment: {}, row: { role: "department_admin" }, policy: { allowGuest: false } },
    { name: "authenticated guest", deployment: {}, row: { is_guest: true }, policy: {} },
    { name: "open-trial guest", deployment: { AUTH_ENABLED: "false" }, row: { is_guest: true }, policy: {} },
] as const)("WeCom sessions cannot bypass the $name boundary", async fixture => {
    await withSession({ ...fixture, row: { must_change_password: false, ...fixture.row } }, async ({ request }) => {
        const response = await request("/ready");
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: "SESSION_EXPIRED" });
        expect(response.headers.getSetCookie().some(cookie => cookie.startsWith("wecom_session_fixture=;"))).toBe(true);
    });
});

test.each([
    { name: "local designer outside OA", provider: "local", role: "designer", guest: false, auth: "true", oa: "false", policy: {}, status: 200 },
    { name: "OA designer inside OA", provider: "oa", role: "designer", guest: false, auth: "true", oa: "true", policy: {}, status: 200 },
    { name: "local designer cannot enter OA creation", provider: "local", role: "designer", guest: false, auth: "true", oa: "true", policy: {}, status: 401 },
    { name: "local administrator on its allowed OA session endpoint", provider: "local", role: "super_admin", guest: false, auth: "true", oa: "true", policy: { allowAdminSession: true }, status: 200 },
    { name: "OA administrator is not an employee session", provider: "oa", role: "super_admin", guest: false, auth: "true", oa: "true", policy: { allowAdminSession: true }, status: 401 },
    { name: "existing local guest in open trial", provider: "local", role: "designer", guest: true, auth: "false", oa: "false", policy: {}, status: 200 },
    { name: "existing local guest in authenticated deployment", provider: "local", role: "designer", guest: true, auth: "true", oa: "false", policy: {}, status: 401 },
    { name: "existing local guest on a non-guest trial endpoint", provider: "local", role: "designer", guest: true, auth: "false", oa: "false", policy: { allowGuest: false }, status: 401 },
] as const)("existing $name behavior remains unchanged", async fixture => {
    await withSession({
        row: { auth_provider: fixture.provider, role: fixture.role, is_guest: fixture.guest, must_change_password: false },
        deployment: { AUTH_ENABLED: fixture.auth, OA_LOGIN_ENABLED: fixture.oa }, policy: fixture.policy,
    }, async ({ request }) => {
        const response = await request("/ready");
        expect(response.status).toBe(fixture.status);
        if (fixture.status === 200) expect(await response.json()).toMatchObject({ user: { mustChangePassword: false } });
        else expect(await response.json()).toMatchObject({ error: "SESSION_EXPIRED" });
    });
});

test.each([
    { role: "designer", status: 200 },
    { role: "super_admin", status: 401 },
] as const)("monthly refresh rechecks WeCom role $role before applying the session exemption", async fixture => {
    await withSession({ refreshedRole: fixture.role, deployment: { CREDITS_ENABLED: "true" } }, async ({ request, statements, stored }) => {
        const response = await request("/ready");
        expect(response.status).toBe(fixture.status);
        if (fixture.status === 200) expect(await response.json()).toMatchObject({ user: { mustChangePassword: false } });
        else expect(await response.json()).toMatchObject({ error: "SESSION_EXPIRED" });
        expect(statements.filter(sql => sql.includes("FROM sessions"))).toHaveLength(2);
        expect(statements.some(sql => sql.includes("FOR NO KEY UPDATE"))).toBe(true);
        expect(stored.must_change_password).toBe(true);
        expect(statements.filter(sql => sql.startsWith("UPDATE users")).every(sql => !sql.includes("password"))).toBe(true);
    });
});
