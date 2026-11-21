import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { withTransaction } from "../../src/db-transaction";
import { buildImageConversationContext, type ImageConversationContextOptions } from "../../src/image-conversation-context";
import { prepareImageConversationPlannerProfile } from "../../src/image-conversation-planner";
import { createImageConversation, getImageConversation, submitImageConversationTurn } from "../../src/image-conversation-service";
import {
  appendConversationMessage, readConversation, registerUploadedVersion, type ConversationRow, type TurnRow,
} from "../../src/image-conversation-store";
import { probeMediaBytes } from "../../src/media-probe";
import { createConversationPostgres as createIsolatedPostgres, conversationDatabaseMode } from "../helpers/conversation-postgres";
import { expectedRejection } from "../helpers/expected-rejection";

const integration = conversationDatabaseMode() ? describe : describe.skip;
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGP89eHZfzZBGYYof5eTyyrkfgAASSYH7r6GSqYAAAAASUVORK5CYII=", "base64");
const options: ImageConversationContextOptions = { readAsset: async () => image };

integration("owned, frozen and bounded conversation visual context", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeAll(async () => { fixture = await createIsolatedPostgres({ planner: true }); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  async function asset(ownerId: string) {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'source.png','image/png',$4,'image','ready')", [id, ownerId, `context/${id}`, image.byteLength]);
    return id;
  }
  async function context(upload = true) {
    const ownerId = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Context fixture')", [ownerId, `context-${ownerId}`]);
    const assetId = upload ? await asset(ownerId) : undefined;
    const conversation = (await createImageConversation(fixture.db, ownerId, { clientRequestId: randomUUID(), entrypoint: "standalone", ...(assetId ? { initialAssetId: assetId } : {}) })).snapshot;
    return { ownerId, conversationId: conversation.id, assetId, initialVersionId: conversation.activeVersionId };
  }
  async function stage(current: Awaited<ReturnType<typeof context>>, attachments: Array<{ assetId: string; purpose: "reference" | "new_base" | "auto" }> = [], text = "仅分析当前款式，附件只作配色参考。") {
    const conversation = await getImageConversation(fixture.db, current.ownerId, current.conversationId);
    const accepted = await submitImageConversationTurn(fixture.db, current.ownerId, current.conversationId, { clientRequestId: randomUUID(), expectedStateRevision: conversation.stateRevision, text, attachments });
    return { conversation: (await row("SELECT * FROM image_conversations WHERE id=$1", [current.conversationId])) as ConversationRow,
      turn: (await row("SELECT * FROM image_conversation_turns WHERE id=$1", [accepted.result.turnId])) as TurnRow };
  }
  async function root(current: Awaited<ReturnType<typeof context>>) {
    const assetId = await asset(current.ownerId);
    return withTransaction(fixture.db, async client => registerUploadedVersion(client, await readConversation(client, current.ownerId, current.conversationId, true), assetId));
  }
  async function generated(current: Awaited<ReturnType<typeof context>>, parentId: string, rootId: string, versionNo: number) {
    const id = randomUUID(), turnId = randomUUID(), assetId = await asset(current.ownerId);
    await fixture.db.query("INSERT INTO image_conversation_turns(id,conversation_id,owner_user_id,client_request_id,payload_hash,input_payload,accepted_revision,state,planner_status,intent) VALUES($1,$2,$3,$4,$5,'{}',1,'completed','succeeded','edit')", [turnId, current.conversationId, current.ownerId, randomUUID(), "a".repeat(64)]);
    const counter = await row("UPDATE image_conversations SET last_image_no=last_image_no+1,state_revision=state_revision+1 WHERE id=$1 RETURNING last_image_no", [current.conversationId]);
    await fixture.db.query("INSERT INTO image_conversation_versions(id,conversation_id,root_version_id,parent_version_id,version_no,image_no,label,asset_id,source,turn_id,parameters,requested_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'generated',$9,'{}',$10)",
      [id, current.conversationId, rootId, parentId, versionNo, counter.last_image_no, `图 ${counter.last_image_no} · V${versionNo}`, assetId, turnId,
        JSON.stringify({ schemaVersion: 1, goals: ["针织衫"], constraints: [{ key: `version-${versionNo}`, text: `完整保存第${versionNo}版要求`, source: "confirmed_plan", sourceTurnId: turnId }] })]);
    await fixture.db.query("UPDATE image_conversations SET active_version_id=$2 WHERE id=$1", [current.conversationId, id]);
    return { id, assetId };
  }
  async function history(current: Awaited<ReturnType<typeof context>>, text: string) {
    return withTransaction(fixture.db, async client => appendConversationMessage(client, await readConversation(client, current.ownerId, current.conversationId, true), { turnId: null, role: "assistant", kind: "text", text, attachments: [] }));
  }

  test("actual pixels use stable version/asset IDs, preserve the exact final instruction and do not adopt attachments", async () => {
    const current = await context(), reference = await asset(current.ownerId);
    const execution = await stage(current, [{ assetId: reference, purpose: "reference" }], "  按图分析\n原文末尾空格保留。  ");
    const reads: string[] = [];
    const result = await buildImageConversationContext(fixture.db, execution, { readAsset: async stored => {
      reads.push(stored.id);
      expect((await row("SELECT owner_user_id FROM assets WHERE id=$1", [stored.id])).owner_user_id).toBe(current.ownerId);
      return image;
    } });
    expect(reads).toEqual([current.assetId!, reference]);
    expect(result.context.inputActiveVersionId).toBe(current.initialVersionId);
    expect(result.manifest.attachments).toEqual([expect.objectContaining({ assetId: reference, purpose: "reference" })]);
    expect(result.manifest).toMatchObject({ baseVersionId: null, sourceStateVersionId: null, summaryThroughSeq: 0 });
    expect(result.manifest.images.filter(item => item.previewed).map(item => item.role)).toEqual(["current", "reference"]);
    expect(result.input.at(-1)).toEqual({ role: "user", content: execution.turn.input_payload.text });
    expect(result.context.currentUserText).toBe(execution.turn.input_payload.text);
    expect(result.input.every(item => "role" in item && (item.role === "user" || item.role === "assistant"))).toBe(true);
    const previews = result.input.flatMap(item => "role" in item && Array.isArray(item.content) ? item.content.filter(part => part.type === "input_image") : []);
    expect(previews).toHaveLength(2);
    expect(previews[0]!.image_url).toStartWith("data:image/webp;base64,");
    const preview = Buffer.from(previews[0]!.image_url.split(",")[1]!, "base64");
    expect(await probeMediaBytes(preview, "image/webp")).toMatchObject({ width: 4, height: 1 });
    expect(prepareImageConversationPlannerProfile(result.input, result.context).context).toEqual(result.context);
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).activeVersionId).toBe(current.initialVersionId);
    expect((await row("SELECT content_sha256 FROM assets WHERE id=$1", [current.assetId])).content_sha256).toBeNull();
  });

  test("current, explicit attachments, original and parent take preview priority over an unrelated latest upload", async () => {
    const current = await context(), rootId = current.initialVersionId!;
    const v2 = await generated(current, rootId, rootId, 2), v3 = await generated(current, v2.id, rootId, 3);
    const unrelated = await root(current), reference = await asset(current.ownerId);
    const execution = await stage(current, [{ assetId: reference, purpose: "reference" }]);
    const result = await buildImageConversationContext(fixture.db, execution, options);
    expect(result.context.requestedState.constraints[0]?.key).toBe("version-3");
    expect(result.manifest.images.filter(item => item.previewed).map(item => item.versionId).sort()).toEqual([rootId, v2.id, v3.id, result.manifest.attachments[0]!.versionId].sort());
    expect(result.manifest.images.find(item => item.versionId === unrelated.id)).toMatchObject({ previewed: false, role: "reference" });
    expect(result.context.versions.find(item => item.id === unrelated.id)?.previewed).toBe(false);
  });

  test("without an active version, references remain references and no latest-image fallback is selected", async () => {
    const current = await context(false), unrelated = await root(current), reference = await asset(current.ownerId);
    const execution = await stage(current, [{ assetId: reference, purpose: "new_base" }]);
    const result = await buildImageConversationContext(fixture.db, execution, options);
    expect(result.context.inputActiveVersionId).toBeNull();
    expect(result.context.requestedState).toEqual({ schemaVersion: 1, goals: [], constraints: [] });
    expect(result.manifest.images.filter(item => item.previewed).map(item => item.assetId)).toEqual([reference]);
    expect(result.manifest.images.find(item => item.versionId === unrelated.id)?.previewed).toBe(false);
    expect(result.manifest.attachments[0]?.purpose).toBe("new_base");
  });

  test("a history lookup adding a sixth mandatory image fails before I/O without dropping explicit references", async () => {
    const current = await context(), history = await root(current);
    const references = await Promise.all(Array.from({ length: 4 }, () => asset(current.ownerId)));
    const execution = await stage(current, references.map(assetId => ({ assetId, purpose: "reference" as const })));
    let reads = 0;
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, { lookup: { versionIds: [history.id], imageNos: [] }, readAsset: async () => { reads++; return image; } }))).toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
    expect(reads).toBe(0);
  });

  test.each(["foreign", "pending", "deleted", "wrong_kind"])("unavailable current assets (%s) never fall back to another ready image", async defect => {
    const current = await context(), execution = await stage(current);
    await root(current);
    if (defect === "foreign") await fixture.db.query("UPDATE assets SET owner_user_id=$2 WHERE id=$1", [current.assetId, (await context(false)).ownerId]);
    if (defect === "pending") await fixture.db.query("UPDATE assets SET status='pending' WHERE id=$1", [current.assetId]);
    if (defect === "deleted") await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [current.assetId]);
    if (defect === "wrong_kind") await fixture.db.query("UPDATE assets SET kind='video' WHERE id=$1", [current.assetId]);
    let reads = 0;
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, { readAsset: async () => { reads++; return image; } }))).toMatchObject({ code: "ASSET_NOT_READY" });
    expect(reads).toBe(0);
  });

  test("an asset-to-version mapping must come from the current turn's registered user message", async () => {
    const current = await context(), reference = await asset(current.ownerId);
    const execution = await stage(current, [{ assetId: reference, purpose: "reference" }]);
    await fixture.db.query("UPDATE image_conversation_messages SET attachments=$2 WHERE turn_id=$1 AND role='user'", [execution.turn.id, JSON.stringify([current.initialVersionId])]);
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, options))).toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
    const other = await context();
    await fixture.db.query("UPDATE image_conversation_messages SET attachments=$2 WHERE turn_id=$1 AND role='user'", [execution.turn.id, JSON.stringify([other.initialVersionId])]);
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, options))).toMatchObject({ code: "ASSET_NOT_READY" });
  });

  test("whole effective requested state is retained, while the catalog is bounded at forty with current version kept", async () => {
    const current = await context();
    const requirement = "必须保留全部七颗纽扣和针织纹理，不能把请求当作实际验收。".repeat(120);
    await fixture.db.query("UPDATE image_conversation_versions SET requested_state=$2 WHERE id=$1", [current.initialVersionId, JSON.stringify({ schemaVersion: 1, goals: ["针织衫"], constraints: [{ key: "all-details", text: requirement, source: "user", sourceTurnId: null }] })]);
    for (let index = 0; index < 43; index++) await root(current);
    const execution = await stage(current), result = await buildImageConversationContext(fixture.db, execution, options);
    expect(result.context.versions).toHaveLength(40);
    expect(result.context.versions.find(item => item.id === current.initialVersionId)?.requestedState.constraints[0]?.text).toBe(requirement);
    expect(result.context.requestedState.constraints[0]?.text).toBe(requirement);
    expect(result.manifest.images.filter(item => item.previewed)).toHaveLength(1);
    expect(result.manifest.images.filter(item => !item.previewed)).toHaveLength(39);
  });

  test("oversize current effective state fails rather than dropping or clipping constraints", async () => {
    const current = await context(), requirement = "完整要求".repeat(8_000);
    await fixture.db.query("UPDATE image_conversation_versions SET requested_state=$2 WHERE id=$1", [current.initialVersionId, JSON.stringify({ schemaVersion: 1, goals: [], constraints: [{ key: "full", text: requirement, source: "user", sourceTurnId: null }] })]);
    const execution = await stage(current);
    let reads = 0;
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, { readAsset: async () => { reads++; return image; } }))).toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
    expect(reads).toBe(0);
    expect((await row("SELECT requested_state FROM image_conversation_versions WHERE id=$1", [current.initialVersionId])).requested_state.constraints[0].text).toBe(requirement);
  });

  test("history is a recent ordered suffix, honors summary coverage and excludes messages after the accepted turn", async () => {
    const current = await context(false);
    for (let index = 1; index <= 25; index++) await history(current, `助手建议${index}，不是用户已采纳要求。`);
    await fixture.db.query("UPDATE image_conversations SET context_summary=$2,context_summary_through_seq=4 WHERE id=$1", [current.conversationId, JSON.stringify({ schemaVersion: 1, text: "较早建议摘要，尚未采纳。", goals: [], unresolvedQuestions: [] })]);
    const execution = await stage(current);
    await history(current, "在本轮受理之后到达的内容不应混入冻结上下文。" );
    const result = await buildImageConversationContext(fixture.db, execution, options);
    expect(result.manifest.summaryThroughSeq).toBe(4);
    expect(result.manifest.messageSeqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 7));
    expect(result.manifest.omittedHistory).toBe(true);
    expect(result.input[0]).toEqual({ role: "assistant", content: "助手建议7，不是用户已采纳要求。" });
    expect(JSON.stringify(result.input)).not.toContain("受理之后");
    expect(result.input.at(-1)).toEqual({ role: "user", content: execution.turn.input_payload.text });
  });

  test("read-only lookup retrieves an old image outside the recent catalogue without adopting it or losing the active pixels", async () => {
    const current = await context();
    const old = await root(current);
    for (let index = 0; index < 41; index++) await root(current);
    const execution = await stage(current, [], "比较图2与当前图，不生成。");
    const initial = await buildImageConversationContext(fixture.db, execution, options);
    expect(initial.context.versions.some(version => version.id === old.id)).toBe(false);
    const result = await buildImageConversationContext(fixture.db, execution, { ...options, lookup: { versionIds: [], imageNos: [2] } });
    expect(result.context.versions.find(version => version.id === old.id)).toMatchObject({ imageNo: 2, previewed: true });
    expect(result.manifest.images.find(version => version.versionId === current.initialVersionId)).toMatchObject({ previewed: true });
    expect(result.manifest.images.filter(version => version.previewed)).toHaveLength(2);
    expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).activeVersionId).toBe(current.initialVersionId);
    await result.validate();
  });

  test("lookup refuses other owners, missing versions and an oversized visual working set before pixel reads", async () => {
    const current = await context(), foreign = await context(), old = await root(current);
    const references = await Promise.all(Array.from({ length: 4 }, () => asset(current.ownerId)));
    const execution = await stage(current, references.map(assetId => ({ assetId, purpose: "reference" })));
    let reads = 0;
    for (const lookup of [{ versionIds: [foreign.initialVersionId!], imageNos: [] }, { versionIds: [], imageNos: [999] }, { versionIds: [old.id], imageNos: [] }]) {
      const error = await expectedRejection(buildImageConversationContext(fixture.db, execution, { lookup, readAsset: async () => { reads++; return image; } }));
      expect(error).toHaveProperty("code", lookup.versionIds[0] === old.id ? "PLANNER_CONTEXT_INVALID" : "ASSET_NOT_READY");
    }
    expect(reads).toBe(0);
  });

  test("an expired planner lease cannot read more historical pixels even before a recovery worker advances its epoch", async () => {
    const current = await context(), execution = await stage(current);
    const token = randomUUID();
    execution.turn = await row("UPDATE image_conversation_turns SET state='planning',planner_lease_token=$2,planner_lease_expires_at=now()-interval '1 second' WHERE id=$1 RETURNING *", [execution.turn.id, token]);
    let reads = 0;
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, { lookup: { versionIds: [current.initialVersionId!], imageNos: [] }, readAsset: async () => { reads++; return image; } }))).toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
    expect(reads).toBe(0);
  });

  test("text budgets omit older messages explicitly without changing the exact current instruction", async () => {
    const current = await context(false);
    for (let index = 0; index < 8; index++) await history(current, `${index}：${"历史原文".repeat(3_000)}`);
    const execution = await stage(current, [], "最终用户原文"), result = await buildImageConversationContext(fixture.db, execution, options);
    const textLength = result.input.reduce((sum, item) => sum + ("role" in item && typeof item.content === "string" ? item.content.length : 0), 0);
    expect(textLength).toBeLessThanOrEqual(48_000 + execution.turn.input_payload.text.length);
    expect(JSON.stringify(result.context).length + textLength).toBeLessThanOrEqual(60_000);
    expect(result.manifest.omittedHistory).toBe(true);
    expect(result.manifest.messageSeqs.at(-1)).toBe(9);
    expect(result.input.at(-1)).toEqual({ role: "user", content: "最终用户原文" });
  });

  test("asset ownership and content identity are rechecked after I/O and immediately before use", async () => {
    const current = await context(), execution = await stage(current);
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, { readAsset: async () => {
      await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [current.assetId]);
      return image;
    } }))).toMatchObject({ code: "ASSET_NOT_READY" });
    await fixture.db.query("UPDATE assets SET deleted_at=NULL WHERE id=$1", [current.assetId]);
    const result = await buildImageConversationContext(fixture.db, execution, options);
    await fixture.db.query("UPDATE assets SET content_sha256=$2 WHERE id=$1", [current.assetId, createHash("sha256").update("different original").digest("hex")]);
    expect(await expectedRejection(result.validate())).toMatchObject({ code: "ASSET_NOT_READY" });
  });

  test("production reads use only the owned object key and reject storage headers or bytes that no longer match", async () => {
    const current = await context(), execution = await stage(current);
    const keys: string[] = [];
    const storage = { get: async (key: string) => { keys.push(key); return { $metadata: {}, ETag: '"owned"', ContentLength: image.byteLength, ContentType: "image/png", Body: { transformToByteArray: async () => image } }; } } as unknown as NonNullable<ImageConversationContextOptions["storage"]>;
    expect((await buildImageConversationContext(fixture.db, execution, { storage })).manifest.images.filter(item => item.previewed)).toHaveLength(1);
    expect(keys).toEqual([`context/${current.assetId}`]);
    const invalid = { get: async () => ({ $metadata: {}, ContentLength: image.byteLength, ContentType: "image/png", Body: { transformToByteArray: async () => image } }) } as unknown as NonNullable<ImageConversationContextOptions["storage"]>;
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, { storage: invalid }))).toMatchObject({ code: "ASSET_NOT_READY" });
    expect(await expectedRejection(buildImageConversationContext(fixture.db, execution, { readAsset: async () => new Uint8Array(image.byteLength) }))).toMatchObject({ code: "ASSET_NOT_READY" });
  });
});
