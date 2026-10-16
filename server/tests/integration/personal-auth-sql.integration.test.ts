import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { Cache, Database } from "../../src/db";
import { createAuthRouter } from "../../src/routes/auth";
import { createAccountsRouter } from "../../src/routes/accounts";
import { requireAccountReady, sessionMiddleware } from "../../src/session";
import { hashPassword, verifyPassword } from "../../src/security";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const integration = runtime ? describe : describe.skip;
const initialPassword = "FixtureStart2026";
const nextPassword = "FixtureReady2026";
const config = { AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false", SESSION_COOKIE_NAME: "personal_auth_fixture", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test" } as AppConfig;

// Real HTTP routes + real PostgreSQL SQL, on disposable in-memory storage.
// Never reads DATABASE_URL, shared QA users, or any provider configuration.
integration("personal password authentication in isolated PostgreSQL", () => {
    let database: any;
    let db: Database;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let origin: string;
    let afterIdentityRead: (() => Promise<void>) | undefined;
    const cached = new Map<string, string>();
    const cache = {
        get: async (key: string) => cached.get(key) ?? null,
        set: async (key: string, value: string) => { cached.set(key, value); return "OK"; },
        del: async (key: string) => Number(cached.delete(key)),
        incr: async () => 1, expire: async () => 1,
    } as unknown as Cache;
    beforeAll(async () => {
        const requireRuntime = createRequire(resolve(runtime!, "package.json"));
        const { PGlite } = requireRuntime("@electric-sql/pglite");
        const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
        const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
        database = new PGlite({ extensions: { pgcrypto, citext } });
        await database.waitReady;
        const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
        for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await database.exec(await readFile(resolve(migrations, name), "utf8"));
        await database.query("INSERT INTO credit_policy(singleton,credits_enabled) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET credits_enabled=false");
        const query = async (sql: string, values: unknown[] = []) => {
            const result = await database.query(sql, values);
            if (afterIdentityRead && sql.includes("WHERE u.username=$1 OR u.email=$1")) {
                const pause = afterIdentityRead; afterIdentityRead = undefined; await pause();
            }
            return { ...result, rowCount: result.affectedRows ?? result.rows.length };
        };
        db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
        const app = express().use(express.json()).use(cookieParser());
        app.use("/api/auth", createAuthRouter(db, cache, config));
        app.get("/api/creation", sessionMiddleware(db, cache, config), requireAccountReady, (request, response) => response.json({ user: (request as any).auth }));
        app.use("/api/admin/accounts", sessionMiddleware(db, cache, config, { allowGuest: false }), requireAccountReady, createAccountsRouter(db));
        app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.name, message: error.message })) as ErrorRequestHandler);
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>(done => server.once("listening", done));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }, 30000);
    afterAll(async () => {
        if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
        await database?.close();
    });
    async function actor(options: { role?: string; mustChangePassword?: boolean; departmentId?: string | null } = {}) {
        const id = randomUUID(); const username = `auth-${id}`;
        await db.query("INSERT INTO users(id,username,display_name,email,employee_no,password_hash,role,department_id,must_change_password) VALUES($1,$2::text,$2::text,$3,$4,$5,$6,$7,$8)", [id, username, `${id}@fixture.invalid`, `employee-${id}`, await hashPassword(initialPassword), options.role ?? "designer", options.departmentId ?? null, options.mustChangePassword ?? false]);
        return { id, username, email: `${id}@fixture.invalid`, employeeNo: `employee-${id}` };
    }
    const request = (path: string, cookie?: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${origin}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    async function login(identifier: string, password = initialPassword, portal: "designer" | "admin" = "designer") {
        const response = await request("/api/auth/login", undefined, { identifier, password, portal });
        expect(response.status).toBe(200);
        const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]; expect(cookie).toBeTruthy();
        return cookie!;
    }
    const change = (cookie: string, newPassword: string, currentPassword = initialPassword) => request("/api/auth/change-password", cookie, { currentPassword, newPassword });
    const stored = async (id: string) => (await db.query("SELECT password_hash,must_change_password FROM users WHERE id=$1", [id])).rows[0];

    test("username, email and employee number resolve the same personal identity; anonymous and wrong portals stay closed", async () => {
        const user = await actor();
        for (const identifier of [user.username, user.email, user.employeeNo]) {
            const cookie = await login(identifier);
            expect((await (await request("/api/auth/session", cookie)).json()).user.id).toBe(user.id);
        }
        expect((await request("/api/creation")).status).toBe(401);
        expect((await request("/api/auth/login", undefined, { identifier: user.username, password: initialPassword, portal: "admin" })).status).toBe(401);
        const admin = await actor({ role: "super_admin" });
        expect((await request("/api/auth/login", undefined, { identifier: admin.username, password: initialPassword, portal: "designer" })).status).toBe(401);
    });

    test("mandatory password change blocks direct creation/admin APIs; real change revokes every other session", async () => {
        const user = await actor({ mustChangePassword: true });
        const current = await login(user.username); const other = await login(user.username);
        for (const path of ["/api/creation", "/api/admin/accounts"]) {
            const denied = await request(path, current); expect(denied.status).toBe(403);
            expect((await denied.json()).error).toBe("PASSWORD_CHANGE_REQUIRED");
        }
        expect((await change(current, nextPassword, "incorrect-password")).status).toBe(400);
        expect((await stored(user.id)).must_change_password).toBe(true);
        expect((await change(current, nextPassword)).status).toBe(204);
        expect((await request("/api/creation", current)).status).toBe(200);
        expect((await request("/api/auth/session", other)).status).toBe(401);
        expect((await request("/api/auth/login", undefined, { identifier: user.username, password: initialPassword, portal: "designer" })).status).toBe(401);
        await login(user.username, nextPassword);
    });

    test("reusing the initial password cannot dismiss mandatory password change", async () => {
        const user = await actor({ mustChangePassword: true }); const cookie = await login(user.username);
        const result = await change(cookie, initialPassword);
        expect(result.status).toBe(400);
        expect((await result.json()).error).toBe("PASSWORD_UNCHANGED");
        expect((await stored(user.id)).must_change_password).toBe(true);
    });

    test("rejects passwords exceeding the login limit without mutating a working password", async () => {
        const user = await actor({ mustChangePassword: true }); const cookie = await login(user.username);
        expect((await change(cookie, `${"A".repeat(200)}1`)).status).toBe(400);
        const state = await stored(user.id);
        expect(state.must_change_password).toBe(true);
        expect(await verifyPassword(state.password_hash, initialPassword)).toBe(true);
        const boundary = `${"A".repeat(199)}1`;
        expect((await change(cookie, boundary)).status).toBe(204);
        await login(user.username, boundary);
    });

    test("password and session revocation roll back together on a real database failure", async () => {
        const user = await actor({ mustChangePassword: true }); const cookie = await login(user.username); const other = await login(user.username);
        await database.exec(`CREATE FUNCTION reject_auth_fixture_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${user.id}' AND NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Fixture revocation failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_auth_fixture_revoke BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_auth_fixture_revoke();`);
        try {
            expect((await change(cookie, nextPassword)).status).toBe(500);
            const state = await stored(user.id);
            expect(state.must_change_password).toBe(true);
            expect(await verifyPassword(state.password_hash, initialPassword)).toBe(true);
            expect((await request("/api/auth/session", other)).status).toBe(200);
        } finally { await database.exec("DROP TRIGGER reject_auth_fixture_revoke ON sessions; DROP FUNCTION reject_auth_fixture_revoke();"); }
    });

    test("logout revokes current cookie; disabled and explicitly revoked identities cannot restore from cached sessions", async () => {
        const user = await actor(); const cookie = await login(user.username);
        expect((await request("/api/auth/logout", cookie, {})).status).toBe(204);
        expect((await request("/api/auth/session", cookie)).status).toBe(401);
        const disabled = await login(user.username);
        await db.query("UPDATE users SET status='disabled' WHERE id=$1", [user.id]);
        expect((await request("/api/auth/session", disabled)).status).toBe(401);
        await db.query("UPDATE users SET status='active' WHERE id=$1", [user.id]);
        const revoked = await login(user.username);
        await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [user.id]);
        expect((await request("/api/auth/session", revoked)).status).toBe(401);
    });

    test("department managers cannot see or modify other departments, elevate roles, or retain revoked privileges", async () => {
        const department = randomUUID(); const otherDepartment = randomUUID();
        await db.query("INSERT INTO departments(id,name,code) VALUES($1::uuid,'Auth A',$1::text),($2::uuid,'Auth B',$2::text)", [department, otherDepartment]);
        const manager = await actor({ role: "department_admin", departmentId: department });
        const local = await actor({ departmentId: department }); const foreign = await actor({ departmentId: otherDepartment });
        const cookie = await login(manager.username, initialPassword, "admin");
        const listed = await request("/api/admin/accounts", cookie);
        expect(listed.status).toBe(200); expect((await listed.json()).users.map((user: { id: string }) => user.id)).toEqual([local.id]);
        expect((await request(`/api/admin/accounts/${foreign.id}`, cookie, { displayName: "Not allowed" }, "PATCH")).status).toBe(403);
        expect((await request(`/api/admin/accounts/${local.id}`, cookie, { role: "department_admin" }, "PATCH")).status).toBe(403);
        expect((await request(`/api/admin/accounts/${local.id}`, cookie, { departmentId: otherDepartment }, "PATCH")).status).toBe(403);
        await db.query("UPDATE users SET role='designer' WHERE id=$1", [manager.id]);
        expect((await request("/api/admin/accounts", cookie)).status).toBe(403);
    });

    test("a stale tab owner cannot use another account's valid cookie", async () => {
        const first = await actor(); const second = await actor(); const cookie = await login(second.username);
        const rejected = await fetch(`${origin}/api/creation`, { headers: { cookie, "X-Canvas-Owner-Id": first.id } });
        expect(rejected.status).toBe(403); expect((await rejected.json()).error).toBe("CANVAS_OWNER_MISMATCH");
        expect(rejected.headers.get("set-cookie")).toBeNull();
        expect((await request("/api/creation", cookie)).status).toBe(200);
    });

    test("disabling and re-enabling an account never revives its old browser session", async () => {
        const admin = await actor({ role: "super_admin" }); const adminCookie = await login(admin.username, initialPassword, "admin");
        const user = await actor(); const oldCookie = await login(user.username);
        expect((await request(`/api/admin/accounts/${user.id}`, adminCookie, { status: "disabled" }, "PATCH")).status).toBe(200);
        expect((await request("/api/auth/session", oldCookie)).status).toBe(401);
        expect((await request(`/api/admin/accounts/${user.id}`, adminCookie, { status: "active" }, "PATCH")).status).toBe(200);
        expect((await request("/api/auth/session", oldCookie)).status).toBe(401);
        await login(user.username);
    });

    test("admin creation and reset reject passwords that cannot be submitted at login", async () => {
        const admin = await actor({ role: "super_admin" }); const adminCookie = await login(admin.username, initialPassword, "admin");
        const user = await actor(); const password = `${"A".repeat(200)}1`;
        expect((await request("/api/admin/accounts", adminCookie, { username: `rejected-${randomUUID()}`, displayName: "Unusable password", password })).status).toBe(400);
        expect((await request(`/api/admin/accounts/${user.id}/reset-password`, adminCookie, { password })).status).toBe(400);
        await login(user.username);
    });

    test("admin password reset rolls back credentials and revoked sessions when its audit fails", async () => {
        const admin = await actor({ role: "super_admin" }); const adminCookie = await login(admin.username, initialPassword, "admin");
        const user = await actor(); const current = await login(user.username); const other = await login(user.username);
        const before = await stored(user.id);
        await database.exec("CREATE FUNCTION reject_reset_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account.password_reset' THEN RAISE EXCEPTION 'Fixture password reset audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_reset_fixture_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_reset_fixture_audit();");
        try {
            expect((await request(`/api/admin/accounts/${user.id}/reset-password`, adminCookie, { password: nextPassword })).status).toBe(500);
            expect(await stored(user.id)).toEqual(before);
            expect((await request("/api/auth/session", current)).status).toBe(200);
            expect((await request("/api/auth/session", other)).status).toBe(200);
            expect((await db.query("SELECT id FROM audit_logs WHERE action='account.password_reset' AND target_id=$1", [user.id])).rows).toEqual([]);
        } finally { await database.exec("DROP TRIGGER reject_reset_fixture_audit ON audit_logs; DROP FUNCTION reject_reset_fixture_audit();"); }
        expect((await request(`/api/admin/accounts/${user.id}/reset-password`, adminCookie, { password: nextPassword })).status).toBe(204);
        expect((await stored(user.id)).must_change_password).toBe(true);
        expect((await request("/api/auth/session", current)).status).toBe(401);
        expect((await request("/api/auth/session", other)).status).toBe(401);
        expect((await request("/api/auth/login", undefined, { identifier: user.username, password: initialPassword, portal: "designer" })).status).toBe(401);
        await login(user.username, nextPassword);
        expect((await db.query("SELECT id FROM audit_logs WHERE action='account.password_reset' AND target_id=$1", [user.id])).rows).toHaveLength(1);
    });

    test("a password reset racing an already-started login cannot mint a session for old credentials", async () => {
        const admin = await actor({ role: "super_admin" }); const adminCookie = await login(admin.username, initialPassword, "admin");
        const user = await actor(); const captured = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
        afterIdentityRead = async () => { captured.resolve(); await resume.promise; };
        const pending = request("/api/auth/login", undefined, { identifier: user.username, password: initialPassword, portal: "designer" });
        await captured.promise;
        try {
            expect((await request(`/api/admin/accounts/${user.id}/reset-password`, adminCookie, { password: nextPassword })).status).toBe(204);
        } finally { resume.resolve(); }
        const stale = await pending;
        expect(stale.status).toBe(401);
        expect(stale.headers.get("set-cookie")).toBeNull();
        await login(user.username, nextPassword);
    });
});
