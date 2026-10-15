/** Opt-in local UI QA, using formal routes and an isolated PostgreSQL/WASM database.
 * From server/: bun build scripts/featured-models-qa.ts --target=node --outfile ../output/featured-models-qa/server.mjs
 * Then: node --max-old-space-size=8192 ../output/featured-models-qa/server.mjs --serve
 * Optional: PGLITE_RUNTIME_PATH points to a runtime directory containing node_modules/@electric-sql/pglite.
 * Every launch creates a fresh run-* database. No production configuration/database is loaded.
 * Stop with Ctrl+C/SIGTERM. The exact run directory is retained for inspection; remove only that directory when finished.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { MARK_IMAGE_BASE_URL, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";
import { createModuleFlagsRouter } from "../src/routes/module-flags";
import type { AuthenticatedRequest, SessionUser } from "../src/types";

if (!process.argv.includes("--serve")) {
  console.error("Not started: explicit --serve is required. This fixture binds only to http://127.0.0.1:3102.");
  process.exit(1);
}

const root = [process.cwd(), resolve(process.cwd(), ".."), resolve(dirname(fileURLToPath(import.meta.url)), "../..")]
  .find(candidate => existsSync(join(candidate, "server/src/migrations")) && existsSync(join(candidate, "shared/mark-image-models.ts")));
if (!root) throw new Error("Run this fixture from the repository root or server directory");
const outputDirectory = join(root, "output/featured-models-qa");
const runtimeDirectory = process.env.PGLITE_RUNTIME_PATH
  ? resolve(process.env.PGLITE_RUNTIME_PATH)
  : join(root, "output/mark-admin-qa/runtime");
const requireRuntime = createRequire(join(runtimeDirectory, "package.json"));
const { PGlite } = requireRuntime("@electric-sql/pglite");
const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
await mkdir(outputDirectory, { recursive: true });
const runDirectory = await mkdtemp(join(outputDirectory, "run-"));
const databasePath = join(runDirectory, "pgdata");
const database = new PGlite(databasePath, { extensions: { pgcrypto, citext } });
const baseUrl = "http://127.0.0.1:3102";
const actorId = "80000000-0000-4000-8000-000000000002";
const fixtureUser: SessionUser = {
  id: actorId, username: "featured-qa-admin", displayName: "热门模型 QA 管理员", role: "super_admin", status: "active",
  email: null, employeeNo: null, departmentId: null, departmentName: null, groupId: null, groupName: null, groupRole: null,
  mustChangePassword: false, mfaEnabled: false, creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0,
  temporaryCreditAdjustment: 0, creditPeriodStart: "2026-10-01T00:00:00.000Z", creditResetAt: "2026-11-01T00:00:00.000Z",
};
const encryptionKey = Buffer.alloc(32, 21).toString("base64"); // Deliberately public, fixture-only key.
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let closing: Promise<void> | undefined;

async function close() {
  if (closing) return closing;
  closing = (async () => {
    if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
    await database.close();
    console.log(JSON.stringify({ closed: true, retainedFixtureDirectory: runDirectory,
      cleanup: "Only this newly-created run directory may be removed after inspection; no automatic deletion was performed." }));
  })();
  return closing;
}

try {
  await database.waitReady;
  await database.exec("CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrationDirectory = join(root, "server/src/migrations");
  const migrations = (await readdir(migrationDirectory)).filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    await database.exec("BEGIN");
    try {
      await database.exec(await readFile(join(migrationDirectory, name), "utf8"));
      await database.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await database.exec("COMMIT");
    } catch (error) { await database.exec("ROLLBACK"); throw error; }
  }
  await database.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,$2,$3,'super_admin',false)",
    [actorId, fixtureUser.username, fixtureUser.displayName]);

  // PGlite has one SQL connection. Hold its lease across formal route transactions,
  // so simultaneous browser reads cannot accidentally join another request's transaction.
  let queue = Promise.resolve();
  async function acquire() {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>(done => { release = done; });
    await previous;
    return release;
  }
  const query = async (sql: string, values: unknown[] = []) => {
    const result = await database.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      const release = await acquire();
      try { return await query(sql, values); } finally { release(); }
    },
    connect: async () => {
      const releaseLease = await acquire();
      let released = false;
      return { query, release() { if (!released) { released = true; releaseLease(); } } };
    },
  } as unknown as Database;

  // No generation/upload/worker route is mounted. Also reject accidental upstream fetches.
  const localFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== baseUrl) throw new Error("QA_ONLY: external network requests are disabled");
    return localFetch(input, init);
  }) as typeof fetch;

  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use((request, response, next) => {
    const role = request.headers["x-qa-role"] || "super_admin";
    if (!["super_admin", "department_admin", "designer", "unauthenticated"].includes(String(role))) {
      response.status(400).json({ error: "QA_INVALID_ROLE", message: "Unsupported fixture role" }); return;
    }
    if (role !== "unauthenticated") Object.assign(request, { auth: { ...fixtureUser, role } });
    if (request.body?.baseUrl !== undefined && request.body.baseUrl !== MARK_IMAGE_BASE_URL) {
      response.status(400).json({ error: "QA_ONLY", message: "Only the fixed official APIMart URL is allowed in this fixture" }); return;
    }
    const submittedSecrets = [request.body?.apiKey, ...Object.values(request.body?.credentials ?? {})];
    if (submittedSecrets.some(value => value && (typeof value !== "string" || !value.startsWith("fixture-featured-")))) {
      response.status(400).json({ error: "QA_ONLY", message: "Only fake fixture-featured-* credentials are accepted" }); return;
    }
    next();
  });
  app.get("/api/deployment", (_request, response) => response.json({
    authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false,
  }));
  app.get("/api/auth/session", (request, response) => {
    const user = (request as unknown as AuthenticatedRequest).auth;
    if (!user) { response.status(401).json({ error: "UNAUTHENTICATED", message: "请先登录" }); return; }
    response.json({ user });
  });
  app.use("/api/admin/model-configuration", createModelConfigurationRouter(db, { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig));
  app.use("/api/models", createPublicModelRouter(db));
  app.use("/api/modules", createModuleFlagsRouter(db));
  app.use("/api", (_request, response) => response.status(403).json({ error: "QA_ONLY", message: "This isolated fixture exposes configuration only; generation, upload and provider requests are disabled" }));
  app.use(((error, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "VALIDATION_ERROR", message: "提交内容不符合要求", issues: error.issues }); return;
    }
    response.status(500).json({ error: "INTERNAL_ERROR", message: "Isolated QA request failed" });
  }) as ErrorRequestHandler);

  server = app.listen(3102, "127.0.0.1");
  await new Promise<void>((done, reject) => { server!.once("listening", done); server!.once("error", reject); });
  const seed = await fetch(`${baseUrl}/api/admin/model-configuration/mark-images`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: MARK_IMAGE_BASE_URL, enabled: true, apiKey: "fixture-featured-qa-no-network",
      models: MARK_PLATFORM_MODELS.map(model => ({ modelId: model.modelId, enabled: model.defaultEnabled, creditCost: 0, rmbCost: 0, concurrencyLimit: 2 })),
    }),
  });
  assert.equal(seed.status, 200, "Formal Mark configuration route could not seed the isolated fixture");
  assert.equal((await seed.json()).models.length, 9, "Expected the nine shared Mark presets");
  assert.equal((await db.query("SELECT singleton FROM model_presentation_settings")).rows.length, 0,
    "A fresh fixture must start with unsaved featured defaults");

  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  console.log(JSON.stringify({
    ready: true, url: baseUrl, featuredModelsUrl: `${baseUrl}/api/admin/model-configuration/featured-models`,
    engine: "PostgreSQL via PGlite; new isolated QA database", databasePath, migrationsApplied: migrations.length,
    pid: process.pid, actorId, auth: "x-qa-role: super_admin (default), department_admin, designer, or unauthenticated",
    modelCount: 9, disabledModel: "grok-imagine-image-2.0", upstreamCalls: 0,
    shutdown: "Ctrl+C or SIGTERM closes HTTP and PGlite; this run directory is retained for inspection.",
    cleanup: `After stopping, remove only ${runDirectory} if no longer needed. Every new launch uses a fresh directory.`,
  }));
} catch (error) {
  await close();
  throw error;
}
