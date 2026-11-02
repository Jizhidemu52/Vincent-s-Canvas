import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../../src/config";
import type { Cache, Database } from "../../src/db";
import { createAuthRouter } from "../../src/routes/auth";
import { hashToken } from "../../src/security";
import { sessionMiddleware } from "../../src/session";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const config = {
  AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false",
  SESSION_COOKIE_NAME: "sql_session", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test",
} as AppConfig;
const cache = { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Cache;
const renewalSql = (sql: string) => sql.startsWith("UPDATE sessions s SET expires_at");

async function seed(db: Database, provider = "wecom", remaining = provider === "oa" ? 6000 : 27000) {
  const owner = randomUUID(), id = randomUUID(), token = randomUUID();
  await db.query("INSERT INTO users(id,username,display_name,must_change_password) VALUES($1,$2,'Fixture',false)", [owner, `session-${owner}`]);
  await db.query(`INSERT INTO sessions(id,user_id,token_hash,auth_provider,created_at,expires_at)
    VALUES($1,$2,$3,$4,now()-interval '30 days',now()+($5 * interval '1 second'))`, [id, owner, hashToken(token), provider, remaining]);
  return { owner, id, token };
}

async function serve(db: Database, token: string, oa: boolean, run: (request: (path?: string, owner?: string) => Promise<Response>) => Promise<void>) {
  const deployment: AppConfig = { ...config, OA_LOGIN_ENABLED: oa ? "true" : "false" };
  const app = express().use(cookieParser());
  app.use("/auth", createAuthRouter(db, cache, deployment));
  app.get("/business", sessionMiddleware(db, cache, deployment), (_req, res) => res.json({ ok: true }));
  app.use(((error, _req, res, _next) => res.status(500).json({ error: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await run(async (path = "/auth/session", owner) => {
      const response = await fetch(`${origin}${path}`, {
        method: path === "/auth/logout" ? "POST" : "GET",
        headers: { cookie: `sql_session=${token}`, ...(owner === undefined ? {} : { "X-Canvas-Owner-Id": owner }) },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 500) throw new Error(await response.text());
      return response;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function remaining(db: Database, id: string) {
  const result = await db.query("SELECT EXTRACT(EPOCH FROM (expires_at-now()))::float8 AS seconds, expires_at::text FROM sessions WHERE id=$1", [id]);
  return result.rows[0] as { seconds: number; expires_at: string };
}

integration("real SQL renews old active local/WeCom/OA sessions, preserves TTL and throttles business/status writes", async () => {
  const sql = await createIsolatedPostgres();
  try {
    for (const provider of ["local", "wecom", "oa"]) {
      const session = await seed(sql.db, provider);
      const ttl = provider === "oa" ? 7200 : 28800;
      const before = await remaining(sql.db, session.id);
      const start = sql.statements.length;
      await serve(sql.db, session.token, provider === "oa", async request => {
        const business = await request("/business", session.owner);
        expect(business.status).toBe(200);
        expect(business.headers.get("set-cookie")).toBeNull();
        const renewed = await remaining(sql.db, session.id);
        expect(renewed.seconds).toBeGreaterThan(ttl - 5);
        expect(renewed.seconds).toBeLessThanOrEqual(ttl);
        expect(renewed.expires_at).not.toBe(before.expires_at);
        const status = await request();
        expect(status.status).toBe(200);
        expect(status.headers.get("cache-control")).toBe("no-store");
        const maxAge = Number(status.headers.get("set-cookie")?.match(/Max-Age=(\d+)/)?.[1]);
        expect(maxAge).toBeGreaterThan(ttl - 5);
        expect(maxAge).toBeLessThanOrEqual(ttl);
        expect((await status.json()).user.id).toBe(session.owner);
        expect((await remaining(sql.db, session.id)).expires_at).toBe(renewed.expires_at);
        expect(sql.statements.slice(start).filter(renewalSql)).toHaveLength(1);
      });
    }
  } finally { await sql.close(); }
}, 60_000);

integration("real SQL admits only one renewal when eight requests have already read the same old expiry", async () => {
  const sql = await createIsolatedPostgres();
  try {
    const session = await seed(sql.db);
    const count = 8;
    let reads = 0, updates = 0, changed = 0;
    let release!: () => void;
    const allSelected = new Promise<void>(resolve => { release = resolve; });
    const db = { ...sql.db, query: async (query: string, values: unknown[]) => {
      const result = await sql.db.query(query, values);
      if (query.includes("WHERE s.token_hash=$1")) {
        if (++reads === count) release();
        await allSelected;
      }
      if (renewalSql(query)) { updates++; changed += result.rowCount ?? 0; }
      return result;
    } } as Database;
    await serve(db, session.token, false, async request => {
      const responses = await Promise.all(Array.from({ length: count }, () => request()));
      expect(responses.map(response => response.status)).toEqual(Array(count).fill(200));
      for (const response of responses) expect(response.headers.get("set-cookie")).toContain(`sql_session=${session.token};`);
    });
    expect(reads).toBe(count);
    expect(updates).toBe(count);
    expect(changed).toBe(1);
    expect((await remaining(sql.db, session.id)).seconds).toBeGreaterThan(28790);
  } finally { await sql.close(); }
}, 60_000);

integration("real SQL rejects expired/revoked/disabled/deleted sessions without renewing, including invalidation after SELECT", async () => {
  const sql = await createIsolatedPostgres();
  try {
    const cases = [
      { name: "expired", query: "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", user: false },
      { name: "revoked", query: "UPDATE sessions SET revoked_at=now() WHERE id=$1", user: false },
      { name: "disabled", query: "UPDATE users SET status='disabled' WHERE id=$1", user: true },
      { name: "deleted", query: "UPDATE users SET deleted_at=now() WHERE id=$1", user: true },
      { name: "role changed", query: "UPDATE users SET role='super_admin' WHERE id=$1", user: true },
      { name: "converted guest", query: "UPDATE users SET is_guest=true WHERE id=$1", user: true },
      { name: "token replaced", query: "UPDATE sessions SET token_hash=token_hash||'-replaced' WHERE id=$1", user: false },
    ];
    for (const afterSelect of [false, true]) for (const item of cases) {
      const session = await seed(sql.db);
      const invalidate = () => sql.db.query(item.query, [item.user ? session.owner : session.id]);
      if (!afterSelect) await invalidate();
      const before = await remaining(sql.db, session.id);
      const start = sql.statements.length;
      let invalidated = false;
      const db = { ...sql.db, query: async (query: string, values: unknown[]) => {
        const result = await sql.db.query(query, values);
        if (afterSelect && !invalidated && query.includes("WHERE s.token_hash=$1")) { invalidated = true; await invalidate(); }
        return result;
      } } as Database;
      await serve(db, session.token, false, async request => {
        const response = await request();
        expect(response.status).toBe(401);
        expect(response.headers.get("set-cookie")).toContain("sql_session=;");
        expect(response.headers.get("set-cookie")).not.toContain(session.token);
      });
      const after = await remaining(sql.db, session.id);
      if (item.name === "expired") expect(after.seconds).toBeLessThan(0);
      else expect(after.expires_at).toBe(before.expires_at);
      expect(sql.statements.slice(start).filter(renewalSql)).toHaveLength(afterSelect ? 1 : 0);
    }
  } finally { await sql.close(); }
}, 60_000);

integration("real SQL owner mismatch and logout preserve expiry, and logout prevents all later renewal", async () => {
  const sql = await createIsolatedPostgres();
  try {
    const session = await seed(sql.db);
    const before = await remaining(sql.db, session.id);
    const start = sql.statements.length;
    await serve(sql.db, session.token, false, async request => {
      const wrongOwner = await request("/auth/session", randomUUID());
      expect(wrongOwner.status).toBe(403);
      expect(wrongOwner.headers.get("set-cookie")).toBeNull();
      const logout = await request("/auth/logout");
      expect(logout.status).toBe(204);
      expect(logout.headers.getSetCookie()).toHaveLength(1);
      expect(logout.headers.get("set-cookie")).toContain("sql_session=;");
      expect((await request()).status).toBe(401);
    });
    expect((await remaining(sql.db, session.id)).expires_at).toBe(before.expires_at);
    expect(sql.statements.slice(start).filter(renewalSql)).toHaveLength(0);
  } finally { await sql.close(); }
}, 60_000);
