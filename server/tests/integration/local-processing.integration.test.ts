import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import type { LocalProcessingInput, LocalProcessingRecord } from "../../../shared/local-processing-contracts";
import { hashAssetContent } from "../../src/asset-content-hash";
import type { Database } from "../../src/db";
import type { ObjectStorage } from "../../src/object-storage";
import { createAssetsRouter } from "../../src/routes/assets";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { conversationDatabaseMode, createConversationPostgres } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? test : test.skip;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
const image = (label: string) => Buffer.concat([png, Buffer.from(label)]);
const recolor = (assetId: string, sourceAssetIds: string[], clientOperationId = randomUUID()): LocalProcessingInput => ({
  clientOperationId, assetId, board: "creative-pattern-colorway", operation: "recolor", prompt: "保持原图结构，红色换成蓝色",
  sourceAssetIds, parameters: { form: { description: "完整原始描述" }, config: { size: "1K" },
    recolor: { rules: [{ from: "#FF0000", to: "#0000FF" }], tolerance: 15 } },
});

async function harness() {
  const fixture = await createConversationPostgres();
  const owner = randomUUID(), other = randomUUID();
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'local-owner','Owner','designer'),($2,'local-other','Other','super_admin')", [owner, other]);
  const objects = new Map<string, Buffer>();
  const copies: string[] = [], removals: string[] = [], writes: string[] = [];
  let failCopy = false, uncertainCommit = false;
  const missing = () => Object.assign(new Error("Missing fixture object"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  const storage = {
    configured: true,
    put: async (key: string, body: Buffer) => { writes.push(key); objects.set(key, Buffer.from(body)); },
    head: async (key: string) => {
      const body = objects.get(key); if (!body) throw missing();
      return { ETag: `"${hashAssetContent(body)}"`, ContentLength: body.length, ContentType: "image/png", LastModified: new Date("2026-11-19T00:00:00Z") };
    },
    get: async (key: string, options: { range?: string } = {}) => {
      let body = objects.get(key); if (!body) throw missing();
      const etag = `"${hashAssetContent(body)}"`;
      const range = options.range?.match(/^bytes=(\d+)-(\d+)$/);
      if (range) body = body.subarray(Number(range[1]), Number(range[2]) + 1);
      return { Body: Readable.from([body]), ETag: etag, ContentLength: body.length, ContentType: "image/png" };
    },
    copy: async (source: string, destination: string, etag: string) => {
      const body = objects.get(source); if (!body) throw missing();
      if (etag !== `"${hashAssetContent(body)}"`) throw new Error("Wrong copy ETag");
      copies.push(destination); objects.set(destination, Buffer.from(body));
      if (failCopy) throw new Error("Copy response lost");
    },
    remove: async (key: string) => { removals.push(key); objects.delete(key); },
  } as unknown as ObjectStorage;
  const db = new Proxy(fixture.db, { get(target, property) {
    if (property === "connect") return async () => {
      const client = await target.connect();
      let archives = false;
      return new Proxy(client, { get(connection, key) {
        if (key === "query") return async (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes("INSERT INTO audit_logs")
            && (args[1] as unknown[] | undefined)?.includes("asset.local_processing_archived")) archives = true;
          const result = await Reflect.apply(connection.query, connection, args);
          if (args[0] === "COMMIT" && archives && uncertainCommit) { uncertainCommit = false; throw new Error("Commit response lost"); }
          return result;
        };
        const value = Reflect.get(connection, key); return typeof value === "function" ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } }) as Database;
  const app = express().use(express.json());
  app.use((request, _response, next) => {
    const id = request.header("x-test-owner") || owner;
    (request as AuthenticatedRequest).auth = { id, role: id === other ? "super_admin" : "designer", departmentId: null } as SessionUser;
    next();
  });
  app.use("/api/assets", createAssetsRouter(db, storage));
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) =>
    response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.name, message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/assets`;
  const request = (path: string, options: RequestInit = {}, actor = owner, expectedOwner = actor) => fetch(`${base}${path}`, {
    ...options, headers: { "content-type": "application/json", "x-test-owner": actor, "X-Canvas-Owner-Id": expectedOwner, ...options.headers },
  });
  const reserve = (body: Buffer, operationId?: string, actor = owner) => request("/upload-request", { method: "POST", body: JSON.stringify({
    filename: "result.png", mimeType: "image/png", byteSize: body.length, kind: "image", metadata: { contentSha256: hashAssetContent(body) },
    ...(operationId ? { localProcessingOperationId: operationId } : {}),
  }) }, actor);
  const upload = async (body: Buffer, operationId?: string, actor = owner) => {
    const response = await reserve(body, operationId, actor);
    expect(response.status).toBe(201);
    const result = await response.json() as { assetId: string; uploadUrl: string | null };
    if (result.uploadUrl) expect((await request(result.uploadUrl.replace("/api/assets", ""), { method: "PUT", body: new Blob([new Uint8Array(body)]), headers: { "content-type": "image/png" } }, actor)).status).toBe(204);
    return result.assetId;
  };
  const archive = (body: LocalProcessingInput, actor = owner, expectedOwner = actor) => request("/local-processing", { method: "POST", body: JSON.stringify(body) }, actor, expectedOwner);
  const list = (query = "", actor = owner) => request(`/local-processing?board=creative-pattern-colorway${query}`, {}, actor);
  const asset = async (id: string) => (await fixture.db.query("SELECT to_jsonb(a) AS value FROM assets a WHERE id=$1", [id])).rows[0]!.value as Record<string, unknown>;
  const protectedRows = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of ["users", "tasks", "generation_history", "credit_ledger", "usage_rollup_state"])
      rows[table] = (await fixture.db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return rows;
  };
  return { ...fixture, owner, other, objects, copies, removals, writes, request, reserve, upload, archive, list, asset, protectedRows,
    failCopy: () => { failCopy = true; }, uncertainCommit: () => { uncertainCommit = true; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await fixture.close(); },
  };
}

integration("dedicated result upload finalizes one immutable asset and is visible to a fresh same-owner client", async () => {
  const fixture = await harness();
  try {
    const sourceId = await fixture.upload(image("source"));
    const sourceBefore = await fixture.asset(sourceId), protectedBefore = await fixture.protectedRows();
    const operationId = randomUUID(), bytes = image("final-local-result");
    const outputId = await fixture.upload(bytes, operationId);
    const input = recolor(outputId, [sourceId], operationId);
    const response = await fixture.archive(input);
    expect(response.status).toBe(201);
    const saved = await response.json() as { record: LocalProcessingRecord; reused: boolean };
    expect(saved.reused).toBe(false);
    expect(saved.record).toMatchObject({ id: outputId, outputAssetId: outputId, sourceOutputAssetId: outputId, ownerUserId: fixture.owner,
      sourceTaskId: null, prompt: input.prompt, parameters: input.parameters, contentSha256: hashAssetContent(bytes) });
    const content = await fixture.request(`/${outputId}/content`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
    expect((await fixture.asset(outputId))).toMatchObject({ source: "import", task_id: null, model_config_id: null });
    const page = await (await fixture.list(`&clientOperationId=${operationId}`)).json();
    expect(page.records).toEqual([saved.record]);
    expect(page.hasMore).toBe(false);
    expect((await (await fixture.list("", fixture.other)).json()).records).toEqual([]);
    const repeats = await Promise.all(Array.from({ length: 4 }, () => fixture.archive(input)));
    expect(repeats.map(item => item.status)).toEqual([200, 200, 200, 200]);
    for (const repeated of repeats) expect((await repeated.json()).record.id).toBe(outputId);
    expect((await fixture.archive({ ...input, prompt: "不同操作不能覆盖" })).status).toBe(409);
    expect(await fixture.upload(bytes, operationId)).toBe(outputId);
    expect((await fixture.reserve(image("changed-result"), operationId)).status).toBe(409);
    expect((await fixture.db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='asset.local_processing_archived'")).rows[0]!.n).toBe(1);
    expect(fixture.copies).toEqual([]);
    expect(await fixture.asset(sourceId)).toEqual(sourceBefore);
    expect(await fixture.protectedRows()).toEqual(protectedBefore);
  } finally { await fixture.close(); }
}, 30_000);

integration("different operation IDs preserve identical output hashes without creating duplicate rows for retries", async () => {
  const fixture = await harness();
  try {
    const bytes = image("same-output"), source = await fixture.upload(bytes);
    const firstOperation = randomUUID(), secondOperation = randomUUID();
    const [first, second] = await Promise.all([fixture.upload(bytes, firstOperation), fixture.upload(bytes, secondOperation)]);
    expect(new Set([source, first, second]).size).toBe(3);
    const input1 = recolor(first, [source], firstOperation), input2 = recolor(second, [source], secondOperation);
    expect((await fixture.archive(input1)).status).toBe(201);
    expect((await fixture.archive(input2)).status).toBe(201);
    const page = await (await fixture.list()).json();
    expect(page.records).toHaveLength(2);
    expect(new Set(page.records.map((record: LocalProcessingRecord) => record.contentSha256)).size).toBe(1);
    const thirdOperation = randomUUID();
    const reservations = await Promise.all(Array.from({ length: 3 }, () => fixture.reserve(bytes, thirdOperation).then(response => response.json())));
    expect(new Set(reservations.map(item => item.assetId)).size).toBe(1);
    expect(fixture.copies).toHaveLength(0);
    expect((await fixture.db.query("SELECT count(*)::int AS n FROM assets")).rows[0]!.n).toBe(4);
  } finally { await fixture.close(); }
}, 30_000);

integration("ordinary reused output is copied into a separate record and never rewrites its original or AI accounting", async () => {
  const fixture = await harness();
  try {
    const bytes = image("existing-ai-output"), original = await fixture.upload(bytes);
    const task = randomUUID();
    await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,credits,rmb_cost,tool_key)
      VALUES($1,$2,$3,'existing-local-source','inpaint','success',9,0.75,'creative-local-restyle')`, [task, randomUUID(), fixture.owner]);
    await fixture.db.query("UPDATE assets SET task_id=$2,source='generation',prompt='Original AI prompt' WHERE id=$1", [original, task]);
    const before = await fixture.asset(original), protectedBefore = await fixture.protectedRows();
    const response = await fixture.archive(recolor(original, [original]));
    expect(response.status).toBe(201);
    const saved = (await response.json()).record as LocalProcessingRecord;
    expect(saved.id).not.toBe(original);
    expect(saved.sourceOutputAssetId).toBe(original);
    expect(fixture.copies).toHaveLength(1);
    expect((await fixture.asset(saved.id)).object_key).not.toBe(before.object_key);
    expect(await fixture.asset(original)).toEqual(before);
    expect(await fixture.protectedRows()).toEqual(protectedBefore);
    fixture.objects.delete(String(before.object_key));
    const content = await fixture.request(`/${saved.id}/content`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
  } finally { await fixture.close(); }
}, 30_000);

integration("archive ownership, employee headers, source readiness and reserved metadata cannot be forged", async () => {
  const fixture = await harness();
  try {
    const source = await fixture.upload(image("owner-source")), foreign = await fixture.upload(image("foreign-source"), undefined, fixture.other);
    const operation = randomUUID(), output = await fixture.upload(image("owned-output"), operation);
    const input = recolor(output, [source], operation);
    expect((await fixture.archive(input, fixture.other, fixture.owner)).status).toBe(403);
    expect((await fixture.archive(input, fixture.other)).status).toBe(404);
    expect((await fixture.archive({ ...input, sourceAssetIds: [foreign] })).status).toBe(404);
    expect((await fixture.archive({ ...input, assetId: foreign })).status).toBe(404);
    const pending = (await (await fixture.reserve(image("pending"), randomUUID())).json()).assetId;
    expect((await fixture.archive({ ...input, sourceAssetIds: [pending] })).status).toBe(404);
    await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [source]);
    expect((await fixture.archive(input)).status).toBe(404);
    await fixture.db.query("UPDATE assets SET deleted_at=NULL WHERE id=$1", [source]);
    const sourceKey = String((await fixture.asset(source)).object_key), sourceBytes = fixture.objects.get(sourceKey)!;
    fixture.objects.delete(sourceKey);
    expect((await fixture.archive(input)).status).toBe(404);
    fixture.objects.set(sourceKey, sourceBytes);
    for (const extra of [{ metadata: { localProcessing: { version: 1 } } }, { metadata: { localProcessingUpload: { version: 1 } } }, { clientReferenceId: `local-processing:${randomUUID()}` }]) {
      expect((await fixture.request("/upload-request", { method: "POST", body: JSON.stringify({ filename: "fake.png", kind: "image", mimeType: "image/png", byteSize: png.length, ...extra }) })).status).toBe(400);
    }
    await fixture.db.query("UPDATE assets SET metadata=jsonb_build_object('localProcessing',$2::jsonb),source='import' WHERE id=$1", [foreign, JSON.stringify({ version: 1, input: { ...input, board: "creative-pattern-colorway" }, payloadHash: "forged" })]);
    expect((await (await fixture.list("", fixture.other)).json()).records).toEqual([]);
    expect((await fixture.archive(input)).status).toBe(201);
    expect(fixture.copies).toHaveLength(0);
  } finally { await fixture.close(); }
}, 30_000);

integration("selection composites require the owner's successful matching task and its actual result asset", async () => {
  const fixture = await harness();
  try {
    const original = await fixture.upload(image("composite-original")), mask = await fixture.upload(image("composite-mask"));
    const raw = await fixture.upload(image("ai-raw")), otherRaw = await fixture.upload(image("other-ai-raw"));
    const task = randomUUID(), otherTask = randomUUID();
    await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,tool_key)
      VALUES($1::uuid,$1::text,$3,'composite','inpaint','success','creative-local-restyle'),($2::uuid,$2::text,$4,'foreign-composite','inpaint','success','creative-local-restyle')`,
    [task, otherTask, fixture.owner, fixture.other]);
    await fixture.db.query("UPDATE assets SET task_id=$2,source='generation' WHERE id=$1", [raw, task]);
    const operation = randomUUID(), output = await fixture.upload(image("strict-final-composite"), operation);
    const input: LocalProcessingInput = { clientOperationId: operation, assetId: output, board: "creative-local-restyle", operation: "selection-composite",
      prompt: "只修改选中区域", parameters: { selection: { sourceAssetId: original, maskAssetId: mask } }, sourceAssetIds: [original, mask, raw], sourceTaskId: task };
    const protectedBefore = await fixture.protectedRows(), rawBefore = await fixture.asset(raw);
    expect((await fixture.archive({ ...input, sourceTaskId: otherTask })).status).toBe(404);
    expect((await fixture.archive({ ...input, sourceAssetIds: [original, mask, otherRaw] })).status).toBe(404);
    await fixture.db.query("UPDATE tasks SET status='failed' WHERE id=$1", [task]);
    expect((await fixture.archive(input)).status).toBe(404);
    await fixture.db.query("UPDATE tasks SET status='success' WHERE id=$1", [task]);
    const response = await fixture.archive(input);
    expect(response.status).toBe(201);
    expect((await response.json()).record).toMatchObject({ sourceTaskId: task, outputAssetId: output, operation: "selection-composite" });
    expect((await (await fixture.list()).json()).records).toEqual([]);
    expect((await (await fixture.request("/local-processing?board=creative-local-restyle")).json()).records).toHaveLength(1);
    expect(await fixture.asset(raw)).toEqual(rawBefore);
    expect(await fixture.protectedRows()).toEqual(protectedBefore);
  } finally { await fixture.close(); }
}, 30_000);

integration("stable history pages retain every same-timestamp operation and ignore untrusted or other-board records", async () => {
  const fixture = await harness();
  try {
    const source = await fixture.upload(image("page-source"));
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const operation = randomUUID(), output = await fixture.upload(image("identical-page-output"), operation);
      expect((await fixture.archive(recolor(output, [source], operation))).status).toBe(201);
      ids.push(output);
    }
    await fixture.db.query("UPDATE assets SET created_at='2026-11-19T08:00:00.123456Z' WHERE id=ANY($1::uuid[])", [ids]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await fixture.list(`&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const page = await response.json();
      seen.push(...page.records.map((record: LocalProcessingRecord) => record.id)); cursor = page.nextCursor;
      expect(page.hasMore).toBe(Boolean(cursor));
    } while (cursor);
    expect(seen).toEqual(ids.sort().reverse());
    expect(new Set(seen).size).toBe(5);
    expect((await fixture.list("&limit=61")).status).toBe(400);
    expect((await fixture.list("&cursor=malformed")).status).toBe(400);
    const protectedBefore = await fixture.protectedRows();
    fixture.statements.length = 0;
    expect((await fixture.list()).status).toBe(200);
    expect(fixture.statements.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect(await fixture.protectedRows()).toEqual(protectedBefore);
  } finally { await fixture.close(); }
}, 30_000);

integration("copy failures clean only the newly owned output while lost commit responses remain recoverable without deletion or duplication", async () => {
  const failed = await harness();
  try {
    const original = await failed.upload(image("safe-original")), before = await failed.asset(original);
    failed.failCopy();
    expect((await failed.archive(recolor(original, [original]))).status).toBe(503);
    expect(failed.copies).toHaveLength(1);
    expect(failed.removals).toEqual(failed.copies);
    expect(failed.objects.has(String(before.object_key))).toBe(true);
    expect(await failed.asset(original)).toEqual(before);
    expect((await (await failed.list()).json()).records).toEqual([]);
  } finally { await failed.close(); }
  const uncertain = await harness();
  try {
    const original = await uncertain.upload(image("commit-source")), input = recolor(original, [original]);
    uncertain.uncertainCommit();
    expect((await uncertain.archive(input)).status).toBe(500);
    expect(uncertain.copies).toHaveLength(1);
    expect(uncertain.removals).toHaveLength(0);
    const page = await (await uncertain.list(`&clientOperationId=${input.clientOperationId}`)).json();
    expect(page.records).toHaveLength(1);
    expect((await uncertain.archive(input)).status).toBe(200);
    expect(uncertain.copies).toHaveLength(1);
    const content = await uncertain.request(`/${page.records[0].id}/content`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(image("commit-source"));
  } finally { await uncertain.close(); }
}, 30_000);
