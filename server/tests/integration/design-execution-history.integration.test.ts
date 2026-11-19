import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { designExecutionHistoryPageSchema } from "../../../shared/design-conversation-history";
import { createImageConversation, listDesignExecutionHistory, submitImageConversationTurn } from "../../src/image-conversation-service";
import { toPublicImageConversationData } from "../../src/image-conversation-public";
import { resolveEffectiveImageParameters } from "../../src/image-output-policy";
import { conversationDatabaseMode, createConversationPostgres } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? describe : describe.skip;
const secret = Buffer.alloc(32, 63).toString("base64");
integration("server design execution discovery", () => {
  let fixture: Awaited<ReturnType<typeof createConversationPostgres>>;
  const modelId = randomUUID();
  beforeAll(async () => {
    fixture = await createConversationPostgres();
    const providerId = randomUUID();
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Discovery fixture','apimart','https://no-network.invalid')", [providerId]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Discovery fixture','gpt-image-2.6-flare',ARRAY['generate','edit'])", [modelId, providerId]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  async function owner() {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Discovery fixture')", [id, `discovery-${id}`]);
    return id;
  }
  async function canvas(ownerId: string, externalId = randomUUID()) {
    await fixture.db.query("INSERT INTO canvas_documents(owner_user_id,external_id,revision,document) VALUES($1,$2,1,'{}')", [ownerId, externalId]);
    return externalId;
  }
  async function asset(ownerId: string) {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,kind,status) VALUES($1,$2,$3,'source.png','image/png','image','ready')", [id, ownerId, `discovery/${id}`]);
    return id;
  }
  async function execution(ownerId: string, canvasExternalId: string, submit = true, initialAssetId?: string) {
    const id = `design-image-${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const created = await createImageConversation(fixture.db, ownerId, { clientRequestId: `${id}:create`, entrypoint: "canvas", canvasExternalId,
      title: "保留原图结构的灰蓝方案", ...(initialAssetId ? { initialAssetId } : {}) });
    const turnRequest = { clientRequestId: `${id}:turn`, expectedStateRevision: created.snapshot.stateRevision, text: "保留七颗纽扣及针织纹理，只改变配色。", outputPreferences: { mode: "auto" as const } };
    const turn = submit ? await submitImageConversationTurn(fixture.db, ownerId, created.snapshot.id, turnRequest) : null;
    return { id, conversationId: created.snapshot.id, initialVersionId: created.snapshot.activeVersionId, turnId: turn?.result.turnId || null, turnRequest };
  }
  const list = async (ownerId: string, canvasExternalId: string, cursor?: string, limit = 30) =>
    designExecutionHistoryPageSchema.parse(toPublicImageConversationData(await listDesignExecutionHistory(fixture.db, ownerId, { canvasExternalId, cursor, limit }, secret)));

  test("one SELECT returns only owned matching-canvas design requests and the untouched accepted input", async () => {
    const user = await owner(), other = await owner(), project = await canvas(user), otherProject = await canvas(user), source = await asset(user);
    await canvas(other, project);
    const intended = await execution(user, project, true, source);
    await execution(user, otherProject); await execution(other, project);
    await createImageConversation(fixture.db, user, { clientRequestId: randomUUID(), entrypoint: "canvas", canvasExternalId: project });
    await createImageConversation(fixture.db, user, { clientRequestId: "design-image-not-a-hash:create", entrypoint: "canvas", canvasExternalId: project });
    await createImageConversation(fixture.db, user, { clientRequestId: `design-image-${"a".repeat(64)}:create`, entrypoint: "standalone" });
    const start = fixture.statements.length, page = await list(user, project);
    expect(fixture.statements.slice(start)).toHaveLength(1);
    expect(fixture.statements[start]!.trimStart().startsWith("SELECT")).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: intended.id, conversationId: intended.conversationId, canvasExternalId: project, initialAssetId: source,
      turnRequest: intended.turnRequest, turn: { id: intended.turnId, state: "accepted", taskId: null }, outputVersion: null });
    expect(JSON.stringify(page)).not.toMatch(/payload_hash|planner_lease|context_manifest|provider_encryption/i);
  });

  test("created but unsubmitted conversations remain visible without generating or inventing a turn", async () => {
    const user = await owner(), project = await canvas(user), source = await asset(user);
    const expected = await execution(user, project, false, source);
    const start = fixture.statements.length, page = await list(user, project);
    expect(page.items[0]).toMatchObject({ id: expected.id, initialAssetId: source, turn: null, turnRequest: null, outputVersion: null });
    expect(fixture.statements.slice(start)).toHaveLength(1);
    expect((await fixture.db.query("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [user])).rows[0].n).toBe(0);
  });

  test("microsecond pagination is complete and cursors are bound to owner, canvas and resource", async () => {
    const user = await owner(), project = await canvas(user), otherProject = await canvas(user), other = await owner();
    const records = [];
    for (let index = 0; index < 7; index++) {
      const current = await execution(user, project);
      await fixture.db.query("UPDATE image_conversations SET created_at=$2::timestamptz WHERE id=$1", [current.conversationId, `2026-11-19T08:00:00.00000${index % 3}Z`]);
      records.push(current);
    }
    const first = await list(user, project, undefined, 2), all = [...first.items];
    expect(first.nextCursor).toBeString();
    let cursor = first.nextCursor;
    while (cursor) { const next = await list(user, project, cursor, 2); all.push(...next.items); cursor = next.nextCursor; }
    expect(all.map(item => item.id).sort()).toEqual(records.map(item => item.id).sort());
    expect(new Set(all.map(item => item.id)).size).toBe(7);
    for (const [ownerId, canvasExternalId] of [[other, project], [user, otherProject]]) {
      await expect(list(ownerId!, canvasExternalId!, first.nextCursor!)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(list(user, project, "tampered")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("completed outputs retain exact asset/version identity and expose only public model settings", async () => {
    const user = await owner(), project = await canvas(user), current = await execution(user, project), outputId = randomUUID(), taskId = randomUUID(), resultAsset = await asset(user);
    const taskRequest = `history:${current.turnId}`;
    const settings = resolveEffectiveImageParameters({ action: "generate_new", intent: { purpose: "standard", complexity: "low" },
      binding: { modelConfigId: modelId, provider: "fixture", providerProtocol: "apimart", apiModelId: "gpt-image-2.6-flare", enabled: true },
      priceSnapshot: { modelId, quantity: 1, totalCredits: 8, totalRmb: 0.8, priceVersion: 1 } });
    await fixture.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,status,credits,rmb_cost) VALUES($1,$2,$3,$4,'image_generation',$5,'success',8,0.8)", [taskId, taskRequest, user, project, modelId]);
    await fixture.db.query("INSERT INTO image_conversation_versions(id,conversation_id,root_version_id,version_no,image_no,label,asset_id,source,turn_id,parameters,actual_dimensions) VALUES($1,$2,$1,1,1,'实际输出',$3,'generated',$4,$5,'{\"width\":256,\"height\":256}')",
      [outputId, current.conversationId, resultAsset, current.turnId, JSON.stringify(settings)]);
    await fixture.db.query("UPDATE image_conversation_turns SET state='completed',intent='generate_new',output_version_id=$2,task_id=$3,task_request_id=$4,settings_snapshot=$5 WHERE id=$1",
      [current.turnId, outputId, taskId, taskRequest, JSON.stringify(settings)]);
    const page = await list(user, project);
    expect(page.items[0]).toMatchObject({ turn: { taskId, outputVersionId: outputId }, outputVersion: { id: outputId, assetId: resultAsset,
      turnId: current.turnId, parameters: { policyVersion: "image-auto-v1", effective: { model: modelId } }, actualDimensions: { width: 256, height: 256 } } });
    expect(JSON.stringify(page)).not.toContain("gpt-image-2.6-flare");
    expect((await fixture.db.query("SELECT status,credits,rmb_cost::text FROM tasks WHERE id=$1", [taskId])).rows[0]).toMatchObject({ status: "success", credits: 8 });
  });

  test("deleted canvases disappear from discovery without deleting retained task and conversation data", async () => {
    const user = await owner(), project = await canvas(user), current = await execution(user, project);
    await fixture.db.query("UPDATE canvas_documents SET deleted=true,document=NULL WHERE owner_user_id=$1 AND external_id=$2", [user, project]);
    expect((await list(user, project)).items).toEqual([]);
    expect((await fixture.db.query("SELECT id FROM image_conversation_turns WHERE id=$1", [current.turnId])).rows[0].id).toBe(current.turnId);
  });
});
