import { expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { createAuthRouter } from "../src/routes/auth";
import { hashToken } from "../src/security";
import { sessionMiddleware } from "../src/session";
import type { UserRow } from "../src/user-mapper";

const config = {
  AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false",
  SESSION_COOKIE_NAME: "renewal_fixture", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test",
} as AppConfig;
type StoredSession = UserRow & { session_id: string; auth_provider: string; session_remaining_seconds: number };
const initial: StoredSession = {
  id: "employee-id", session_id: "session-id", auth_provider: "wecom", session_remaining_seconds: 27000,
  username: "employee", display_name: "Employee", role: "designer", status: "active", is_guest: false,
  email: null, employee_no: null, department_id: null, department_name: null,
  group_id: null, group_name: null, group_role: null, must_change_password: true, mfa_enabled: false,
  credit_balance: 0, credit_limit: 0, monthly_credit_limit: 0, temporary_credit_adjustment: 0,
  credit_period_start: "2032-01-01", current_credit_period_start: "2032-01-01", credit_reset_at: "2032-02-01",
};

async function fixture(options: {
  row?: Partial<StoredSession>; deployment?: Partial<AppConfig>;
  afterRenewalMiss?: Partial<StoredSession> | null; missing?: boolean; renewalError?: boolean;
}, run: (f: {
  request: (path?: string, owner?: string) => Promise<Response>;
  queries: { sql: string; values: unknown[] }[]; row: StoredSession;
}) => Promise<void>) {
  const row = { ...initial, ...options.row };
  const queries: { sql: string; values: unknown[] }[] = [];
  let attemptedRenewal = false;
  const db = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.startsWith("UPDATE sessions s SET expires_at")) {
      attemptedRenewal = true;
      if (options.renewalError) throw new Error("isolated renewal unavailable");
      if ("afterRenewalMiss" in options) return { rows: [] };
      row.session_remaining_seconds = Number(values[1]);
      return { rows: [{ session_remaining_seconds: row.session_remaining_seconds }] };
    }
    if (sql.includes("FROM sessions")) {
      if (options.missing || (attemptedRenewal && options.afterRenewalMiss === null)) return { rows: [] };
      return { rows: [{ ...row, ...(attemptedRenewal ? options.afterRenewalMiss : {}) }] };
    }
    if (sql.includes("revoked_at=now()") || sql.startsWith("INSERT INTO audit_logs")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } } as unknown as Database;
  const cache = { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Cache;
  const deployment = { ...config, ...options.deployment };
  const app = express().use(cookieParser());
  app.use("/auth", createAuthRouter(db, cache, deployment));
  app.get("/business", sessionMiddleware(db, cache, deployment), (_req, res) => res.json({ ok: true }));
  app.use(((_error, _req, res, _next) => res.status(500).json({ error: "FIXTURE_ERROR" })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await run({ row, queries, request: (path = "/auth/session", owner) => fetch(`${origin}${path}`, {
      method: path.toLowerCase().replace(/\/+$/, "") === "/auth/logout" ? "POST" : "GET",
      headers: { cookie: `${deployment.SESSION_COOKIE_NAME}=verified-token`, ...(owner === undefined ? {} : { "X-Canvas-Owner-Id": owner }) },
      signal: AbortSignal.timeout(5_000),
    }) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
const renewals = (queries: { sql: string; values: unknown[] }[]) => queries.filter(q => q.sql.startsWith("UPDATE sessions s SET expires_at"));
const sessionCookies = (response: Response) => response.headers.getSetCookie().filter(value => value.startsWith("renewal_fixture=verified-token;"));

test.each([
  { provider: "local", oa: "false", remaining: 27000, ttl: 28800 },
  { provider: "wecom", oa: "false", remaining: 27000, ttl: 28800 },
  { provider: "oa", oa: "true", remaining: 6000, ttl: 7200 },
])("active $provider renews only its existing TTL and retains all database guards", async item => {
  await fixture({ row: { auth_provider: item.provider, session_remaining_seconds: item.remaining }, deployment: { OA_LOGIN_ENABLED: item.oa } }, async ({ request, queries }) => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sessionCookies(response)).toHaveLength(1);
    expect(sessionCookies(response)[0]).toContain(`Max-Age=${item.ttl};`);
    expect(sessionCookies(response)[0]).toContain("HttpOnly");
    const update = renewals(queries)[0]!;
    expect(update.values).toEqual([initial.session_id, item.ttl, 600, initial.id, item.provider, initial.role, hashToken("verified-token")]);
    for (const guard of ["s.revoked_at IS NULL", "s.expires_at>now()", "s.user_id=$4", "s.auth_provider=$5", "s.token_hash=$7", "u.status='active'", "u.deleted_at IS NULL", "u.is_guest=false", "u.role=$6"]) expect(update.sql).toContain(guard);
    const again = await request();
    expect(again.status).toBe(200);
    expect(renewals(queries)).toHaveLength(1);
  });
});

test("fresh sessions skip UPDATE while status refreshes only the verified remaining cookie lifetime", async () => {
  await fixture({ row: { session_remaining_seconds: 28720 } }, async ({ request, queries }) => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(sessionCookies(response)[0]).toContain("Max-Age=28720;");
    expect(renewals(queries)).toHaveLength(0);
    expect(queries).toHaveLength(1);
  });
});

test("business renewal never sends a cookie, and the next heartbeat repairs browser expiry without another write", async () => {
  await fixture({}, async ({ request, queries }) => {
    const business = await request("/business");
    expect(business.status).toBe(200);
    expect(business.headers.get("set-cookie")).toBeNull();
    const heartbeat = await request();
    expect(heartbeat.status).toBe(200);
    expect(sessionCookies(heartbeat)[0]).toContain("Max-Age=28800;");
    expect(renewals(queries)).toHaveLength(1);
  });
});

test("owner mismatches are rejected before either DB or cookie renewal", async () => {
  await fixture({}, async ({ request, queries }) => {
    for (const owner of ["other-employee", ""]) {
      const response = await request("/auth/session", owner);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "CANVAS_OWNER_MISMATCH" });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(renewals(queries)).toHaveLength(0);
  });
});

test.each([
  { name: "WeCom administrator", row: { role: "super_admin" }, deployment: {} },
  { name: "WeCom in OA", row: {}, deployment: { OA_LOGIN_ENABLED: "true" } },
  { name: "local designer in OA", row: { auth_provider: "local" }, deployment: { OA_LOGIN_ENABLED: "true" } },
  { name: "OA administrator", row: { auth_provider: "oa", role: "super_admin" }, deployment: { OA_LOGIN_ENABLED: "true" } },
  { name: "authenticated guest", row: { is_guest: true }, deployment: {} },
] as const)("rejected $name cannot renew", async item => {
  await fixture(item, async ({ request, queries }) => {
    const response = await request();
    expect(response.status).toBe(401);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(renewals(queries)).toHaveLength(0);
  });
});

test("accepted open-trial guest does not enter employee sliding renewal", async () => {
  await fixture({ row: { auth_provider: "local", is_guest: true }, deployment: { AUTH_ENABLED: "false" } }, async ({ request, queries }) => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(renewals(queries)).toHaveLength(0);
  });
});

test.each(["/auth/logout", "/auth/LOGOUT/"])("%s explicitly skips renewal and returns only a cleared cookie", async path => {
  await fixture({}, async ({ request, queries }) => {
    const response = await request(path);
    expect(response.status).toBe(204);
    expect(renewals(queries)).toHaveLength(0);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.get("set-cookie")).toContain("renewal_fixture=;");
    expect(queries.some(q => q.sql.startsWith("UPDATE sessions SET revoked_at=now()"))).toBe(true);
  });
});

test("a competing renewal is reread and its remaining lifetime is used for the cookie", async () => {
  await fixture({ afterRenewalMiss: { session_remaining_seconds: 28799 } }, async ({ request, queries }) => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(sessionCookies(response)[0]).toContain("Max-Age=28799;");
    expect(renewals(queries)).toHaveLength(1);
    expect(queries.filter(q => q.sql.includes("FROM sessions"))).toHaveLength(2);
  });
});

test.each([
  { name: "revoked/expired/disabled/deleted session", afterRenewalMiss: null },
  { name: "changed employee", afterRenewalMiss: { id: "different-employee" } },
  { name: "changed provider", afterRenewalMiss: { auth_provider: "local" } },
  { name: "changed role", afterRenewalMiss: { role: "super_admin" } },
  { name: "converted guest", afterRenewalMiss: { is_guest: true } },
] as const)("renewal reread fails closed for $name", async item => {
  await fixture(item, async ({ request }) => {
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "SESSION_EXPIRED" });
    expect(sessionCookies(response)).toHaveLength(0);
  });
});

test("missing sessions cannot be revived and a failed renewal cannot send a success cookie", async () => {
  await fixture({ missing: true }, async ({ request, queries }) => {
    const response = await request();
    expect(response.status).toBe(401);
    expect(renewals(queries)).toHaveLength(0);
    expect(sessionCookies(response)).toHaveLength(0);
  });
  await fixture({ renewalError: true }, async ({ request }) => {
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
