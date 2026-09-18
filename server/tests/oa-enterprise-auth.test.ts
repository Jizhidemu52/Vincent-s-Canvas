import { expect, test, spyOn } from "bun:test";
import cookieParser from "cookie-parser";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { createAuthRouter } from "../src/routes/auth";
import { requireAccountReady, sessionMiddleware } from "../src/session";
import { hashToken } from "../src/security";
import { resolveOaUser } from "../src/oa-identity";
import type { PoolClient } from "pg";

const config = { OA_LOGIN_ENABLED: "true", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", SESSION_COOKIE_NAME: "session", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test" } as unknown as AppConfig;
const cache = { get: async () => null, set: async () => "OK", del: async () => 1, incr: async () => 1, expire: async () => 1 } as unknown as Cache;

async function serve(app: express.Express, run: (origin: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("enterprise keeps QR routes disabled before database or upstream access", async () => {
  const db = { query: async () => { throw new Error("Unexpected database access"); } } as unknown as Database;
  const app = express().use(express.json()).use(cookieParser());
  app.use("/auth", createAuthRouter(db, cache, config));
  await serve(app, async (origin) => {
    for (const [path, method] of [["/wecom/start", "GET"], ["/WECOM/start/", "GET"], ["/wecom/callback", "GET"]]) {
      expect((await fetch(`${origin}/auth${path}`, { method })).status).toBe(404);
    }
  });
});

test("OA deployment rejects local sessions and privileged OA sessions", async () => {
  for (const [auth_provider, role, is_guest] of [["local", "designer", false], ["oa", "super_admin", false], ["oa", "designer", true]]) {
    const db = { query: async () => ({ rows: [{ session_id: "session-id", auth_provider, role, is_guest, status: "active" }] }) } as unknown as Database;
    const app = express().use(cookieParser());
    app.get("/protected", sessionMiddleware(db, cache, config), (_req, res) => res.json({ accepted: true }));
    await serve(app, async (origin) => {
      const response = await fetch(`${origin}/protected`, { headers: { cookie: "session=old-session" } });
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toContain("session=;");
    });
  }
});

test("enterprise denies missing or expired sessions without creating guest identities", async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as unknown as Database;
  const app = express().use(cookieParser());
  app.get("/creation", sessionMiddleware(db, cache, config), (_req, res) => res.json({ accepted: true }));
  await serve(app, async origin => {
    expect((await fetch(`${origin}/creation`)).status).toBe(401);
    const expired = await fetch(`${origin}/creation`, { headers: { cookie: "session=expired" } });
    expect(expired.status).toBe(401);
    expect(expired.headers.get("set-cookie")).toContain("session=;");
    expect(queries.every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
  });
});

test("enterprise rejects a stale tab owner header without revoking the new employee session", async () => {
  const db = { query: async () => ({ rows: [{ ...user, auth_provider: "oa", session_id: "active-session" }] }) } as unknown as Database;
  const app = express().use(cookieParser());
  app.get("/creation", sessionMiddleware(db, cache, config), (_req, res) => res.json({ accepted: true }));
  await serve(app, async origin => {
    const cookie = "session=active-token";
    for (const expectedOwner of ["stale-employee", ""]) {
      const rejected = await fetch(`${origin}/creation`, { headers: { cookie, "X-Canvas-Owner-Id": expectedOwner } });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ error: "CANVAS_OWNER_MISMATCH" });
      expect(rejected.headers.get("set-cookie")).toBeNull();
    }
    expect((await fetch(`${origin}/creation`, { headers: { cookie, "X-Canvas-Owner-Id": user.id } })).status).toBe(200);
    expect((await fetch(`${origin}/creation`, { headers: { cookie } })).status).toBe(200);
  });
});

test("enterprise administrator maintenance keeps its password session but cannot enter employee creation", async () => {
  for (const must_change_password of [true, false]) {
    const stored = { id: "admin-user", session_id: "admin-session", auth_provider: "local", role: "super_admin", status: "active", is_guest: false, must_change_password };
    const db = { query: async () => ({ rows: [stored] }) } as unknown as Database;
    const app = express().use(cookieParser());
    app.use("/auth", createAuthRouter(db, cache, config));
    app.get("/admin", sessionMiddleware(db, cache, config, { allowGuest: false }), requireAccountReady, (_req, res) => res.json({ accepted: true }));
    app.get("/creation", sessionMiddleware(db, cache, config), (_req, res) => res.json({ accepted: true }));
    await serve(app, async origin => {
      const headers = { cookie: "session=admin-token" };
      const session = await fetch(`${origin}/auth/session`, { headers });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ user: { role: "super_admin", mustChangePassword: must_change_password } });
      const admin = await fetch(`${origin}/admin`, { headers });
      expect(admin.status).toBe(must_change_password ? 403 : 200);
      const creation = await fetch(`${origin}/creation`, { headers });
      expect(creation.status).toBe(401);
    });
  }
});

test("invalid replacement token revokes and clears old identity even when exchange is rate limited", async () => {
  for (const limited of [false, true]) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const db = { query: async (sql: string, values: unknown[]) => { queries.push({ sql, values }); return { rows: [] }; } } as unknown as Database;
    const app = express().use(express.json()).use(cookieParser());
    app.use("/auth", createAuthRouter(db, { ...cache, incr: async () => limited ? 21 : 1 }, config));
    await serve(app, async (origin) => {
      const response = await fetch(`${origin}/auth/oa/exchange`, { method: "POST", headers: { cookie: "session=prior-identity", "content-type": "application/json" }, body: JSON.stringify({ token: "", user: { role: "super_admin" } }) });
      expect(response.status).toBe(limited ? 429 : 401);
      expect(response.headers.get("set-cookie")).toContain("session=;");
      expect(queries).toEqual([{ sql: "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", values: [hashToken("prior-identity")] }]);
    });
  }
});

test("OA exchange cannot be used when disabled", async () => {
  const app = express().use(express.json()).use(cookieParser());
  const db = { query: async () => { throw new Error("Must not touch database"); } } as unknown as Database;
  app.use("/auth", createAuthRouter(db, cache, { ...config, OA_LOGIN_ENABLED: "false" }));
  await serve(app, async (origin) => {
    const response = await fetch(`${origin}/auth/oa/exchange`, { method: "POST", headers: { cookie: "session=keep-me" } });
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

const user = { id: "internal-user", username: "oa-internal-user", display_name: "Trusted Name", role: "designer", status: "active", is_guest: false, must_change_password: false };

test("verified OA exchange uses only upstream identity and issues an HttpOnly two-hour OA session", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return { rows: sql.startsWith("SELECT u.id") ? [{ ...user }] : [] };
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
  const app = express().use(express.json()).use(cookieParser());
  app.use("/auth", createAuthRouter(db, cache, { ...config, OA_USERINFO_URL: "https://oa.test/user" }));
  const originalFetch = globalThis.fetch;
  const upstream = spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
    if (String(input) === "https://oa.test/user") {
      expect(init.headers.Authorization).toBe("Bearer valid-oa-token");
      return Promise.resolve(Response.json({ userid: "employee-17", name: "Trusted Name", role: "super_admin" }));
    }
    return originalFetch(input, init);
  }) as unknown as typeof fetch);
  try {
    await serve(app, async (origin) => {
      const response = await fetch(`${origin}/auth/oa/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "valid-oa-token", id: "attacker", name: "Spoof Name", role: "super_admin" }) });
      expect(response.status).toBe(200);
      expect((await response.json()).user).toMatchObject({ id: "internal-user", displayName: "Trusted Name", role: "designer", mustChangePassword: false });
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Max-Age=7200");
      expect(cookie).not.toContain("valid-oa-token");
      const lookup = queries.find((q) => q.sql.includes("FROM external_identities e"))!;
      expect(lookup.values).toEqual(["employee-17"]);
      const insertedSession = queries.find((q) => q.sql.startsWith("INSERT INTO sessions"))!;
      expect(insertedSession.sql).toContain("'oa'");
      expect(insertedSession.values?.[1]).toBe("internal-user");
      expect(insertedSession.values?.[5]).toBe(7200);
      expect(JSON.stringify(queries)).not.toContain("valid-oa-token");
      expect(JSON.stringify(queries)).not.toContain("Spoof Name");
    });
  } finally { upstream.mockRestore(); }
});

test("OA identity mapping never reuses privileged, disabled or guest accounts", async () => {
  for (const override of [{ role: "super_admin" }, { status: "disabled" }, { is_guest: true }]) {
    let writes = 0;
    const client = { query: async (sql: string) => {
      if (sql.startsWith("INSERT") || sql.startsWith("UPDATE")) writes++;
      return { rows: sql.includes("FROM external_identities e") ? [{ ...user, ...override }] : [] };
    } } as unknown as PoolClient;
    await expect(resolveOaUser(client, { id: "employee-17", name: "Trusted Name" })).rejects.toMatchObject({ code: "OA_ACCOUNT_FORBIDDEN", status: 403 });
    expect(writes).toBe(0);
  }
});

test("first OA identity is provisioned as an independent passwordless ordinary account", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = { query: async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return { rows: sql.includes("FROM users u") ? [user] : [] };
  } } as unknown as PoolClient;
  await resolveOaUser(client, { id: "distinct-oa-id", name: "Existing Admin Name" });
  expect(queries[0]?.sql).toContain("pg_advisory_xact_lock");
  const insert = queries.find((q) => q.sql.includes("INSERT INTO users"))!;
  expect(insert.sql).toContain("'designer',false,false");
  expect(insert.values?.[1]).toBe(`oa-${insert.values?.[0]}`);
  const mapping = queries.find((q) => q.sql.includes("INSERT INTO external_identities"))!;
  expect(mapping.values).toEqual([insert.values?.[0], "distinct-oa-id"]);
});

test("OA logout revokes the session, invalidates its cache and clears its cookie", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const db = { query: async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return { rows: [{ ...user, auth_provider: "oa", session_id: "oa-session-id" }] };
  } } as unknown as Database;
  const deleted: string[] = [];
  const app = express().use(cookieParser());
  app.use("/auth", createAuthRouter(db, { ...cache, del: async (key) => { deleted.push(key); return 1; } }, config));
  await serve(app, async (origin) => {
    const response = await fetch(`${origin}/auth/logout`, { method: "POST", headers: { cookie: "session=oa-session" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("session=;");
    expect(queries.find((q) => q.sql.startsWith("UPDATE sessions"))?.values).toEqual(["oa-session-id"]);
    expect(deleted).toContain(`session:${hashToken("oa-session")}`);
  });
});
