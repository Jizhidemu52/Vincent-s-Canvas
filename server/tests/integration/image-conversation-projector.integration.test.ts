import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { ContextManifest, EditPlan, GenerateNewPlan } from "../../../shared/image-conversation-contracts";
import { conversationEventSchema, imageVersionSchema } from "../../../shared/image-conversation-schemas";
import type { Database } from "../../src/db";
import {
  projectImageConversationTask, projectPendingImageConversationTasks, type ImageConversationProjectorOptions,
} from "../../src/image-conversation-projector";
import { cancelImageConversationTurn, createImageConversation, getImageConversation, submitImageConversationTurn } from "../../src/image-conversation-service";
import { versionSnapshot, type VersionRow } from "../../src/image-conversation-store";
import { resolveEffectiveImageParameters } from "../../src/image-output-policy";
import { createConversationPostgres as createIsolatedPostgres, conversationDatabaseMode } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? describe : describe.skip;
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGP89eHZfzZBGYYof5eTyyrkfgAASSYH7r6GSqYAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(image).digest("hex");
const generation: GenerateNewPlan = { action: "generate_new", assistantText: "款式图已生成。", description: "纯色针织衫",
  requestedState: { schemaVersion: 1, goals: ["纯色针织衫"], constraints: [{ key: "color", text: "使用酒红色", source: "user", sourceTurnId: null }] },
  references: [], outputIntent: { purpose: "standard", complexity: "medium" } };
const edit = (base: string, stateSource: "base" | "active" = "base", target = "background"): EditPlan => ({ action: "edit", assistantText: "本轮修改已保存。",
  base: { kind: "version", versionId: base }, stateSource, changes: [{ kind: "set", target, instruction: `调整${target}` }], preserve: [], revoke: [], references: [], outputIntent: { purpose: "standard", complexity: "medium" } });

integration("idempotent conversation task result projection", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const modelId = randomUUID();
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    const providerId = randomUUID();
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Projector fixture','apimart','https://no-network.invalid')", [providerId]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Projector fixture','gpt-image-2.6-flare',ARRAY['generate','edit'])", [modelId, providerId]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows;
  const options: ImageConversationProjectorOptions = { readAsset: async () => image };
  async function asset(ownerId: string, taskId: string | null = null) {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,task_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,$4,'result.png','image/png',$5,'image','ready')", [id, ownerId, taskId, `test/${id}`, image.byteLength]);
    return id;
  }
  async function context(upload = false) {
    const ownerId = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Projector fixture')", [ownerId, `projector-${ownerId}`]);
    const initial = upload ? await asset(ownerId) : undefined;
    const conversation = (await createImageConversation(fixture.db, ownerId, { clientRequestId: randomUUID(), entrypoint: "standalone", ...(initial ? { initialAssetId: initial } : {}) })).snapshot;
    return { ownerId, conversationId: conversation.id, initialVersionId: conversation.activeVersionId };
  }
  async function stage(current: Awaited<ReturnType<typeof context>>, plan: GenerateNewPlan | EditPlan = generation, status = "success") {
    const conversation = await getImageConversation(fixture.db, current.ownerId, current.conversationId);
    const accepted = await submitImageConversationTurn(fixture.db, current.ownerId, current.conversationId, { clientRequestId: randomUUID(), expectedStateRevision: conversation.stateRevision, text: "仅完成本轮设计要求" });
    const turnId = accepted.result.turnId, taskId = randomUUID(), requestId = `ic:${turnId}:image:1`;
    const baseId = plan.action === "edit" && plan.base.kind === "version" ? plan.base.versionId : null;
    const manifest: ContextManifest = { schemaVersion: 1, summaryThroughSeq: 0, messageSeqs: [], inputActiveVersionId: conversation.activeVersionId,
      baseVersionId: baseId, sourceStateVersionId: plan.action === "edit" ? plan.stateSource === "active" ? conversation.activeVersionId : baseId : null,
      images: [], attachments: [], omittedHistory: false, policyVersion: "fixture-v1" };
    const settings = resolveEffectiveImageParameters({ action: plan.action, intent: plan.outputIntent,
      ...(baseId ? { base: { parameters: null, actualDimensions: { width: 4, height: 1 } } } : {}),
      binding: { modelConfigId: modelId, provider: "fixture", providerProtocol: "apimart", apiModelId: "gpt-image-2.6-flare", enabled: true },
      priceSnapshot: { modelId, quantity: 1, totalCredits: 8, totalRmb: 0.8, priceVersion: 1 } });
    await fixture.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,status,credits,rmb_cost,attempts) VALUES($1,$2,$3,'',$4,$5,$6,8,0.8,1)", [taskId, requestId, current.ownerId, plan.action === "edit" ? "inpaint" : "image_generation", modelId, status]);
    const assetId = await asset(current.ownerId, taskId);
    await fixture.db.query("UPDATE tasks SET result_urls=$2 WHERE id=$1", [taskId, JSON.stringify([`/api/assets/${assetId}/content`])]);
    await fixture.db.query("UPDATE image_conversation_turns SET state='queued',planner_status='succeeded',task_id=$2,task_request_id=$3,plan=$4,intent=$5,context_manifest=$6,settings_snapshot=$7,base_version_id=$8 WHERE id=$1",
      [turnId, taskId, requestId, JSON.stringify(plan), plan.action, JSON.stringify(manifest), JSON.stringify(settings), baseId]);
    return { ...current, turnId, taskId, assetId, acceptedRevision: accepted.result.stateRevision };
  }
  const version = async (turnId: string) => versionSnapshot((await row("SELECT * FROM image_conversation_versions WHERE turn_id=$1", [turnId])) as VersionRow);

  test("concurrent completion uses the task primary, persists decoded actuals and one atomic image/event set", async () => {
    const current = await stage(await context());
    await asset(current.ownerId, current.taskId);
    const originalTask = await row("SELECT * FROM tasks WHERE id=$1", [current.taskId]);
    const start = fixture.transactions.length;
    const results = await Promise.all(Array.from({ length: 3 }, () => projectImageConversationTask(fixture.db, current.taskId, { readAsset: async () => {
      expect((await row("SELECT status FROM tasks WHERE id=$1", [current.taskId])).status).toBe("success");
      return image;
    } })));
    const projectionTransactions = fixture.transactions.slice(start);
    expect(results.filter(result => result.status === "projected")).toHaveLength(1);
    expect(results.filter(result => result.status === "already_projected")).toHaveLength(2);
    const output = imageVersionSchema.parse(await version(current.turnId));
    expect(output).toMatchObject({ assetId: current.assetId, versionNo: 1, imageNo: 1, parentVersionId: null, rootVersionId: output.id,
      observation: null, acceptance: "unreviewed", actualDimensions: { width: 4, height: 1 },
      parameters: { actual: { quality: null, outputFormat: "png", mimeType: "image/png", providerActualRmb: null, usage: null } },
      requestedState: { constraints: [{ key: "color", source: "confirmed_plan", sourceTurnId: current.turnId }] } });
    expect(await row("SELECT content_sha256 FROM assets WHERE id=$1", [current.assetId])).toEqual({ content_sha256: sha256 });
    expect(await row("SELECT * FROM tasks WHERE id=$1", [current.taskId])).toEqual(originalTask);
    expect(await row("SELECT count(*)::int n FROM image_conversation_messages WHERE turn_id=$1 AND kind='image'", [current.turnId])).toEqual({ n: 1 });
    const events = await rows("SELECT * FROM image_conversation_events WHERE conversation_id=$1 ORDER BY seq", [current.conversationId]);
    for (const event of events) expect(conversationEventSchema.safeParse({ conversationId: event.conversation_id, turnId: event.turn_id, seq: Number(event.seq), type: event.event_type, payload: event.payload, createdAt: new Date(event.created_at).toISOString() }).success).toBe(true);
    expect(events.filter(event => event.event_type === "version.created")).toHaveLength(1);
    expect(events.filter(event => event.event_type === "turn.completed")).toHaveLength(1);
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId))).toMatchObject({ activeVersionId: output.id, stateRevision: current.acceptedRevision + 1, pendingTurn: null });
    expect(projectionTransactions.length).toBeGreaterThan(0);
    for (const statements of projectionTransactions) {
      const begin = statements.findIndex(sql => sql === "BEGIN");
      expect(begin).toBe(0);
      expect(statements.slice(begin + 1, begin + 5).join("\n")).toMatch(/pg_advisory_xact_lock[\s\S]*image_conversations[\s\S]*image_conversation_turns[\s\S]*FROM tasks/);
    }
  });

  test("branch edits keep a stable root and monotonic version numbers while freezing source state", async () => {
    const current = await context(true), root = current.initialVersionId!;
    const first = await stage(current, edit(root, "base", "color"));
    await projectImageConversationTask(fixture.db, first.taskId, options);
    const v2 = await version(first.turnId);
    const second = await stage(current, edit(root, "active", "background"));
    const projected = await projectImageConversationTask(fixture.db, second.taskId, { readAsset: async () => {
      await fixture.db.query("UPDATE image_conversations SET active_version_id=$2,state_revision=state_revision+1 WHERE id=$1", [current.conversationId, root]);
      return image;
    } });
    const v3 = await version(second.turnId);
    expect(v2).toMatchObject({ rootVersionId: root, parentVersionId: root, versionNo: 2, imageNo: 2 });
    expect(v3).toMatchObject({ rootVersionId: root, parentVersionId: root, versionNo: 3, imageNo: 3 });
    expect(v3.requestedState.constraints.map(item => item.key)).toEqual(["color", "background"]);
    expect(projected.activeChanged).toBe(false);
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).activeVersionId).toBe(root);
  });

  test("stopping during object I/O detaches permanently and retains the late result under the original turn", async () => {
    const current = await stage(await context());
    const projected = await projectImageConversationTask(fixture.db, current.taskId, { readAsset: async () => {
      await cancelImageConversationTurn(fixture.db, current.ownerId, current.conversationId, current.turnId, { expectedStateRevision: current.acceptedRevision });
      return image;
    } });
    expect(projected).toMatchObject({ status: "projected", activeChanged: false });
    expect(await row("SELECT state,auto_activate,output_version_id FROM image_conversation_turns WHERE id=$1", [current.turnId])).toEqual({ state: "detached", auto_activate: false, output_version_id: projected.versionId });
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId))).toMatchObject({ activeVersionId: null, pendingTurn: null });
    expect(await projectImageConversationTask(fixture.db, current.taskId)).toMatchObject({ status: "already_projected", versionId: projected.versionId });
  });

  test("automatic adoption independently requires the original active identity, expected revision and auto_activate", async () => {
    for (const guard of ["identity", "revision", "preference"]) {
      const current = await stage(await context(true), generation);
      expect(await projectImageConversationTask(fixture.db, current.taskId, { readAsset: async () => {
        if (guard === "identity") await fixture.db.query("UPDATE image_conversations SET active_version_id=NULL WHERE id=$1", [current.conversationId]);
        if (guard === "revision") await fixture.db.query("UPDATE image_conversations SET state_revision=state_revision+1 WHERE id=$1", [current.conversationId]);
        if (guard === "preference") await fixture.db.query("UPDATE image_conversation_turns SET auto_activate=false WHERE id=$1", [current.turnId]);
        return image;
      } })).toMatchObject({ status: "projected", activeChanged: false });
      expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).activeVersionId).toBe(guard === "identity" ? null : current.initialVersionId);
      expect((await row("SELECT state FROM image_conversation_turns WHERE id=$1", [current.turnId])).state).toBe("completed");
    }
  });

  test("declared exact pixels are checked against decoded content and never rewritten into fabricated actuals", async () => {
    const current = await stage(await context());
    const turn = await row("SELECT settings_snapshot FROM image_conversation_turns WHERE id=$1", [current.turnId]);
    const settings = turn.settings_snapshot;
    settings.intent.sizeMode = "exact_pixels";
    settings.effective.size = "1024x1024";
    delete settings.effective.resolution;
    delete settings.sourceMap.resolution;
    settings.resolutionApplied = false;
    await fixture.db.query("UPDATE image_conversation_turns SET settings_snapshot=$2 WHERE id=$1", [current.turnId, JSON.stringify(settings)]);
    expect(await projectImageConversationTask(fixture.db, current.taskId, options)).toMatchObject({ status: "deferred" });
    expect(await row("SELECT count(*)::int n FROM image_conversation_versions WHERE turn_id=$1", [current.turnId])).toEqual({ n: 0 });
    expect((await row("SELECT settings_snapshot FROM image_conversation_turns WHERE id=$1", [current.turnId])).settings_snapshot.actual).toBeNull();
  });

  test("production storage verifies owned object length, MIME and ETag before decoding", async () => {
    const current = await stage(await context());
    const calls: string[] = [];
    const storage = { get: async (key: string) => {
      calls.push(key);
      return { $metadata: {}, ETag: '"fixture-etag"', ContentLength: image.byteLength, ContentType: "image/png",
        Body: { transformToByteArray: async () => image } };
    } } as unknown as NonNullable<ImageConversationProjectorOptions["storage"]>;
    expect(await projectImageConversationTask(fixture.db, current.taskId, { storage })).toMatchObject({ status: "projected" });
    expect(calls).toEqual([`test/${current.assetId}`]);
    const invalid = await stage(await context());
    const unavailable = { get: async () => ({ $metadata: {}, ContentLength: image.byteLength, ContentType: "image/png", Body: { transformToByteArray: async () => image } }) } as unknown as NonNullable<ImageConversationProjectorOptions["storage"]>;
    expect(await projectImageConversationTask(fixture.db, invalid.taskId, { storage: unavailable })).toMatchObject({ status: "deferred" });
  });

  test.each(["foreign_owner", "other_task", "pending", "deleted", "video", "hash", "auxiliary", "ambiguous"])("rejects %s result identity without mutating task, fees or active", async defect => {
    const current = await stage(await context());
    if (defect === "foreign_owner") await fixture.db.query("UPDATE assets SET owner_user_id=$2 WHERE id=$1", [current.assetId, (await context()).ownerId]);
    if (defect === "other_task") await fixture.db.query("UPDATE assets SET task_id=$2 WHERE id=$1", [current.assetId, (await stage(await context())).taskId]);
    if (defect === "pending") await fixture.db.query("UPDATE assets SET status='pending' WHERE id=$1", [current.assetId]);
    if (defect === "deleted") await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [current.assetId]);
    if (defect === "video") await fixture.db.query("UPDATE assets SET kind='video' WHERE id=$1", [current.assetId]);
    if (defect === "hash") await fixture.db.query("UPDATE assets SET content_sha256=$2 WHERE id=$1", [current.assetId, "a".repeat(64)]);
    if (defect === "auxiliary") await fixture.db.query("UPDATE assets SET metadata=$2 WHERE id=$1", [current.assetId, JSON.stringify({ imageResult: { version: 1, role: "export", resultIndex: 0, original: { assetId: current.assetId, mimeType: "image/png", filename: "result.png" }, maskComposited: false } })]);
    if (defect === "ambiguous") await fixture.db.query("UPDATE tasks SET result_urls=$2 WHERE id=$1", [current.taskId, JSON.stringify([`/api/assets/${current.assetId}/content`, `/api/assets/${current.assetId}/content`])]);
    const original = await row("SELECT * FROM tasks WHERE id=$1", [current.taskId]);
    expect(await projectImageConversationTask(fixture.db, current.taskId, options)).toMatchObject({ status: "deferred" });
    expect(await row("SELECT state,last_error->>'code' code,output_version_id FROM image_conversation_turns WHERE id=$1", [current.turnId])).toEqual({ state: "uncertain", code: "RESULT_ARCHIVE_FAILED", output_version_id: null });
    expect(await row("SELECT * FROM tasks WHERE id=$1", [current.taskId])).toEqual(original);
    expect(await row("SELECT count(*)::int n FROM image_conversation_versions WHERE turn_id=$1", [current.turnId])).toEqual({ n: 0 });
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).activeVersionId).toBeNull();
    if (defect === "hash") expect((await row("SELECT content_sha256 FROM assets WHERE id=$1", [current.assetId])).content_sha256).toBe("a".repeat(64));
  });

  test("rejects truncated bytes despite valid MIME and a readable PNG header, then repairs the original task only", async () => {
    const current = await stage(await context());
    const broken = image.subarray(0, 70);
    await fixture.db.query("UPDATE assets SET byte_size=$2 WHERE id=$1", [current.assetId, broken.byteLength]);
    expect(await projectImageConversationTask(fixture.db, current.taskId, { readAsset: async () => broken })).toMatchObject({ status: "deferred" });
    expect((await row("SELECT content_sha256 FROM assets WHERE id=$1", [current.assetId])).content_sha256).toBeNull();
    await fixture.db.query("UPDATE assets SET byte_size=$2 WHERE id=$1", [current.assetId, image.byteLength]);
    expect(await projectImageConversationTask(fixture.db, current.taskId, options)).toMatchObject({ status: "projected", activeChanged: true });
    expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({ n: 1 });
  });

  test("missing storage stays recoverable without duplicate error messages and emits no synthetic completion", async () => {
    const current = await stage(await context());
    expect(await projectImageConversationTask(fixture.db, current.taskId)).toMatchObject({ status: "deferred" });
    const first = await rows("SELECT * FROM image_conversation_events WHERE turn_id=$1 ORDER BY seq", [current.turnId]);
    expect(await projectImageConversationTask(fixture.db, current.taskId)).toMatchObject({ status: "deferred" });
    expect(await rows("SELECT * FROM image_conversation_events WHERE turn_id=$1 ORDER BY seq", [current.turnId])).toEqual(first);
    expect(first.some(event => event.event_type === "turn.completed")).toBe(false);
    expect(await projectImageConversationTask(fixture.db, current.taskId, options)).toMatchObject({ status: "projected" });
  });

  test("rechecks asset and result identity after out-of-transaction reads", async () => {
    for (const change of ["object", "result"]) {
      const current = await stage(await context());
      expect(await projectImageConversationTask(fixture.db, current.taskId, { readAsset: async () => {
        if (change === "object") await fixture.db.query("UPDATE assets SET object_key=object_key||'-changed' WHERE id=$1", [current.assetId]);
        else {
          const other = await asset(current.ownerId, current.taskId);
          await fixture.db.query("UPDATE tasks SET result_urls=$2 WHERE id=$1", [current.taskId, JSON.stringify([`/api/assets/${other}/content`])]);
        }
        return image;
      } })).toMatchObject({ status: "deferred" });
      expect(await row("SELECT count(*)::int n FROM image_conversation_versions WHERE turn_id=$1", [current.turnId])).toEqual({ n: 0 });
      expect((await row("SELECT content_sha256 FROM assets WHERE id=$1", [current.assetId])).content_sha256).toBeNull();
    }
  });

  test("event failure rolls back image, active and verified hash before a safe projection retry", async () => {
    const current = await stage(await context());
    let fail = true;
    const wrapped = { query: fixture.db.query.bind(fixture.db), connect: async () => {
      const client = await fixture.db.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        if (fail && sql.startsWith("INSERT INTO image_conversation_events") && values?.[3] === "version.created") { fail = false; throw new Error("fixture event persistence unavailable"); }
        return client.query(sql, values);
      }, release: () => client.release() };
    } } as unknown as Database;
    expect(await projectImageConversationTask(wrapped, current.taskId, options)).toMatchObject({ status: "deferred" });
    expect(await row("SELECT count(*)::int n FROM image_conversation_versions WHERE turn_id=$1", [current.turnId])).toEqual({ n: 0 });
    expect((await row("SELECT content_sha256 FROM assets WHERE id=$1", [current.assetId])).content_sha256).toBeNull();
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).activeVersionId).toBeNull();
    expect(await projectImageConversationTask(fixture.db, current.taskId, options)).toMatchObject({ status: "projected" });
  });

  test("detached paused and failed tasks never reoccupy the slot; late reviewed success is historical", async () => {
    const current = await stage(await context(), generation, "processing");
    await cancelImageConversationTurn(fixture.db, current.ownerId, current.conversationId, current.turnId, { expectedStateRevision: current.acceptedRevision });
    const next = await submitImageConversationTurn(fixture.db, current.ownerId, current.conversationId, { clientRequestId: randomUUID(), expectedStateRevision: current.acceptedRevision + 1, text: "这是新的独立问题" });
    for (const status of ["paused", "failed"]) {
      await fixture.db.query("UPDATE tasks SET status=$2,failure_reason='fixture failure' WHERE id=$1", [current.taskId, status]);
      await projectImageConversationTask(fixture.db, current.taskId, options);
      expect((await row("SELECT state FROM image_conversation_turns WHERE id=$1", [current.turnId])).state).toBe("detached");
      expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).pendingTurn?.id).toBe(next.result.turnId);
    }
    await fixture.db.query("UPDATE tasks SET status='success',failure_reason=NULL WHERE id=$1", [current.taskId]);
    expect(await projectImageConversationTask(fixture.db, current.taskId, options)).toMatchObject({ status: "projected", activeChanged: false });
    expect((await row("SELECT state FROM image_conversation_turns WHERE id=$1", [current.turnId])).state).toBe("detached");
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId))).toMatchObject({ activeVersionId: null, pendingTurn: { id: next.result.turnId } });
  });

  test("recovery scans missed completion and progress, skips settled detached failures and isolates bad task bindings", async () => {
    const completed = await stage(await context()), running = await stage(await context(), generation, "processing");
    const corrupt = await stage(await context());
    await fixture.db.query("UPDATE tasks SET operation_type='video_generation' WHERE id=$1", [corrupt.taskId]);
    const errors: unknown[] = [];
    const results = await projectPendingImageConversationTasks(fixture.db, { ...options, onError: error => errors.push(error) });
    expect(results.some(result => result.status === "projected" && result.conversationId === completed.conversationId)).toBe(true);
    expect((await row("SELECT state FROM image_conversation_turns WHERE id=$1", [running.turnId])).state).toBe("generating");
    expect(errors.length).toBeGreaterThan(0);
    expect(await projectImageConversationTask(fixture.db, randomUUID(), options)).toEqual({ status: "ignored" });
  });

  test("a rejected binding does not starve later successful tasks in bounded recovery batches", async () => {
    const corrupt = await stage(await context()), completed = await stage(await context());
    await fixture.db.query("UPDATE tasks SET operation_type='video_generation' WHERE id=$1", [corrupt.taskId]);
    await fixture.db.query("UPDATE image_conversation_turns SET updated_at=now()-interval '2 years' WHERE id=$1", [corrupt.turnId]);
    await fixture.db.query("UPDATE image_conversation_turns SET updated_at=now()-interval '1 year' WHERE id=$1", [completed.turnId]);
    expect(await projectPendingImageConversationTasks(fixture.db, options, 1)).toEqual([{ status: "deferred" }]);
    expect(await projectPendingImageConversationTasks(fixture.db, options, 1)).toEqual([expect.objectContaining({ status: "projected", conversationId: completed.conversationId })]);
    await expect(projectPendingImageConversationTasks(fixture.db, options, Number.NaN)).rejects.toThrow("batch size");
  });
});
