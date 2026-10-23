import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { createClient } from "redis";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { taskResponseSchema } from "../../../shared/task-contracts";
import { hashToken } from "../../src/security";
import { startOaHttpsFixture } from "../helpers/oa-https-fixture";
import { verifyTaskHttpContract } from "../helpers/task-http-contract";

// Separate from RUN_INTEGRATION_TESTS: the password/auth=false suites must never
// accidentally run against this OA-only, genuinely production index.ts process.
const integration = process.env.RUN_OA_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const tag = randomUUID().replaceAll("-", "");
const schema = `oa_http_${tag}`;
const bucket = `oa-http-${tag}`;
const cookieName = `oa_http_${tag}`;
type Employee = { id: string; cookie: string; token: string; subject: string; assetId: string; taskId: string; historyId: string; requestId: string; content: string };

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the explicitly enabled OA integration test`);
  return value;
}
function localServiceUrl(value: string, allowed: string[], label: string) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]", ...allowed].includes(url.hostname)) {
    throw new Error(`${label} must target loopback or the isolated Compose test service`);
  }
  return url;
}
function sessionCookie(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(";", 1)[0]!)
    .find(value => value.startsWith(`${cookieName}=`) && value.length > cookieName.length + 1);
}

integration("formal OA HTTP: trusted TLS, two employees and cross-account isolation", () => {
  let control: Pool | undefined; let db: Pool | undefined; let cache: ReturnType<typeof createClient> | undefined;
  let schemaCreated = false, bucketCreated = false;
  let s3: S3Client | undefined;
  let oa: Awaited<ReturnType<typeof startOaHttpsFixture>> | undefined;
  let apiProcess: ReturnType<typeof Bun.spawn> | undefined;
  let stdout: Promise<string> | undefined, stderr: Promise<string> | undefined;
  let base: string;
  const employees: Employee[] = [];
  const modelId = randomUUID();
  const canvasId = `same-canvas-id-${tag}`;
  const api = async (path: string, employee?: Pick<Employee, "cookie" | "id">, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    if (employee) { headers.set("cookie", employee.cookie); headers.set("x-canvas-owner-id", employee.id); }
    if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(base + path, { ...options, headers, redirect: "manual" });
  };
  const json = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });
  const canvas = (employee: Employee) => ({
    id: canvasId, title: `Private canvas ${employee.id}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [{ id: "text-node", type: "text", title: "Private employee text", position: { x: 0, y: 0 }, width: 120, height: 120,
      metadata: { content: employee.content, assetId: employee.assetId } }], connections: [], chatSessions: [], activeChatId: null,
    backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 },
  });

  beforeAll(async () => {
    const databaseUrl = localServiceUrl(required("DATABASE_URL"), ["postgres"], "DATABASE_URL");
    const redisUrl = localServiceUrl(required("OA_TEST_REDIS_URL"), ["redis"], "OA_TEST_REDIS_URL");
    if (!/^\/([1-9]|1[0-5])$/.test(redisUrl.pathname)) throw new Error("OA_TEST_REDIS_URL must select a dedicated non-default Redis database, e.g. /14");
    const endpoint = localServiceUrl(required("S3_ENDPOINT"), ["minio"], "S3_ENDPOINT").toString();
    const accessKeyId = required("S3_ACCESS_KEY_ID"), secretAccessKey = required("S3_SECRET_ACCESS_KEY");
    cache = createClient({ url: redisUrl.toString(), socket: { connectTimeout: 5000, reconnectStrategy: false } });
    cache.on("error", () => undefined); await cache.connect();
    if (await cache.dbSize() !== 0) throw new Error("OA Redis fixture database is not empty; choose an unused database (nothing will be flushed)");
    control = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 5000 });
    await control.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await control.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
    await control.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    databaseUrl.searchParams.set("options", `-c search_path=${schema},public`);
    db = new Pool({ connectionString: databaseUrl.toString(), max: 4, connectionTimeoutMillis: 5000 });
    const migrations = join(import.meta.dir, "../../src/migrations");
    for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort()) await db.query(await readFile(join(migrations, file), "utf8"));
    s3 = new S3Client({ endpoint, region: process.env.S3_REGION ?? "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    await s3.send(new CreateBucketCommand({ Bucket: bucket })); bucketCreated = true;
    oa = await startOaHttpsFixture();
    const socket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = socket.port!; await socket.stop(true); base = `http://127.0.0.1:${port}`;
    apiProcess = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
      cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
      env: { ...oa.trustedEnvironment(), NODE_ENV: "production", PORT: String(port), DATABASE_URL: databaseUrl.toString(),
        REDIS_URL: redisUrl.toString(), AUTH_ENABLED: "false", OA_LOGIN_ENABLED: "true", OA_USERINFO_URL: oa.endpoint,
        CREDITS_ENABLED: "false", ROLE_PORTALS_ENABLED: "false", TRUST_PROXY: "false", SESSION_COOKIE_NAME: cookieName,
        S3_ENDPOINT: endpoint, S3_PUBLIC_ENDPOINT: "", S3_BUCKET: bucket, S3_REGION: process.env.S3_REGION ?? "us-east-1",
        S3_FORCE_PATH_STYLE: "true", S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey,
        PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString("base64"), TASK_MOCK_MODE: "false",
        WECOM_CORP_ID: "", WECOM_AGENT_ID: "", WECOM_SECRET: "", WECOM_CALLBACK_URL: "",
        OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", MARK_IMAGE_API_KEY: "" },
    });
    stdout = new Response(apiProcess.stdout as ReadableStream).text();
    stderr = new Response(apiProcess.stderr as ReadableStream).text();
    let healthy = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { healthy = true; break; }
      if (apiProcess.exitCode !== null) throw new Error(`OA production API exited early: ${(await stderr).slice(-6000)}`);
      await Bun.sleep(100);
    }
    expect(healthy).toBe(true);
    const deployment = await (await api("/api/deployment")).json();
    expect(deployment).toMatchObject({ oaLoginEnabled: true, authenticationEnabled: true, creditsEnabled: false });
    const provider = await db.query("INSERT INTO providers(name,protocol,base_url,enabled) VALUES('OA no-network fixture','custom','https://no-network.invalid',true) RETURNING id");
    await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,enabled) VALUES($1,$2,'OA fixture model','oa-fixture-model',ARRAY['generate'],0,0,true)", [modelId, provider.rows[0].id]);
    for (const [index, identity] of oa.employees.entries()) {
      const exchange = await api("/api/auth/oa/exchange", undefined, json({ token: identity.token, role: "super_admin", userId: "forged-client-identity" }));
      expect(exchange.status).toBe(200);
      expect(exchange.headers.get("cache-control")).toBe("no-store");
      const cookie = sessionCookie(exchange); expect(cookie).toBeDefined();
      const user = (await exchange.json()).user;
      expect(user).toMatchObject({ displayName: identity.name, role: "designer", mustChangePassword: false });
      expect((await db.query("SELECT is_guest FROM users WHERE id=$1", [user.id])).rows[0].is_guest).toBe(false);
      expect(exchange.headers.getSetCookie().some(value => value.includes("Secure") && value.includes("HttpOnly") && value.includes("SameSite=Lax"))).toBe(true);
      const employee: Employee = { id: user.id, cookie: cookie!, token: identity.token, subject: identity.subject,
        assetId: "", taskId: randomUUID(), historyId: randomUUID(), requestId: `oa-completed-${randomUUID()}`, content: `Private employee ${index + 1} payload ${tag}` };
      const upload = await api("/api/assets/upload-request", employee, json({ filename: `private-${index}.txt`, mimeType: "text/plain", kind: "text", byteSize: Buffer.byteLength(employee.content) }));
      expect(upload.status).toBe(201); const uploaded = await upload.json(); employee.assetId = uploaded.assetId;
      expect((await api(uploaded.uploadUrl, employee, { method: "PUT", headers: { "content-type": "text/plain" }, body: employee.content })).status).toBe(204);
      await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt,status,result_urls) VALUES($1,$2,$3,$4,'image_generation',$5,'success',$6)",
        [employee.taskId, employee.requestId, employee.id, canvasId, employee.content, JSON.stringify([`/api/assets/${employee.assetId}/content`])]);
      await db.query("INSERT INTO generation_history(id,task_id,user_id,project_id,operation_type,prompt,source_urls,result_urls,credits,rmb_cost,status) VALUES($1,$2,$3,$4,'image_generation',$5,'[]',$6,0,0,'success')",
        [employee.historyId, employee.taskId, employee.id, canvasId, employee.content, JSON.stringify([`/api/assets/${employee.assetId}/content`])]);
      expect((await api(`/api/canvas-documents/${canvasId}`, employee, json({ baseRevision: 0, document: canvas(employee) }, "PUT"))).status).toBe(200);
      employees.push(employee);
    }
  }, 60_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
    await cleanup(async () => {
      if (!apiProcess) return;
      if (apiProcess.exitCode === null) apiProcess.kill();
      await apiProcess.exited;
      const logs = (await stdout ?? "") + (await stderr ?? "");
      for (const employee of oa?.employees ?? []) expect(logs).not.toContain(employee.token);
    });
    await cleanup(async () => {
      if (!cache?.isOpen || !db || !schemaCreated) return;
      const [sessions, tasks] = await Promise.all([db.query("SELECT token_hash FROM sessions"), db.query("SELECT id FROM tasks")]);
      const hashes = sessions.rows.map(row => `session:${row.token_hash}`);
      if (hashes.length) await cache.del(hashes);
      const ids = tasks.rows.map(row => row.id as string);
      if (ids.length) { await cache.zRem("tasks:queue", ids); await cache.zRem("tasks:delayed", ids); await cache.hDel("tasks:delayed:priority", ids); }
      // This dedicated DB was verified empty before index.ts was started.
      await cache.del(["rate:oa-exchange:127.0.0.1", "rate:oa-exchange:::ffff:127.0.0.1", "rate:oa-exchange:::1"]);
    });
    await cleanup(async () => { if (cache?.isOpen) await cache.quit(); });
    await cleanup(async () => {
      if (!s3 || !bucketCreated) return;
      if (!/^oa-http-[0-9a-f]{32}$/.test(bucket)) throw new Error("Refusing to clean an unexpected OA fixture bucket");
      let token: string | undefined;
      do {
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        if (listed.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: listed.Contents.map(object => ({ Key: object.Key! })) } }));
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    });
    s3?.destroy();
    await cleanup(async () => { await db?.end(); });
    await cleanup(async () => {
      if (schemaCreated) {
        if (!/^oa_http_[0-9a-f]{32}$/.test(schema)) throw new Error("Refusing to clean an unexpected OA fixture schema");
        await control!.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    });
    await cleanup(async () => { await control?.end(); });
    await cleanup(async () => { await oa?.close(); });
    if (failures.length) throw new AggregateError(failures, "OA fixture cleanup failed");
  }, 30_000);

  test("same-name OA employees get distinct durable identities, Redis-backed sessions and no guest fallback", async () => {
    expect(employees[0]!.id).not.toBe(employees[1]!.id);
    for (const employee of employees) {
      const session = await api("/api/auth/session", employee); expect(session.status).toBe(200);
      expect((await session.json()).user).toMatchObject({ id: employee.id, role: "designer" });
      const sessionHash = hashToken(employee.cookie.slice(cookieName.length + 1));
      expect(await cache!.get(`session:${sessionHash}`)).toBeTruthy();
      const identity = await db!.query("SELECT user_id FROM external_identities WHERE provider='oa' AND subject=$1", [employee.subject]);
      expect(identity.rows[0].user_id).toBe(employee.id);
    }
    for (const path of ["/api/auth/session", "/api/tasks", "/api/history", "/api/assets", "/api/canvas-documents"]) {
      const missing = await api(path); expect(missing.status).toBe(401); expect(sessionCookie(missing)).toBeUndefined();
      const bad = await api(path, undefined, { headers: { cookie: `${cookieName}=invalid-session-token` } });
      expect(bad.status).toBe(401); expect(sessionCookie(bad)).toBeUndefined();
    }
    expect((await db!.query("SELECT count(*)::int AS count FROM users WHERE is_guest=true")).rows[0].count).toBe(0);
  });

  test("invalid replacement OA credentials revoke the old cookie without falling back to another employee or guest", async () => {
    const employee = employees[0]!;
    const replacement = await api("/api/auth/oa/exchange", undefined, json({ token: employee.token }));
    expect(replacement.status).toBe(200); expect((await replacement.json()).user.id).toBe(employee.id);
    const spare = { id: employee.id, cookie: sessionCookie(replacement)! };
    for (const token of [undefined, "bad-oa-token", "invalid token"]) {
      const bad = await api("/api/auth/oa/exchange", spare, json({ token }));
      expect(bad.status).toBe(401); expect(sessionCookie(bad)).toBeUndefined();
      expect((await bad.json()).error).toBe("OA_TOKEN_INVALID");
    }
    expect((await api("/api/auth/session", spare)).status).toBe(401);
    expect((await api("/api/auth/session", employee)).status).toBe(200);
    expect((await db!.query("SELECT count(*)::int AS count FROM users WHERE is_guest=true")).rows[0].count).toBe(0);
    expect(oa!.requests.some(request => !request.authorized)).toBe(true);
  });

  test("canvas identity namespaces, media content, task lookup and history remain employee-private", async () => {
    for (const [index, employee] of employees.entries()) {
      const other = employees[1 - index]!;
      const document = await api(`/api/canvas-documents/${canvasId}`, employee); expect(document.status).toBe(200);
      expect((await document.json()).document.document.title).toBe(`Private canvas ${employee.id}`);
      const staleOwner = await fetch(`${base}/api/canvas-documents/${canvasId}`, { headers: { cookie: employee.cookie, "x-canvas-owner-id": other.id } });
      expect(staleOwner.status).toBe(403);
      const foreignMedia = canvas(employee); foreignMedia.nodes[0]!.metadata.assetId = other.assetId;
      expect((await api(`/api/canvas-documents/${canvasId}`, employee, json({ baseRevision: 1, document: foreignMedia }, "PUT"))).status).toBe(403);
      const content = await api(`/api/assets/${employee.assetId}/content`, employee); expect(content.status).toBe(200);
      const etag = content.headers.get("etag"); expect(etag).toBeTruthy(); expect(await content.text()).toBe(employee.content);
      const otherContent = await api(`/api/assets/${other.assetId}/content`, other); expect(otherContent.status).toBe(200);
      const foreignEtag = otherContent.headers.get("etag"); expect(foreignEtag).toBeTruthy(); await otherContent.arrayBuffer();
      for (const path of [`/api/assets/${other.assetId}`, `/api/assets/${other.assetId}/content`, `/api/tasks/${other.taskId}`,
        `/api/tasks/by-request/${other.requestId}`, `/api/history/${other.historyId}`]) {
        const blocked = await api(path, employee, { headers: { "if-none-match": foreignEtag! } });
        expect(blocked.status).toBe(404); expect(await blocked.text()).not.toContain(other.content);
      }
      expect((await api(`/api/tasks/${other.taskId}/cancel`, employee, json({}))).status).toBe(404);
      for (const [path, key, ownerKey] of [["/api/tasks", "tasks", "userId"], ["/api/history", "history", "userId"], ["/api/assets", "assets", "ownerUserId"]]) {
        const response = await api(path!, employee); expect(response.status).toBe(200); const body = await response.json();
        expect(body[key!].length).toBeGreaterThan(0);
        expect(body[key!].every((item: Record<string, unknown>) => item[ownerKey!] === employee.id)).toBe(true);
        expect(JSON.stringify(body)).not.toContain(other.content);
      }
      const ownTask = await api(`/api/tasks/${employee.taskId}`, employee);
      expect(taskResponseSchema.parse(await ownTask.json()).task.id).toBe(employee.taskId);
      expect((await api(`/api/history/${employee.historyId}`, employee)).status).toBe(200);
      const ownCanvas = await api("/api/canvas-documents", employee);
      expect((await ownCanvas.json()).documents).toHaveLength(1);
    }
  });

  test("both OA employees receive 403 for all administrator reads including departments", async () => {
    for (const employee of employees) for (const path of ["/api/admin/departments", "/api/admin/accounts", "/api/admin/tasks", "/api/admin/history", "/api/admin/assets", "/api/admin/task-reconciliation"]) {
      const response = await api(path, employee); expect(response.status).toBe(403); expect((await response.json()).error).toBe("FORBIDDEN");
    }
  });

  test("the real OA-enabled index.ts accepts the shared task contract and rejects the same malformed cases", async () => {
    for (const employee of employees) {
      const requestId = `oa-contract-${randomUUID()}`;
      const result = await verifyTaskHttpContract({ base, headers: { cookie: employee.cookie, "x-canvas-owner-id": employee.id },
        submission: { requestId, projectId: canvasId, operationType: "image_generation", toolKey: "image", modelConfigId: modelId, prompt: "No provider is running", sourceUrls: [], userId: employees.find(other => other.id !== employee.id)!.id },
        expected: { requestId, status: "waiting" } });
      const reservation = await db!.query("SELECT user_id,status,credits FROM credit_reservations WHERE request_id=$1", [requestId]);
      expect(reservation.rows[0]).toMatchObject({ user_id: employee.id, status: "held", credits: 0 });
      expect((await db!.query("SELECT user_id FROM tasks WHERE id=$1", [result.id])).rows[0].user_id).toBe(employee.id);
    }
  });
});
