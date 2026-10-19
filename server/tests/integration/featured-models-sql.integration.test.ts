import { expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MARK_IMAGE_BASE_URL, MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../../shared/mark-image-models";
import type { AppConfig } from "../../src/config";
import type { Database } from "../../src/db";
import { createModelConfigurationRouter, createPublicModelRouter } from "../../src/routes/model-configuration";

// Optional local PostgreSQL/WASM runtime. Never connect to an application or deployment database.
// PGLITE_RUNTIME_PATH must point to a directory containing node_modules/@electric-sql/pglite.
const runtime = process.env.PGLITE_RUNTIME_PATH;
const sqlTest = runtime ? test : test.skip;

sqlTest("real PostgreSQL SQL preserves featured order and explicit empty selection across database reopen", async () => {
  const requireRuntime = createRequire(resolve(runtime!, "package.json"));
  const { PGlite } = requireRuntime("@electric-sql/pglite");
  const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
  const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "canvas-featured-models-"));
  const databasePath = join(fixtureDirectory, "pgdata");
  const options = { extensions: { pgcrypto, citext } };
  let database = new PGlite(databasePath, options);
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  const actorId = "80000000-0000-4000-8000-000000000001";
  const encryptionKey = Buffer.alloc(32, 21).toString("base64");
  const query = async (sql: string, values: unknown[] = []) => {
    const result = await database.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  try {
    await database.waitReady;
    const migrationDirectory = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
    for (const name of (await readdir(migrationDirectory)).filter(name => name.endsWith(".sql")).sort()) {
      await database.exec(await readFile(join(migrationDirectory, name), "utf8"));
    }
    expect((await query("SELECT featured_model_ids FROM model_presentation_settings")).rows).toEqual([]);
    await query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'featured-sql-admin','Fixture admin','super_admin',false)", [actorId]);
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      const role = request.headers["x-fixture-role"];
      if (role) Object.assign(request, { auth: { id: actorId, role, departmentId: null } });
      next();
    });
    app.use("/api/admin/model-configuration", createModelConfigurationRouter(db, { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig));
    app.use("/api/models", createPublicModelRouter(db));
    app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.code, message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server!.once("listening", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const featuredPath = "/api/admin/model-configuration/featured-models";
    const request = (path: string, method = "GET", body?: unknown, role: string | null = "super_admin") => fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(role ? { "x-fixture-role": role } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const platformInput = {
      baseUrl: MARK_IMAGE_BASE_URL, enabled: true, apiKey: "fixture-mark-featured-no-network",
      models: MARK_PLATFORM_MODELS.map(model => ({ modelId: model.modelId, enabled: model.defaultEnabled, creditCost: 0, rmbCost: 0, concurrencyLimit: 2 })),
    };
    const configured = await request("/api/admin/model-configuration/mark-images", "PUT", platformInput);
    const configuredBody = await configured.json();
    expect(configured.status).toBe(200);
    expect(configuredBody.models.map((model: { modelId: string }) => model.modelId).sort()).toEqual(
      MARK_PLATFORM_MODELS.map((model) => model.modelId).sort(),
    );
    const modelId = (upstream: string) => String(configuredBody.models.find((model: { modelId: string }) => model.modelId === upstream).id);
    const getFeatured = async () => {
      const response = await request(featuredPath);
      expect(response.status).toBe(200);
      return response.json();
    };
    const initial = await getFeatured();
    expect(initial.models).toHaveLength(7);
    expect(initial.featuredModelIds).toEqual([
      "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-nano-banana-2.1", "midjourney-blend", "gpt-image-2",
    ].map(modelId));
    for (const role of [null, "designer", "department_admin"]) {
      expect((await request(featuredPath, "GET", undefined, role)).status).toBe(role ? 403 : 401);
      expect((await request(featuredPath, "PUT", { modelConfigIds: [] }, role)).status).toBe(role ? 403 : 401);
    }
    const ordered = ["gemini-3.1-flash-image-preview-official", "gpt-image-2.5-flare", "midjourney-blend"].map(modelId);
    const saved = await request(featuredPath, "PUT", { modelConfigIds: ordered });
    const savedBody = await saved.json();
    expect(saved.status).toBe(200);
    expect(savedBody.featuredModelIds).toEqual(ordered);
    expect((await query('SELECT featured_model_ids AS "ids",updated_by AS "actor" FROM model_presentation_settings')).rows).toEqual([{ ids: ordered, actor: actorId }]);
    expect((await query("SELECT action,detail FROM audit_logs WHERE action='featured_models.updated'")).rows[0]).toEqual({ action: "featured_models.updated", detail: { modelConfigIds: ordered } });
    expect((await request("/api/admin/model-configuration/mark-images", "PUT", { ...platformInput, apiKey: "" })).status).toBe(200);
    expect((await getFeatured()).featuredModelIds).toEqual(ordered);
    await database.close();
    database = new PGlite(databasePath, options);
    await database.waitReady;
    expect((await getFeatured()).featuredModelIds).toEqual(ordered);
    const publicResponse = await request("/api/models", "GET", undefined, "designer");
    expect(publicResponse.status).toBe(200);
    const publicBody = await publicResponse.json();
    expect(publicBody.models.filter((model: { isFeatured: boolean }) => model.isFeatured).map((model: { id: string }) => model.id)).toEqual(ordered);
    expect(JSON.stringify(publicBody)).not.toMatch(/fixture-mark|encrypted_credentials|providerId|providerName|providerEnabled|hasCredentials/);
    expect((await request(featuredPath, "PUT", { modelConfigIds: [modelId("grok-imagine-image-2.0")] })).status).toBe(400);
    expect((await getFeatured()).featuredModelIds).toEqual(ordered);
    // The actual DDL, not a string assertion, enforces the persisted maximum and rejects NULL entries.
    await expect(query("UPDATE model_presentation_settings SET featured_model_ids=$1::uuid[]", [Array(6).fill(ordered[0])])).rejects.toMatchObject({ code: "23514" });
    await expect(query("UPDATE model_presentation_settings SET featured_model_ids=ARRAY[NULL]::uuid[]")).rejects.toMatchObject({ code: "23514" });
    expect((await request(featuredPath, "PUT", { modelConfigIds: [] })).status).toBe(200);
    await database.close();
    database = new PGlite(databasePath, options);
    await database.waitReady;
    expect((await getFeatured()).featuredModelIds).toEqual([]);
    expect((await query("SELECT featured_model_ids FROM model_presentation_settings")).rows).toEqual([{ featured_model_ids: [] }]);
    const cleared = await (await request("/api/models", "GET", undefined, "designer")).json();
    expect(cleared.models.filter((model: { isFeatured: boolean }) => model.isFeatured)).toEqual([]);
    expect((await query("SELECT id FROM providers WHERE id=$1", [MARK_IMAGE_PROVIDER_ID])).rows).toHaveLength(1);
  } finally {
    if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
    await database.close();
    // This path was created by mkdtemp above; never remove user- or environment-supplied database paths.
    if (dirname(resolve(fixtureDirectory)) !== resolve(tmpdir())) throw new Error("Refusing fixture cleanup outside the temporary directory");
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}, 60_000);
