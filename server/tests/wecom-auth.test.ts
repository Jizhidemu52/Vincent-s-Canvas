import { expect, spyOn, test } from "bun:test";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { createAuthRouter } from "../src/routes/auth";

const config = {
    AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false",
    SESSION_COOKIE_NAME: "session", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test",
    WECOM_CORP_ID: "ww-fixture", WECOM_AGENT_ID: "1000002", WECOM_SECRET: "fixture-secret",
    WECOM_CALLBACK_URL: "https://canvas.company.test/api/auth/wecom/callback",
} as AppConfig;
const designer = {
    id: "designer-id", username: "designer", display_name: "Designer", employee_no: "employee-17",
    role: "designer", status: "active", is_guest: false, must_change_password: false,
};

function fixture(options: { user?: Record<string, unknown> | null; lockedUser?: Record<string, unknown> | null; conflict?: boolean } = {}) {
    const values = new Map<string, string>();
    const writes: { key: string; value: string; options?: { EX: number } }[] = [];
    const queries: { sql: string; parameters?: unknown[] }[] = [];
    const cache = {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string, options?: { EX: number }) => {
            writes.push({ key, value, options }); values.set(key, value); return "OK";
        },
        del: async (key: string) => Number(values.delete(key)),
        incr: async () => 1, expire: async () => 1,
    } as unknown as Cache;
    const user = options.user === undefined ? designer : options.user;
    const lockedUser = options.lockedUser === undefined ? user : options.lockedUser;
    const query = async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        if (sql.includes("LEFT JOIN external_identities")) return { rows: user ? [user] : [] };
        if (sql.startsWith("SELECT status,role,is_guest")) return { rows: lockedUser ? [lockedUser] : [] };
        if (sql.startsWith("SELECT user_id,subject")) return { rows: [{ user_id: options.conflict ? "other-user" : designer.id, subject: "employee-17" }] };
        return { rows: [] };
    };
    return { cache, values, writes, queries, db: { query, connect: async () => ({ query, release() {} }) } as unknown as Database };
}

async function serve(db: Database, cache: Cache, deployment: AppConfig, run: (origin: string) => Promise<void>) {
    const app = express().use(express.json()).use(cookieParser());
    app.use("/api/auth", createAuthRouter(db, cache, deployment));
    app.use(((_error, _request, response, _next) => response.status(500).json({ error: "UNEXPECTED" })) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function start(origin: string) {
    const response = await fetch(`${origin}/api/auth/wecom/start?portal=designer`);
    expect(response.status).toBe(200);
    const { authorizationUrl } = await response.json();
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("session_wecom_state="))!;
    return { state, cookie: cookie.split(";", 1)[0]!, fullCookie: cookie, response, authorizationUrl };
}

function upstreamIdentity(userPayload: Record<string, unknown> = { errcode: 0, userid: "employee-17" }) {
    const originalFetch = globalThis.fetch;
    const calls: URL[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
        const url = new URL(String(input));
        if (url.origin === "https://qyapi.weixin.qq.com") {
            calls.push(url);
            return Promise.resolve(Response.json(url.pathname.endsWith("/gettoken")
                ? { errcode: 0, access_token: "fixture-token" }
                : userPayload));
        }
        return originalFetch(input, init);
    }) as typeof fetch);
    return { calls, restore: () => mock.mockRestore() };
}

const callback = (origin: string, state: string, cookie?: string) => fetch(
    `${origin}/api/auth/wecom/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: cookie ? { cookie } : {} },
);

test("login methods expose configured QR login only in authenticated non-OA deployments", async () => {
    for (const [overrides, expected] of [
        [{}, { password: true, wecom: true, wecomLoginUrl: "https://canvas.company.test/login?scan=1" }],
        [{ AUTH_ENABLED: "false" }, { password: true, wecom: false, wecomLoginUrl: null }],
        [{ OA_LOGIN_ENABLED: "true" }, { password: false, wecom: false, wecomLoginUrl: null }],
        [{ WECOM_SECRET: "" }, { password: true, wecom: false, wecomLoginUrl: null }],
    ] as const) {
        const f = fixture();
        await serve(f.db, f.cache, { ...config, ...overrides }, async origin => {
            const response = await fetch(`${origin}/api/auth/methods`);
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(await response.json()).toEqual(expected);
            if (!expected.wecom) {
                for (const path of ["/wecom/start", "/WECOM/start/", "/wecom/callback?code=unused&state=unused"]) {
                    expect((await fetch(`${origin}/api/auth${path}`)).status).toBe(404);
                }
            }
            expect(f.queries).toHaveLength(0);
            expect(f.writes).toHaveLength(0);
        });
    }
});

test("QR start rejects the administrator portal and binds a five-minute state to the browser", async () => {
    const f = fixture();
    await serve(f.db, f.cache, { ...config, NODE_ENV: "production" }, async origin => {
        expect((await fetch(`${origin}/api/auth/wecom/start?portal=admin`)).status).toBe(403);
        expect(f.writes).toHaveLength(0);
        const login = await start(origin);
        expect(login.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(login.response.headers.get("cache-control")).toBe("no-store");
        expect(f.writes).toEqual([{ key: `wecom-state:${login.state}`, value: "designer", options: { EX: 300 } }]);
        for (const attribute of ["Max-Age=300", "HttpOnly", "SameSite=Lax", "Secure", "Path=/api/auth/wecom"]) {
            expect(login.fullCookie).toContain(attribute);
        }
        expect(new URL(login.authorizationUrl).searchParams.get("redirect_uri")).toBe(config.WECOM_CALLBACK_URL!);
        expect(f.queries).toHaveLength(0);
    });
});

test("QR callback rejects absent, mismatched, expired and non-designer browser states before identity access", async () => {
    const f = fixture();
    await serve(f.db, f.cache, config, async origin => {
        const login = await start(origin);
        for (const cookie of [undefined, "session_wecom_state=another-state"]) {
            expect((await callback(origin, login.state, cookie)).status).toBe(400);
            expect(f.values.get(`wecom-state:${login.state}`)).toBe("designer");
        }
        expect((await callback(origin, "expired", "session_wecom_state=expired")).status).toBe(400);
        f.values.set("wecom-state:old-admin", "admin");
        expect((await callback(origin, "old-admin", "session_wecom_state=old-admin")).status).toBe(400);
        const missingCode = await fetch(`${origin}/api/auth/wecom/callback?state=${login.state}`, { headers: { cookie: login.cookie } });
        expect(missingCode.status).toBe(400);
        expect(f.queries).toHaveLength(0);
    });
});

test("QR login marks the trusted session as WeCom and bypasses local onboarding without changing credentials", async () => {
    const upstream = upstreamIdentity();
    try {
        for (const must_change_password of [false, true]) {
            const f = fixture({ user: { ...designer, must_change_password } });
            await serve(f.db, f.cache, config, async origin => {
                const login = await start(origin);
                const response = await callback(origin, login.state, login.cookie);
                expect(response.status).toBe(302);
                expect(response.headers.get("location")).toBe("/");
                expect(response.headers.getSetCookie().some(value => value.startsWith("session=") && value.includes("HttpOnly"))).toBe(true);
                expect(response.headers.getSetCookie().some(value => value.startsWith("session_wecom_state=;") && value.includes("Path=/api/auth/wecom"))).toBe(true);
                const identity = f.queries.find(q => q.sql.includes("LEFT JOIN external_identities"))!;
                expect(identity.sql).toContain("e.subject=$1 OR u.employee_no=$1");
                expect(identity.parameters).toEqual(["employee-17"]);
                expect(f.queries.find(q => q.sql.startsWith("INSERT INTO external_identities"))?.parameters).toEqual([designer.id, "employee-17"]);
                const session = f.queries.find(q => q.sql.startsWith("INSERT INTO sessions"))!;
                expect(session.parameters?.[1]).toBe(designer.id);
                expect(session.parameters?.[5]).toBe(config.SESSION_TTL_SECONDS);
                expect(session.sql).toContain("auth_provider");
                expect(session.sql).toContain("'wecom'");
                const userWrites = f.queries.filter(q => /^(INSERT INTO|UPDATE) users/.test(q.sql));
                expect(userWrites).toHaveLength(1);
                expect(userWrites[0]!.sql).not.toContain("password");
                expect(userWrites[0]!.parameters).toEqual([designer.id]);
                expect((await callback(origin, login.state, login.cookie)).status).toBe(400);
            });
        }
        expect(upstream.calls).toHaveLength(4);
    } finally { upstream.restore(); }
});

test("failed WeCom identity exchange cannot bind an account or issue an exempt session", async () => {
    for (const payload of [{ errcode: 40029, errmsg: "invalid code" }, { errcode: 0 }]) {
        const upstream = upstreamIdentity(payload);
        try {
            const f = fixture();
            await serve(f.db, f.cache, config, async origin => {
                const login = await start(origin);
                const response = await callback(origin, login.state, login.cookie);
                expect(response.status).toBe(502);
                expect(response.headers.getSetCookie().some(value => value.startsWith("session="))).toBe(false);
                expect(f.queries.some(q => q.sql.includes("LEFT JOIN external_identities"))).toBe(false);
                expect(f.queries.some(q => /^(INSERT INTO|UPDATE) (users|sessions|external_identities)/.test(q.sql))).toBe(false);
                expect(f.writes.some(write => write.key.startsWith("session:"))).toBe(false);
            });
        } finally { upstream.restore(); }
    }
});

test("QR callback never issues a session to missing, disabled, deleted, guest or privileged users", async () => {
    const upstream = upstreamIdentity();
    try {
        for (const user of [null, { ...designer, status: "disabled" }, { ...designer, status: "deleted" }, { ...designer, status: "locked" },
            { ...designer, is_guest: true }, { ...designer, role: "super_admin" }, { ...designer, role: "department_admin" }]) {
            const f = fixture({ user });
            await serve(f.db, f.cache, config, async origin => {
                const login = await start(origin);
                const response = await callback(origin, login.state, login.cookie);
                expect(response.status).toBe(403);
                expect(response.headers.getSetCookie().some(value => value.startsWith("session="))).toBe(false);
                expect(f.queries.some(q => q.sql.startsWith("INSERT") || q.sql.startsWith("UPDATE"))).toBe(false);
            });
        }
    } finally { upstream.restore(); }
});

test("QR callback rechecks account eligibility under lock before creating a binding or session", async () => {
    const upstream = upstreamIdentity();
    try {
        for (const lockedUser of [null, { ...designer, status: "disabled" }, { ...designer, status: "deleted" }, { ...designer, is_guest: true }, { ...designer, role: "super_admin" }]) {
            const f = fixture({ lockedUser });
            await serve(f.db, f.cache, config, async origin => {
                const login = await start(origin);
                expect((await callback(origin, login.state, login.cookie)).status).toBe(403);
                expect(f.queries.some(q => q.sql.endsWith("FOR UPDATE"))).toBe(true);
                expect(f.queries.some(q => q.sql === "ROLLBACK")).toBe(true);
                expect(f.queries.some(q => q.sql.startsWith("INSERT") || q.sql.startsWith("UPDATE"))).toBe(false);
            });
        }
    } finally { upstream.restore(); }
});

test("conflicting WeCom bindings roll back without changing a user or issuing a session", async () => {
    const upstream = upstreamIdentity();
    try {
        const f = fixture({ conflict: true });
        await serve(f.db, f.cache, config, async origin => {
            const login = await start(origin);
            expect((await callback(origin, login.state, login.cookie)).status).toBe(409);
            expect(f.queries.some(q => q.sql === "ROLLBACK")).toBe(true);
            expect(f.queries.some(q => q.sql.startsWith("INSERT INTO sessions") || q.sql.startsWith("UPDATE users"))).toBe(false);
        });
    } finally { upstream.restore(); }
});

test("concurrent callbacks can consume a browser state only once", async () => {
    const upstream = upstreamIdentity();
    try {
        const f = fixture();
        let reads = 0;
        let release!: () => void;
        const bothRead = new Promise<void>(resolve => { release = resolve; });
        f.cache.get = async key => {
            const value = f.values.get(key) ?? null;
            if (key.startsWith("wecom-state:")) {
                if (++reads === 2) release();
                await bothRead;
            }
            return value;
        };
        await serve(f.db, f.cache, config, async origin => {
            const login = await start(origin);
            const responses = await Promise.all([callback(origin, login.state, login.cookie), callback(origin, login.state, login.cookie)]);
            expect(responses.map(response => response.status).sort()).toEqual([302, 400]);
            expect(f.queries.filter(q => q.sql.startsWith("INSERT INTO sessions"))).toHaveLength(1);
            expect(upstream.calls).toHaveLength(2);
        });
    } finally { upstream.restore(); }
});
