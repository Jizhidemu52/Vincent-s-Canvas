import { expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { createAuthRouter } from "../src/routes/auth";
import { requireAccountReady, sessionMiddleware } from "../src/session";

const config = { OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "true", SESSION_COOKIE_NAME: "session", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test" } as unknown as AppConfig;
const cache = { get: async () => null, set: async () => "OK", del: async () => 1, incr: async () => 1, expire: async () => 1 } as unknown as Cache;

async function serve(app: express.Express, run: (origin: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("local trial keeps OA and QR routes disabled despite legacy authentication flags", async () => {
  const db = { query: async () => { throw new Error("Unexpected database access"); } } as unknown as Database;
  const app = express().use(express.json()).use(cookieParser());
  app.use("/auth", createAuthRouter(db, cache, config));
  await serve(app, async (origin) => {
    for (const [path, method] of [["/oa/exchange", "POST"], ["/OA/exchange/", "POST"], ["/wecom/start", "GET"], ["/WECOM/start/", "GET"], ["/wecom/callback", "GET"]]) {
      const result = await fetch(`${origin}/auth${path}`, { method, headers: { cookie: "session=keep-me" } });
      expect(result.status).toBe(404);
      expect(result.headers.get("set-cookie")).toBeNull();
    }
  });
});

test("existing designer sessions can enter creation without OA provider checks", async () => {
  const db = { query: async () => ({ rows: [{ id: "designer", session_id: "session-id", auth_provider: "local", role: "designer", is_guest: false, status: "active" }] }) } as unknown as Database;
  const app = express().use(cookieParser());
  app.get("/creation", sessionMiddleware(db, cache, config), (_req, res) => res.json({ accepted: true }));
  await serve(app, async (origin) => {
    expect((await fetch(`${origin}/creation`, { headers: { cookie: "session=old-session" } })).status).toBe(200);
  });
});

test("administrator and password-change endpoints still require a non-guest session", async () => {
  const db = { query: async () => ({ rows: [{ id: "guest", session_id: "guest-session", role: "designer", is_guest: true }] }) } as unknown as Database;
  const app = express().use(express.json()).use(cookieParser());
  app.use("/auth", createAuthRouter(db, cache, config));
  app.get("/admin", sessionMiddleware(db, cache, config, { allowGuest: false }), (_req, res) => res.json({ accepted: true }));
  await serve(app, async (origin) => {
    expect((await fetch(`${origin}/admin`)).status).toBe(401);
    expect((await fetch(`${origin}/admin`, { headers: { cookie: "session=guest" } })).status).toBe(401);
    expect((await fetch(`${origin}/auth/change-password`, { method: "POST" })).status).toBe(401);
  });
});

test("legacy onboarding flags never block open creation but remain enforced by administrator routes", async () => {
  for (const role of ["designer", "super_admin"]) {
    const storedUser = { id: "existing-user", session_id: "existing-session", auth_provider: "local", role, is_guest: false, status: "active", must_change_password: true };
    const statements: string[] = [];
    const db = { query: async (sql: string) => { statements.push(sql); return { rows: [storedUser] }; } } as unknown as Database;
    const app = express().use(cookieParser());
    app.get("/creation", sessionMiddleware(db, cache, config), requireAccountReady, (_req, res) => res.json({ accepted: true }));
    app.get("/admin", sessionMiddleware(db, cache, config, { allowGuest: false }), requireAccountReady, (_req, res) => res.json({ accepted: true }));
    app.use("/auth", createAuthRouter(db, cache, config));
    await serve(app, async (origin) => {
      const headers = { cookie: "session=existing-token" };
      expect((await fetch(`${origin}/creation`, { headers })).status).toBe(200);
      expect(await fetch(`${origin}/auth/session`, { headers }).then(result => result.json())).toMatchObject({ user: { mustChangePassword: true } });
      const admin = await fetch(`${origin}/admin`, { headers });
      expect(admin.status).toBe(403);
      expect(await admin.json()).toMatchObject({ error: "PASSWORD_CHANGE_REQUIRED" });
    });
    expect(storedUser.must_change_password).toBe(true);
    expect(statements.every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
  }
});
