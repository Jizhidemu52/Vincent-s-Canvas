import { expect, test } from "bun:test";
import express from "express";
import { request as httpRequest } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createAssetsRouter } from "../../src/routes/assets";
import { hashAssetContent } from "../../src/asset-content-hash";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import type { Database } from "../../src/db";
import type { ObjectStorage } from "../../src/object-storage";
import type { AuthenticatedRequest } from "../../src/types";

const integration = process.env.PGLITE_RUNTIME_PATH || process.env.RUN_INTEGRATION_TESTS === "true" ? test : test.skip;
const a = "61000000-0000-4000-8000-000000000001", b = "61000000-0000-4000-8000-000000000002";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");

async function createAssetDatabase() {
  if (process.env.RUN_INTEGRATION_TESTS !== "true") return createIsolatedPostgres();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for PostgreSQL asset upload tests");
  const control = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
  const schema = `asset_hash_${crypto.randomUUID().replaceAll("-", "")}`;
  let db: Pool | undefined;
  let created = false;
  const close = async () => {
    await db?.end();
    try { if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await control.end(); }
  };
  try {
    await control.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await control.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    db = new Pool({ connectionString: process.env.DATABASE_URL, max: 6, connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000` });
    const migrations = new URL("../../src/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort())
      await db.query(await readFile(new URL(name, migrations), "utf8"));
    return { db, close };
  } catch (error) { await close(); throw error; }
}

async function createUploadHarness(storage: ObjectStorage, prechecked: (id: string) => void = () => {}) {
  const fixture = await createAssetDatabase();
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'upload-a','Upload A','designer'),($2,'upload-b','Upload B','designer')", [a, b]);
  const db = {
    connect: () => fixture.db.connect(),
    query: async (sql: string, values: unknown[] = []) => {
      const result = await fixture.db.query(sql, values);
      if (sql.startsWith("SELECT object_key,mime_type,byte_size,metadata FROM assets") && !sql.includes("FOR UPDATE")) prechecked(String(values[0]));
      return result;
    },
  } as unknown as Database;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = { id: a, role: "designer", departmentId: null } as AuthenticatedRequest["auth"]; next(); });
  app.use("/api/assets", createAssetsRouter(db, storage));
  app.use((_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: "UPLOAD_FAILED" }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  return {
    ...fixture, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    reserve: async (body: Buffer) => {
      const id = crypto.randomUUID(), key = `upload/${id}`;
      await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind) VALUES($1,$2,$3,'upload.txt','text/plain',$4,'text')", [id, a, key, body.length]);
      return { id, key };
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture.close(); },
  };
}

function delayedUpload(base: string, id: string, body: Buffer) {
  let resolve!: (status: number) => void, reject!: (error: Error) => void;
  const response = new Promise<number>((done, fail) => { resolve = done; reject = fail; });
  const request = httpRequest(`${base}/api/assets/${id}/upload`, {
    method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": body.length },
  }, incoming => { incoming.resume(); incoming.once("end", () => resolve(incoming.statusCode!)); });
  request.once("error", reject);
  request.write(body.subarray(0, 1));
  request.flushHeaders();
  return { response, finish: () => request.end(body.subarray(1)), abort: () => request.destroy() };
}

function precheckBarrier(participants: number) {
  let arrivals = 0;
  let ready!: () => void;
  const pending = new Promise<void>(done => { ready = done; });
  return {
    observe: () => { if (++arrivals === participants) ready(); },
    wait: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([pending, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("Upload prechecks did not arrive")), 5_000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}

integration("content-hash reuse requires verified bytes, owner identity and a live ready image", async () => {
  const fixture = await createAssetDatabase();
  let writes = 0;
  const storage = { configured: true, put: async () => { writes++; }, get: async () => ({}) } as unknown as ObjectStorage;
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'hash-a','Hash A','designer'),($2,'hash-b','Hash B','designer')", [a, b]);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = { id: req.header("x-test-owner") || a, role: "designer", departmentId: null } as AuthenticatedRequest["auth"]; next(); });
  app.use("/api/assets", createAssetsRouter(fixture.db, storage));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const hash = hashAssetContent(png);
  const request = (owner = a, contentSha256 = hash) => fetch(`${base}/api/assets/upload-request`, { method: "POST", headers: { "content-type": "application/json", "x-test-owner": owner }, body: JSON.stringify({ filename: "ref.png", mimeType: "image/png", kind: "image", byteSize: png.length, metadata: { contentSha256 } }) }).then(r => r.json()) as Promise<{ assetId: string; uploadUrl: string | null; reused?: boolean }>;
  const upload = (path: string, owner = a) => fetch(base + path, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-test-owner": owner }, body: png });
  try {
    const pending = await request();
    const unverified = await request(); expect(unverified.assetId).not.toBe(pending.assetId);
    expect((await upload(pending.uploadUrl!, b)).status).toBe(404); expect(writes).toBe(0);
    expect((await upload(pending.uploadUrl!)).status).toBe(204); expect(writes).toBe(1);
    const stored = await fixture.db.query("SELECT content_sha256,status FROM assets WHERE id=$1", [pending.assetId]);
    expect(stored.rows[0]).toEqual({ content_sha256: hash, status: "ready" });
    expect(await request()).toEqual({ assetId: pending.assetId, uploadUrl: null, reused: true });
    const foreign = await request(b); expect(foreign.assetId).not.toBe(pending.assetId); expect(foreign.uploadUrl).toBeTruthy();
    const liar = await request(a, "0".repeat(64)); expect((await upload(liar.uploadUrl!)).status).toBe(400); expect(writes).toBe(1);
    await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [pending.assetId]);
    expect((await request()).assetId).not.toBe(pending.assetId);
    expect(writes).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture.close(); }
}, 30_000);

integration("two uploads that passed pending prechecks write one immutable object and its matching SHA256", async () => {
  const writes: Buffer[] = [], objects = new Map<string, Buffer>();
  const barrier = precheckBarrier(2);
  const storage = { configured: true, put: async (key: string, bytes: Buffer) => {
    writes.push(Buffer.from(bytes));
    await Bun.sleep(30); // A real PostgreSQL competitor waits on the held row here.
    objects.set(key, Buffer.from(bytes));
  } } as unknown as ObjectStorage;
  const fixture = await createUploadHarness(storage, barrier.observe);
  const firstBytes = Buffer.from("winner-body"), secondBytes = Buffer.from("second-body");
  const asset = await fixture.reserve(firstBytes);
  const first = delayedUpload(fixture.base, asset.id, firstBytes), second = delayedUpload(fixture.base, asset.id, secondBytes);
  try {
    await barrier.wait(); // Both requests read the original pending row before receiving their body.
    first.finish(); second.finish();
    const statuses = await Promise.all([first.response, second.response]);
    expect(statuses.sort()).toEqual([204, 404]);
    expect(writes).toHaveLength(1);
    expect(objects.get(asset.key)).toEqual(writes[0]);
    expect((await fixture.db.query("SELECT status,content_sha256,byte_size::int FROM assets WHERE id=$1", [asset.id])).rows[0])
      .toEqual({ status: "ready", content_sha256: hashAssetContent(objects.get(asset.key)!), byte_size: firstBytes.length });
  } finally { first.abort(); second.abort(); await fixture.close(); }
}, 30_000);

integration("an upload rechecks owner, deletion, size, MIME and hash metadata after the body arrives", async () => {
  let barrier = precheckBarrier(1), writes = 0;
  const fixture = await createUploadHarness({ configured: true, put: async () => { writes++; } } as unknown as ObjectStorage, () => barrier.observe());
  const bytes = Buffer.from("plain-text");
  const changes = [
    { sql: "owner_user_id=$2", value: b, status: 404 },
    { sql: "deleted_at=$2", value: new Date().toISOString(), status: 404 },
    { sql: "byte_size=$2", value: bytes.length + 1, status: 400 },
    { sql: "mime_type=$2", value: "application/json", status: 415 },
    { sql: "metadata=$2::jsonb", value: JSON.stringify({ contentSha256: "0".repeat(64) }), status: 400 },
  ];
  try {
    for (const change of changes) {
      barrier = precheckBarrier(1);
      const asset = await fixture.reserve(bytes);
      const upload = delayedUpload(fixture.base, asset.id, bytes);
      try {
        await barrier.wait();
        await fixture.db.query(`UPDATE assets SET ${change.sql} WHERE id=$1`, [asset.id, change.value]);
        upload.finish();
        expect(await upload.response).toBe(change.status);
        expect(writes).toBe(0);
        expect((await fixture.db.query("SELECT status,content_sha256 FROM assets WHERE id=$1", [asset.id])).rows[0])
          .toEqual({ status: "pending", content_sha256: null });
      } finally { upload.abort(); }
    }
  } finally { await fixture.close(); }
}, 30_000);

integration("an object-store error rolls back the upload claim and a later attempt can finish", async () => {
  let writes = 0;
  const fixture = await createUploadHarness({ configured: true, put: async () => { if (++writes === 1) throw new Error("Synthetic storage failure"); } } as unknown as ObjectStorage);
  const bytes = Buffer.from("retry-body"), asset = await fixture.reserve(bytes);
  const upload = () => fetch(`${fixture.base}/api/assets/${asset.id}/upload`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes });
  try {
    expect((await upload()).status).toBe(500);
    expect((await fixture.db.query("SELECT status,content_sha256 FROM assets WHERE id=$1", [asset.id])).rows[0]).toEqual({ status: "pending", content_sha256: null });
    expect((await upload()).status).toBe(204);
    expect((await fixture.db.query("SELECT status,content_sha256 FROM assets WHERE id=$1", [asset.id])).rows[0]).toEqual({ status: "ready", content_sha256: hashAssetContent(bytes) });
    expect(writes).toBe(2);
  } finally { await fixture.close(); }
}, 30_000);

integration("demo rechecks readiness after two uploads overlap in asynchronous MIME validation", async () => {
  const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = portReservation.port!; portReservation.stop(true);
  const deliveryUrl = new URL("../../src/asset-delivery.ts", import.meta.url);
  const script = `
    const { mock } = await import('bun:test');
    const actual = await import(${JSON.stringify(deliveryUrl.href)});
    const validate = actual.validateAssetUpload;
    let validations = 0, release;
    const bothValidating = new Promise(resolve => { release = resolve; });
    mock.module(${JSON.stringify(fileURLToPath(deliveryUrl))}, () => ({ ...actual, validateAssetUpload: async (...args) => {
      const mime = await validate(...args);
      if (++validations === 2) release();
      await bothValidating;
      return mime;
    } }));
    await import(${JSON.stringify(new URL("../../src/demo-server.ts", import.meta.url).href)});
  `;
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[name]) environment[name] = process.env[name]!;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "ignore", stderr: "pipe",
    env: { ...environment, NODE_ENV: "test", DEMO_HOST: "127.0.0.1", DEMO_PORT: String(port),
      DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", LOCAL_STANDALONE: "true", AUTH_ENABLED: "false", OA_LOGIN_ENABLED: "false",
      CREDITS_ENABLED: "false", ROLE_PORTALS_ENABLED: "false", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "" },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const first = "winner-body", second = "second-body";
    const reserved = await fetch(`${base}/api/assets/upload-request`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "immutable.txt", mimeType: "text/plain", byteSize: first.length }) });
    expect(reserved.status).toBe(201);
    const asset = await reserved.json();
    const upload = (body: string) => fetch(base + asset.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body });
    const results = await Promise.all([upload(first), upload(second)]);
    expect(results.map(result => result.status).sort()).toEqual([204, 404]);
    const winner = results[0]!.status === 204 ? first : second;
    expect(await (await fetch(`${base}/api/assets/${asset.assetId}/content`)).text()).toBe(winner);
    expect((await upload("third--body")).status).toBe(404);
    expect(await (await fetch(`${base}/api/assets/${asset.assetId}/content`)).text()).toBe(winner);
  } finally { child.kill(); await child.exited; }
}, 15_000);
