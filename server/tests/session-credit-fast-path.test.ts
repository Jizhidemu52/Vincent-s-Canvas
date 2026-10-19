import { expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import express from "express";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { sessionMiddleware } from "../src/session";

const config = { AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false", SESSION_COOKIE_NAME: "fixture", SESSION_TTL_SECONDS: 600 } as AppConfig;
const cache = { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Cache;

async function fixture(stale: boolean, creditsEnabled: boolean, invalidAfterRefresh = false) {
  const queries: string[] = [];
  let connections = 0, reads = 0;
  // Deliberately differs from the host month: database time owns this decision.
  const row = { id: "user", session_id: "session", auth_provider: "local", role: "designer", status: "active", is_guest: false,
    credit_period_start: stale ? "2031-12-01" : "2032-01-01", current_credit_period_start: "2032-01-01" };
  const query = async (sql: string) => {
    queries.push(sql);
    if (sql.includes("FROM sessions")) return { rows: ++reads > 1 && invalidAfterRefresh ? [] : [{ ...row }] };
    if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled }] };
    if (sql.includes("FOR NO KEY UPDATE")) return { rows: [{ ...row, current_period_start: "2032-01-01", monthly_credit_limit: 100, credit_balance: 20, credit_limit: 100, temporary_credit_adjustment: 0 }] };
    if (sql.startsWith("UPDATE users")) row.credit_period_start = "2032-01-01";
    return { rows: [] };
  };
  const db = { query, connect: async () => { connections++; return { query, release() {} }; } } as unknown as Database;
  const app = express().use(cookieParser());
  app.get("/session", sessionMiddleware(db, cache, config), (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/session`, { headers: { cookie: "fixture=token" } });
    return { status: response.status, queries, reads, connections };
  } finally { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); }
}

test("current database month skips credit policy, transaction and duplicate identity lookup", async () => {
  const result = await fixture(false, true);
  expect(result.status).toBe(200);
  expect(result.reads).toBe(1);
  expect(result.connections).toBe(0);
  expect(result.queries).toHaveLength(1);
  expect(result.queries[0]).toContain("u.deleted_at IS NULL");
});

test("disabled credits do not trigger a rollover transaction or identity reread", async () => {
  const result = await fixture(true, false);
  expect(result.status).toBe(200);
  expect(result.reads).toBe(1);
  expect(result.connections).toBe(0);
  expect(result.queries).toHaveLength(2);
});

test("stale enabled credits use the locked rollover then reread eligibility", async () => {
  const result = await fixture(true, true);
  expect(result.status).toBe(200);
  expect(result.reads).toBe(2);
  expect(result.connections).toBe(1);
  expect(result.queries.some(sql => sql.includes("FOR NO KEY UPDATE"))).toBe(true);
  expect(result.queries.filter(sql => sql.includes("FROM sessions")).every(sql => sql.includes("u.deleted_at IS NULL"))).toBe(true);
});

test("rollover cannot authorize a session deleted, disabled or revoked during its transaction", async () => {
  const result = await fixture(true, true, true);
  expect(result.status).toBe(401);
  expect(result.reads).toBe(2);
});
