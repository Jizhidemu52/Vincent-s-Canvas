import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { enqueueTask, type TaskInput } from "../../src/tasks";
import { preflightStoredSeedream55Task } from "../../src/stored-seedream55-preflight";
import { loadLayerStudioPriceSnapshot, settleLayerStudioReservation } from "../../src/layer-studio-billing";
import { resolveToolExecution } from "../../src/tool-configuration";
import { parseSeedream55Manifest, seedream55PublicDocument } from "../../src/seedream55-image";
import { storeSeedream55TaskResults } from "../../src/seedream55-worker-storage";
import { hashLayerOriginal } from "../../src/seedream55-storage";
import type { Cache } from "../../src/db";
import type { ObjectStorage } from "../../src/object-storage";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("ordinary Seedream admission, originals and immutable actual-size cost", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const user = randomUUID(), other = randomUUID(), model = randomUUID(), unpriced = randomUUID(), source = randomUUID();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
  const cache = { eval: async () => 1, zRem: async () => 1 } as unknown as Cache;
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  const input = (overrides: Partial<TaskInput> = {}): TaskInput => ({
    requestId: randomUUID(), userId: user, departmentId: null, projectId: "ordinary-seedream-fixture",
    operationType: "image_generation", toolKey: "image", modelConfigId: model, prompt: "A textile motif", parameters: { size: "1K" },
    sourceUrls: [], priority: "normal", creditsEnabled: false, ...overrides,
  });
  const enqueue = (value: TaskInput, readSource = async () => png) => enqueueTask(fixture.db, cache, value, undefined, undefined,
    (db, task) => preflightStoredSeedream55Task(db, task, { readSource }));
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    for (const id of [user, other]) await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Offline employee')", [id, `seedream-${id}`]);
    for (const id of [model, unpriced]) {
      const provider = randomUUID();
      await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,$2,'apimart','https://fixture.invalid/v1')", [provider, `Offline provider ${id}`]);
      await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Offline Seedream','seedream-5-5',ARRAY['generate','edit','batch'],0,0)", [id, provider]);
    }
    await fixture.db.query("UPDATE module_flags SET enabled=true WHERE module_key IN ('image','image-edit','canvas','creative')");
    await fixture.db.query("UPDATE tool_api_configurations SET enabled=true,model_config_id=NULL WHERE tool_key IN ('image','image-edit','canvas','canvas-image','canvas-batch','creative','creative-text-to-style')");
    await fixture.db.query("INSERT INTO layer_studio_prices(model_config_id,input_rmb,low_output_rmb,high_output_rmb,source_note) VALUES($1,0.1,0.2,0.3,'offline synthetic only')", [model]);
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,source,status,content_sha256) VALUES($1,$2,$3,'source.png','image/png',$4,'image','upload','ready',$5)", [source, user, `users/${user}/source`, png.length, hashLayerOriginal(png)]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  test("each ordinary surface admits one paid operation with real nonzero cost and preserves its tool and operation", async () => {
    for (const [toolKey, operationType] of [["image", "image_generation"], ["image-edit", "inpaint"], ["canvas-image", "image_generation"], ["creative-text-to-style", "image_generation"]]) {
      const value = input({ toolKey, operationType, sourceUrls: operationType === "inpaint" ? [`/api/assets/${source}/content`] : [] });
      const created = await enqueue(value);
      expect(created.status).toBe("waiting");
      const stored = await row("SELECT operation_type,tool_key,parameters FROM tasks WHERE id=$1", [created.id]);
      expect(stored).toMatchObject({ operation_type: operationType, tool_key: toolKey, parameters: { n: 1, count: 1, tool: toolKey } });
      const reservation = await row("SELECT rmb_cost::float8 cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [value.requestId]);
      expect(reservation.cost).toBe(operationType === "inpaint" ? 0.3 : 0.2);
      expect(reservation.price_snapshot).toMatchObject({ operationType, toolKey, layerStudioCost: { maximumOutputs: 1, prechargeBand: "low" } });
      const duplicate = await enqueue(value, async () => { throw new Error("Duplicate must not reload originals"); });
      expect(duplicate.id).toBe(created.id);
      expect((await row("SELECT count(*)::int n FROM credit_reservations WHERE request_id=$1", [value.requestId])).n).toBe(1);
    }
  });

  test("missing rates, foreign originals, eleven references and ordinary decomposition never reserve or enqueue", async () => {
    for (const value of [
      input({ modelConfigId: unpriced }), input({ userId: other, sourceUrls: [`/api/assets/${source}/content`] }),
      input({ sourceUrls: Array(11).fill(`/api/assets/${source}/content`) }),
      input({ parameters: { layer_decomposition: true }, sourceUrls: [`/api/assets/${source}/content`] }),
    ]) {
      await expect(enqueue(value)).rejects.toThrow();
      expect((await row("SELECT count(*)::int n FROM credit_reservations WHERE request_id=$1", [value.requestId])).n).toBe(0);
      expect((await row("SELECT count(*)::int n FROM tasks WHERE request_id=$1", [value.requestId])).n).toBe(0);
    }
  });

  test("trusted early preflight is reused without decoding twice but changed originals still fail before freezing", async () => {
    const value = input({ sourceUrls: [`/api/assets/${source}/content`] });
    const checked = await preflightStoredSeedream55Task(fixture.db, value, { readSource: async () => png });
    const created = await enqueue({ ...value, seedreamPreflightResult: checked }, async () => { throw new Error("Must not decode the same original twice"); });
    expect(created.status).toBe("waiting");
    await fixture.db.query("UPDATE assets SET object_key=$2 WHERE id=$1", [source, `users/${user}/replacement`]);
    const changed = { ...value, requestId: randomUUID(), seedreamPreflightResult: checked };
    try {
      await expect(enqueue(changed)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect((await row("SELECT count(*)::int n FROM credit_reservations WHERE request_id=$1", [changed.requestId])).n).toBe(0);
    } finally { await fixture.db.query("UPDATE assets SET object_key=$2 WHERE id=$1", [source, `users/${user}/source`]); }
  });

  test("each batch item stays n=1 while ten original references are supported", async () => {
    const batch = randomUUID();
    await fixture.db.query("INSERT INTO batch_tasks(id,request_id,user_id,project_id,operation_type,model_config_id,total_items) VALUES($1,$2,$3,'offline-batch','batch_image',$4,2)", [batch, randomUUID(), user, model]);
    for (let index = 0; index < 2; index++) {
      const value = input({ batchId: batch, toolKey: "canvas-batch", operationType: "batch_image", parameters: { size: "2K", n: 8, count: 8 }, sourceUrls: Array(10).fill(`/api/assets/${source}/content`) });
      const created = await enqueue(value);
      expect((await row("SELECT parameters FROM tasks WHERE id=$1", [created.id])).parameters).toMatchObject({ n: 1, count: 1 });
      expect((await row("SELECT rmb_cost::float8 cost FROM credit_reservations WHERE request_id=$1", [value.requestId])).cost).toBe(1.3);
    }
    expect((await row("SELECT count(*)::int n FROM tasks WHERE batch_id=$1", [batch])).n).toBe(2);
  });

  test("trusted batch snapshots keep original rates but recompute each item's references and output tier", async () => {
    const batch = randomUUID(), operationType = "batch_image", toolKey = "canvas-batch";
    await fixture.db.query("INSERT INTO batch_tasks(id,request_id,user_id,project_id,operation_type,model_config_id,total_items) VALUES($1,$2,$3,'offline-batch',$4,$5,2)", [batch, randomUUID(), user, operationType, model]);
    const execution = await resolveToolExecution(fixture.db, { operationType, toolKey, modelConfigId: model });
    const priceSnapshot = await loadLayerStudioPriceSnapshot(fixture.db, { operationType, modelConfigId: model, toolConfiguration: execution, parameters: { size: "1K" }, sourceCount: 0, creditsEnabled: false });
    await fixture.db.query("UPDATE layer_studio_prices SET low_output_rmb=8,high_output_rmb=9 WHERE model_config_id=$1", [model]);
    try {
      for (const [size, sourceCount, expected] of [["1K", 0, 0.2], ["2K", 2, 0.5]] as const) {
        const value = input({ operationType, toolKey, batchId: batch, toolConfiguration: execution, priceSnapshot, parameters: { size }, sourceUrls: Array(sourceCount).fill(`/api/assets/${source}/content`) });
        await enqueue(value);
        const stored = await row("SELECT rmb_cost::float8 cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [value.requestId]);
        expect(stored.cost).toBe(expected); expect(stored.price_snapshot.layerStudioCost.sourceCount).toBe(sourceCount);
        expect(stored.price_snapshot.layerStudioCost.lowOutputRmb).toBe(0.2);
      }
    } finally { await fixture.db.query("UPDATE layer_studio_prices SET low_output_rmb=0.2,high_output_rmb=0.3 WHERE model_config_id=$1", [model]); }
  });

  test("editing saves original-byte metadata as inpaint and settles actual size exactly once from the original rates", async () => {
    const value = input({ toolKey: "image-edit", operationType: "inpaint", parameters: { size: "2K" }, sourceUrls: [`/api/assets/${source}/content`] });
    const created = await enqueue(value), token = randomUUID();
    const manifest = parseSeedream55Manifest({ data: { result: { images: [{ url: ["https://fixture.invalid/result.png"] }] } } }, false);
    await fixture.db.query("UPDATE tasks SET status='processing',execution_token=$2,lease_expires_at=now()+interval '5 minutes',upstream_task_id='offline-original',upstream_result_document=$3 WHERE id=$1", [created.id, token, manifest]);
    const objects = new Map<string, Uint8Array>();
    const storage = { configured: true, put: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); },
      get: async (key: string) => ({ Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(objects.get(key)!); controller.close(); } }) } }),
    } as unknown as ObjectStorage;
    const task = { id: created.id, user_id: user, department_id: null, project_id: value.projectId, model_config_id: model, prompt: value.prompt, execution_token: token, operation_type: "inpaint", parameters: value.parameters! };
    let downloads = 0;
    const runtime = { download: async () => { downloads++; return { bytes: png, mimeType: "image/png", width: 1000, height: 1000, sha256: hashLayerOriginal(png) }; } };
    const saved = await storeSeedream55TaskResults(fixture.db, storage, task, manifest, seedream55PublicDocument(task.id, manifest), runtime);
    await storeSeedream55TaskResults(fixture.db, storage, task, manifest, saved, runtime);
    expect(downloads).toBe(1);
    expect(await row("SELECT operation_type,content_sha256 FROM assets WHERE task_id=$1", [created.id])).toEqual({ operation_type: "inpaint", content_sha256: hashLayerOriginal(png) });
    expect((await row("SELECT metadata FROM asset_events WHERE task_id=$1 AND event_type='asset.generated'", [created.id])).metadata.operationType).toBe("inpaint");
    await fixture.db.query("UPDATE layer_studio_prices SET low_output_rmb=8,high_output_rmb=9,version=version+1 WHERE model_config_id=$1", [model]);
    const outputs = saved.items.map(item => ({ width: item.width!, height: item.height! }));
    await settleLayerStudioReservation(fixture.db, value.requestId, outputs);
    await settleLayerStudioReservation(fixture.db, value.requestId, outputs);
    const reservation = await row("SELECT status,rmb_cost::float8 cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [value.requestId]);
    expect(reservation).toMatchObject({ status: "captured", cost: 0.3, price_snapshot: { operationType: "inpaint", settledQuantity: 1, layerStudioCost: { lowOutputRmb: 0.2, actualOutputPixels: [1000000] } } });
  });
});
