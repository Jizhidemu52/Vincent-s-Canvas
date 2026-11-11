import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { enqueueTask, transitionTask } from "../../src/tasks";
import type { Cache } from "../../src/db";
import type { ObjectStorage } from "../../src/object-storage";
import { createTasksRouter } from "../../src/routes/tasks";
import { preflightStoredSeedream55Task } from "../../src/stored-seedream55-preflight";
import { parseSeedream55Manifest, seedream55PublicDocument } from "../../src/seedream55-image";
import { storeSeedream55TaskResults } from "../../src/seedream55-worker-storage";
import { hashLayerOriginal } from "../../src/seedream55-storage";
import { settleLayerStudioReservation } from "../../src/layer-studio-billing";
import { withTransaction } from "../../src/db-transaction";
import { stepApiMartImageTask } from "../../src/apimart-image";
import { reconcileTask } from "../../src/task-reconciliation";
import type { SessionUser } from "../../src/types";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("layer workflow durable SQL and employee HTTP isolation", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>, base: string;
  const alice = randomUUID(), bob = randomUUID(), admin = randomUUID(), model = randomUUID(), source = randomUUID();
  const originals = new Map<string, Uint8Array>();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
  const storage = { configured: true,
    put: async (key: string, bytes: Uint8Array, _mime: string, options: { ifNoneMatch?: string }) => {
      if (options?.ifNoneMatch === "*" && originals.has(key)) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
      originals.set(key, Buffer.from(bytes));
    },
    get: async (key: string) => {
      const bytes = originals.get(key);
      if (!bytes) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
      return { Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } };
    },
  } as unknown as ObjectStorage;
  const cache = { eval: async () => 1, zRem: async () => 1 } as unknown as Cache;
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    for (const id of [alice, bob]) await fixture.db.query("INSERT INTO users(id,username,display_name,credit_balance) VALUES($1,$2,'Layer employee',100)", [id, `layer-${id}`]);
    await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Layer administrator','super_admin')", [admin, `layer-${admin}`]);
    const provider = randomUUID();
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Fixture','apimart','https://provider.invalid/v1')", [provider]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Fixture','seedream-5-5',ARRAY['generate','edit'],0,0)", [model, provider]);
    await fixture.db.query("UPDATE module_flags SET enabled=true WHERE module_key='layer-studio'");
    await fixture.db.query("UPDATE tool_api_configurations SET enabled=true,model_config_id=$1 WHERE tool_key='layer-studio'", [model]);
    await fixture.db.query("INSERT INTO layer_studio_prices(model_config_id,input_rmb,low_output_rmb,high_output_rmb,source_note) VALUES($1,0.1,0.2,0.3,'offline fixture only')", [model]);
    originals.set(`users/${alice}/source`, png);
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,source,status,content_sha256) VALUES($1,$2,$3,'source.png','image/png',$4,'image','upload','ready',$5)", [source, alice, `users/${alice}/source`, png.length, hashLayerOriginal(png)]);
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: request.get("x-user"), role: "designer", departmentId: null } }); next(); });
    app.use("/tasks", createTasksRouter(fixture.db, cache, false));
    app.use(((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(400).json({ message: error.message })) as express.ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/tasks`;
  }, 30_000);
  afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } await fixture?.close(); });

  test("valid generation admission is durable/idempotent; invalid n never reserves; employees cannot read another task", async () => {
    const requestId = randomUUID(), body = { requestId, projectId: "layer-fixture", operationType: "image_generation", toolKey: "layer-studio", prompt: "A textile motif", parameters: { size: "1K" }, sourceUrls: [] };
    const post = (value: unknown) => fetch(base, { method: "POST", headers: { "x-user": alice, "content-type": "application/json" }, body: JSON.stringify(value) });
    const first = await post(body); expect(first.status).toBe(201); const task = (await first.json() as any).task;
    expect((await post(body)).status).toBe(200);
    expect((await row("SELECT count(*)::int count FROM credit_reservations WHERE request_id=$1", [requestId])).count).toBe(1);
    expect((await row("SELECT price_snapshot FROM credit_reservations WHERE request_id=$1", [requestId])).price_snapshot.layerStudioCost).toMatchObject({ sourceCount: 0, maximumOutputs: 1, estimatedPrecharge: 0.2 });
    const invalidRequest = randomUUID(); expect((await post({ ...body, requestId: invalidRequest, parameters: { n: 100 } })).status).toBe(400);
    expect((await row("SELECT count(*)::int count FROM credit_reservations WHERE request_id=$1", [invalidRequest])).count).toBe(0);
    expect((await fetch(`${base}/${task.id}`, { headers: { "x-user": bob } })).status).toBe(404);
    expect((await fetch(`${base}/${task.id}`, { headers: { "x-user": alice } })).status).toBe(200);
  });

  test("100-layer partial save persists original bytes before restart, recovers same task and settles exactly once with actual dimensions", async () => {
    const requestId = randomUUID();
    const input = { requestId, userId: alice, departmentId: null, projectId: "layer-fixture", operationType: "image_generation", toolKey: "layer-studio", prompt: "", sourceUrls: [`/api/assets/${source}/content`], priority: "normal" as const, creditsEnabled: false, parameters: { layer_decomposition: true, size: "1K", layer_decomposition_options: { max_images: 100 } } };
    const task = await enqueueTask(fixture.db, cache, input, undefined, undefined,
      (db, value) => preflightStoredSeedream55Task(db, value, { readSource: async () => png }));
    const token = randomUUID();
    await fixture.db.query("UPDATE tasks SET status='processing',execution_token=$2,lease_expires_at=now()+interval '5 minutes' WHERE id=$1", [task.id, token]);
    let posts = 0;
    await stepApiMartImageTask({ modelId: "seedream-5-5", apiKey: "fixture", baseUrl: "https://provider.example/v1", prompt: "", parameters: input.parameters, sourceImages: [{ bytes: png, mimeType: "image/png" }],
      beforeSubmit: async () => { await fixture.db.query("UPDATE tasks SET upstream_submission_started_at=now() WHERE id=$1", [task.id]); },
      onSubmitted: async upstream => { await fixture.db.query("UPDATE tasks SET upstream_task_id=$2 WHERE id=$1", [task.id, upstream]); },
    }, { fetch: async () => { posts++; return Response.json({ data: [{ task_id: "fixture-original-upstream" }] }); } });
    const manifest = parseSeedream55Manifest({ data: { result: { images: [{ url: Array.from({ length: 100 }, (_, i) => `https://images.example/${i}.png`) }] } } }, true);
    const document = seedream55PublicDocument(task.id, manifest);
    await fixture.db.query("UPDATE tasks SET upstream_result_document=$2,result_document=$3 WHERE id=$1", [task.id, manifest, document]);
    const workerTask = { id: task.id, user_id: alice, department_id: null, project_id: "layer-fixture", model_config_id: model, prompt: "", execution_token: token, parameters: input.parameters };
    let failAt = 3, downloads = 0;
    const runtime = { download: async (url: string) => {
      downloads++; const index = Number(/\/(\d+)\.png$/.exec(url)![1]); if (index === failAt) throw new Error("injected partial download");
      const bytes = Buffer.concat([png, Buffer.from(`original-${index}`)]);
      return { bytes, mimeType: "image/png", width: index % 2 ? 2048 : 1000, height: index % 2 ? 1536 : 1000, sha256: hashLayerOriginal(bytes) };
    } };
    await expect(storeSeedream55TaskResults(fixture.db, storage, workerTask, manifest, document, runtime)).rejects.toThrow("injected");
    const partial = await row("SELECT result_document,upstream_result_document FROM tasks WHERE id=$1", [task.id]);
    expect(partial.result_document.status).toBe("partial"); expect(partial.result_document.items.filter((x: any) => x.state === "saved")).toHaveLength(3);
    expect((await row("SELECT count(*)::int count FROM assets WHERE task_id=$1", [task.id])).count).toBe(3);
    expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [requestId])).status).toBe("held");
    await fixture.db.query("UPDATE tasks SET status='paused',execution_token=NULL,lease_expires_at=NULL WHERE id=$1", [task.id]);
    const actor: SessionUser = { id: admin, username: `layer-${admin}`, displayName: "Layer administrator", role: "super_admin", status: "active", departmentId: null, departmentName: null,
      email: null, employeeNo: null, groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: false,
      creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0, creditPeriodStart: "2026-01-01", creditResetAt: "2026-02-01" };
    const decision = { decision: "confirmed_success" as const, reason: "Fixture original outputs verified", evidenceReference: "fixture:original-100-layers", actor };
    await expect(reconcileTask(fixture.db, cache, task.id, decision)).rejects.toThrow("未完整保存");
    expect(await transitionTask(fixture.db, cache, task.id, "resume")).not.toBeNull();
    const newToken = randomUUID(); await fixture.db.query("UPDATE tasks SET status='processing',execution_token=$2,lease_expires_at=now()+interval '5 minutes' WHERE id=$1", [task.id, newToken]);
    failAt = -1;
    const ready = await storeSeedream55TaskResults(fixture.db, storage, { ...workerTask, execution_token: newToken }, partial.upstream_result_document, partial.result_document, runtime);
    expect(ready.status).toBe("ready"); expect(posts).toBe(1); expect(downloads).toBe(101);
    expect((await row("SELECT count(*)::int count FROM assets WHERE task_id=$1", [task.id])).count).toBe(100);
    expect((await row("SELECT count(*)::int count FROM asset_events WHERE task_id=$1 AND event_type='asset.generated'", [task.id])).count).toBe(100);
    const corrupt = structuredClone(ready); corrupt.items[0]!.sha256 = "mismatched-result-hash";
    await fixture.db.query("UPDATE tasks SET status='paused',execution_token=NULL,lease_expires_at=NULL,result_document=$2 WHERE id=$1", [task.id, corrupt]);
    await expect(reconcileTask(fixture.db, cache, task.id, decision)).rejects.toThrow("hash");
    expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [requestId])).status).toBe("held");
    await fixture.db.query("UPDATE tasks SET result_document=$2 WHERE id=$1", [task.id, ready]);
    await reconcileTask(fixture.db, cache, task.id, decision);
    await reconcileTask(fixture.db, cache, task.id, decision);
    await withTransaction(fixture.db, client => settleLayerStudioReservation(fixture.db, requestId, ready.items.map(item => ({ width: item.width!, height: item.height! })), client));
    const cost = await row("SELECT status,rmb_cost::float8 cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [requestId]);
    expect(cost.status).toBe("captured"); expect(cost.cost).toBe(25.1); expect(cost.price_snapshot.layerStudioCost.actualOutputPixels).toHaveLength(100);
    const own = await (await fetch(`${base}/${task.id}`, { headers: { "x-user": alice } })).json() as any;
    expect(own.task.resultDocument.items).toHaveLength(100); expect(JSON.stringify(own)).not.toContain("https://images.example"); expect(JSON.stringify(own)).not.toContain("upstream_result_document");
    expect((await fetch(`${base}/${task.id}/recover`, { method: "POST", headers: { "x-user": bob, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    await expect(storeSeedream55TaskResults(fixture.db, storage, { ...workerTask, user_id: bob, execution_token: newToken }, manifest, ready, runtime)).rejects.toThrow();
  }, 30_000);
});
