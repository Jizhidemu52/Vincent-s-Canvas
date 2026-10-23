/** Optional local auxiliary check. This is not the real PG/Redis/S3/index.ts suite. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import cookieParser from "cookie-parser";
import express from "express";
import { loadConfig } from "../../src/config";
import type { Cache } from "../../src/db";
import type { ObjectStorage } from "../../src/object-storage";
import { designerModelPrivacy } from "../../src/model-privacy";
import { createAuthRouter } from "../../src/routes/auth";
import { createAssetsRouter } from "../../src/routes/assets";
import { createCanvasDocumentsRouter } from "../../src/routes/canvas-documents";
import { createDepartmentsRouter } from "../../src/routes/departments";
import { createHistoryRouter } from "../../src/routes/history";
import { createTasksRouter } from "../../src/routes/tasks";
import { requireAccountReady, sessionMiddleware } from "../../src/session";
import { createIsolatedPostgres } from "./isolated-postgres";
import { startOaHttpsFixture } from "./oa-https-fixture";
import { verifyTaskHttpContract } from "./task-http-contract";

async function runLocalRouterCheck() {
  const fixture = await createIsolatedPostgres();
  const identities = JSON.parse(process.env.OA_FIXTURE_IDENTITIES!) as Array<{ token: string; name: string }>;
  const config = loadConfig({ DATABASE_URL: "fixture", REDIS_URL: "fixture", OA_LOGIN_ENABLED: "true", AUTH_ENABLED: "false",
    OA_USERINFO_URL: process.env.OA_FIXTURE_URL, NODE_ENV: "test", CREDITS_ENABLED: "false", SESSION_COOKIE_NAME: "oa_router_sql" });
  const values = new Map<string, string>();
  const cache = { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); return "OK"; }, del: async (key: string) => Number(values.delete(key)),
    incr: async () => 1, expire: async () => 1, eval: async () => 1 } as unknown as Cache;
  const objects = new Map<string, Uint8Array>();
  const storage = { configured: true, put: async (key: string, body: Uint8Array) => { objects.set(key, body); },
    head: async (key: string) => ({ ETag: `"${key}"`, ContentLength: objects.get(key)!.byteLength }),
    get: async (key: string) => ({ ETag: `"${key}"`, ContentLength: objects.get(key)!.byteLength, Body: Readable.from([objects.get(key)!]) }) } as unknown as ObjectStorage;
  const app = express().use(express.json()).use(cookieParser());
  app.use("/api/auth", createAuthRouter(fixture.db, cache, config));
  const session = sessionMiddleware(fixture.db, cache, config);
  const privacy = designerModelPrivacy(fixture.db);
  app.use("/api/assets", session, requireAccountReady, privacy, createAssetsRouter(fixture.db, storage));
  app.use("/api/canvas-documents", session, requireAccountReady, privacy, createCanvasDocumentsRouter(fixture.db));
  app.use("/api/tasks", session, requireAccountReady, privacy, createTasksRouter(fixture.db, cache, false));
  app.use("/api/history", session, requireAccountReady, privacy, createHistoryRouter(fixture.db));
  app.use("/api/admin/departments", session, requireAccountReady, createDepartmentsRouter(fixture.db));
  app.use(((error, _request, response, _next) => response.status(error.type === "entity.parse.failed" || error.name === "ZodError" ? 400 : 500).json({ error: error.name, message: error.message })) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  type Employee = { id: string; cookie: string; assetId: string; taskId: string; historyId: string; requestId: string; secret: string };
  const employees: Employee[] = [];
  const api = (path: string, employee?: Employee, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(base + path, {
    method, headers: { ...(employee ? { cookie: employee.cookie, "x-canvas-owner-id": employee.id } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const provider = (await fixture.db.query("INSERT INTO providers(name,protocol,base_url) VALUES('OA router fixture','custom','https://no-network.invalid') RETURNING id")).rows[0];
    const model = (await fixture.db.query("INSERT INTO model_configs(provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,'OA router model','oa-router-model',ARRAY['generate'],0,0) RETURNING id", [provider.id])).rows[0];
    for (const identity of identities) {
      const response = await api("/api/auth/oa/exchange", undefined, { token: identity.token });
      assert.equal(response.status, 200, await response.clone().text());
      const user = (await response.json()).user;
      assert.equal(user.role, "designer"); assert.equal(user.displayName, identity.name);
      const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]!).find(value => value.startsWith("oa_router_sql=") && value !== "oa_router_sql=")!;
      assert.ok(cookie);
      const employee = { id: user.id, cookie, assetId: "", taskId: "", historyId: randomUUID(), requestId: randomUUID(), secret: `private-${randomUUID()}` };
      const requested = await api("/api/assets/upload-request", employee, { filename: "private.txt", mimeType: "text/plain", kind: "text", byteSize: Buffer.byteLength(employee.secret) });
      assert.equal(requested.status, 201); const asset = await requested.json(); employee.assetId = asset.assetId;
      const upload = await fetch(base + asset.uploadUrl, { method: "PUT", headers: { cookie, "x-canvas-owner-id": user.id, "content-type": "text/plain" }, body: employee.secret });
      assert.equal(upload.status, 204);
      const task = await verifyTaskHttpContract({ base, headers: { cookie, "x-canvas-owner-id": user.id },
        submission: { requestId: employee.requestId, projectId: "same-canvas", operationType: "image_generation", modelConfigId: model.id, prompt: employee.secret, sourceUrls: [] },
        expected: { requestId: employee.requestId, status: "waiting" } }); employee.taskId = task.id;
      await fixture.db.query("UPDATE tasks SET status='success' WHERE id=$1", [task.id]);
      await fixture.db.query("INSERT INTO generation_history(id,task_id,user_id,project_id,operation_type,prompt,source_urls,result_urls,credits,rmb_cost,status) VALUES($1,$2,$3,'same-canvas','image_generation',$4,'[]','[]',0,0,'success')", [employee.historyId, task.id, user.id, employee.secret]);
      const document = { id: "same-canvas", title: employee.secret, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 } };
      const saved = await api("/api/canvas-documents/same-canvas", employee, { baseRevision: 0, document }, "PUT");
      assert.equal(saved.status, 200, await saved.clone().text()); employees.push(employee);
    }
    assert.notEqual(employees[0]!.id, employees[1]!.id);
    for (const [index, employee] of employees.entries()) {
      const other = employees[1 - index]!;
      for (const path of ["/api/tasks", "/api/assets", "/api/history", "/api/canvas-documents"]) {
        assert.equal((await api(path)).status, 401);
        const own = await api(path, employee); assert.equal(own.status, 200); assert.ok(!(await own.text()).includes(other.secret));
      }
      const own = await api(`/api/assets/${employee.assetId}/content`, employee); assert.equal(own.status, 200); assert.equal(await own.text(), employee.secret);
      for (const path of [`/api/assets/${other.assetId}`, `/api/assets/${other.assetId}/content`, `/api/tasks/${other.taskId}`, `/api/tasks/by-request/${other.requestId}`, `/api/history/${other.historyId}`]) assert.equal((await api(path, employee)).status, 404);
      assert.equal((await api("/api/admin/departments", employee)).status, 403);
      const bad = await api("/api/auth/oa/exchange", employee, { token: "bad-token" }); assert.equal(bad.status, 401);
      assert.equal((await api("/api/auth/session", employee)).status, 401);
    }
    assert.equal((await fixture.db.query("SELECT count(*)::int AS count FROM users WHERE is_guest=true")).rows[0].count, 0);
    console.log(JSON.stringify({ oaRouterSqlSmoke: "passed", sameNameEmployees: 2, trustedHttps: true, guestFallback: false, crossAccountReads: "blocked", departments: 403, sharedTaskContract: "passed", runtime: "PGlite with cache and storage fixtures, not production services" }));
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture.close();
  }
}

if (import.meta.main) {
  if (process.argv.includes("--child")) await runLocalRouterCheck();
  else {
    const fixture = await startOaHttpsFixture({ port: 0 });
    try {
      const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--child"], { stdout: "inherit", stderr: "inherit",
        env: { ...fixture.trustedEnvironment(), OA_FIXTURE_URL: fixture.endpoint, OA_FIXTURE_IDENTITIES: JSON.stringify(fixture.employees) } });
      assert.equal(await child.exited, 0, "OA router SQL auxiliary check failed");
    } finally { await fixture.close(); }
  }
}
