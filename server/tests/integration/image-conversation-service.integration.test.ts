import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectedRejection } from "../helpers/expected-rejection";
import { randomUUID } from "node:crypto";
import { conversationSnapshotSchema } from "../../../shared/image-conversation-schemas";
import {
  cancelImageConversationTurn, createImageConversation, getImageConversation, getImageConversationTurn,
  listImageConversationMessages, listImageConversations, listImageConversationVersions, submitImageConversationTurn,
} from "../../src/image-conversation-service";
import { readConversationEvents } from "../../src/image-conversation-events";
import { createConversationPostgres as createIsolatedPostgres, conversationDatabaseMode } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? describe : describe.skip;
const secret = Buffer.alloc(32, 7).toString("base64");

integration("image conversation persistence and admission", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeAll(async () => { fixture = await createIsolatedPostgres(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  const owner = async () => {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Conversation fixture')", [id, `conversation-${id}`]);
    return id;
  };
  const asset = async (userId: string, status = "ready") => {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,kind,status) VALUES($1,$2,$3,'source.png','image/png','image',$4)", [id, userId, `test/${id}`, status]);
    return id;
  };
  const create = async (userId: string, initialAssetId?: string) => createImageConversation(fixture.db, userId, {
    clientRequestId: randomUUID(), entrypoint: "standalone", ...(initialAssetId ? { initialAssetId } : {}),
  });
  const input = (revision: number, extra = {}) => ({ clientRequestId: randomUUID(), expectedStateRevision: revision, text: "仅调整背景，保留产品。", ...extra });

  test("create atomically stores initial V1, active identity, messages and schema-valid replay events", async () => {
    const userId = await owner(), source = await asset(userId);
    const request = { clientRequestId: randomUUID(), entrypoint: "standalone", initialAssetId: source };
    const first = await createImageConversation(fixture.db, userId, request);
    expect(first.replayed).toBe(false);
    expect(conversationSnapshotSchema.parse(first.snapshot)).toMatchObject({ stateRevision: 1, latestEventSeq: 4, pendingTurn: null });
    expect(first.snapshot.activeVersion).toMatchObject({ assetId: source, versionNo: 1, imageNo: 1, source: "upload", actualDimensions: null });
    const replay = await createImageConversation(fixture.db, userId, request);
    expect(replay).toEqual({ ...first, replayed: true });
    const events = await readConversationEvents(fixture.db, userId, first.snapshot.id, 0);
    expect(events.events.map(event => event.type)).toEqual(["conversation.created", "version.created", "active.changed", "message.created"]);
    expect(events.events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
    expect((await row("SELECT count(*)::int n FROM image_conversation_versions WHERE conversation_id=$1", [first.snapshot.id])).n).toBe(1);
    expect(await expectedRejection(createImageConversation(fixture.db, userId, { ...request, title: "changed" }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("unready or foreign asset rolls creation back without orphan conversation, image or event", async () => {
    const userId = await owner(), foreignId = await owner();
    for (const initialAssetId of [await asset(userId, "pending"), await asset(foreignId), randomUUID()]) {
      expect(await expectedRejection(create(userId, initialAssetId))).toMatchObject({ code: "ASSET_NOT_READY" });
    }
    expect((await row("SELECT count(*)::int n FROM image_conversations WHERE owner_user_id=$1", [userId])).n).toBe(0);
  });

  test("accept persists normalized meaning before work, idempotency precedes stale revision and keeps one user message", async () => {
    const userId = await owner(), conversation = (await create(userId)).snapshot;
    const request = input(0);
    const first = await submitImageConversationTurn(fixture.db, userId, conversation.id, request);
    expect(first).toMatchObject({ replayed: false, result: { state: "accepted", stateRevision: 1 } });
    const replay = await submitImageConversationTurn(fixture.db, userId, conversation.id, { ...request, attachments: [], outputPreferences: { mode: "auto" } });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await row("SELECT input_payload,task_id,planner_status FROM image_conversation_turns WHERE id=$1", [first.result.turnId])).toMatchObject({
      input_payload: { text: request.text, schemaVersion: 1, attachments: [], replyToTurnId: null, outputPreferences: { mode: "auto" } }, task_id: null, planner_status: "not_started",
    });
    expect((await row("SELECT count(*)::int n FROM image_conversation_messages WHERE turn_id=$1 AND role='user'", [first.result.turnId])).n).toBe(1);
    expect(await expectedRejection(submitImageConversationTurn(fixture.db, userId, conversation.id, { ...request, text: "different" }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await expectedRejection(submitImageConversationTurn(fixture.db, userId, conversation.id, input(0)))).toMatchObject({ code: "CONVERSATION_REVISION_CONFLICT" });
    expect(await expectedRejection(submitImageConversationTurn(fixture.db, userId, conversation.id, input(1)))).toMatchObject({ code: "TURN_IN_PROGRESS" });
  });

  test("attachment roots do not replace active and repeated references publish one version.created event", async () => {
    const userId = await owner(), initial = await asset(userId), reference = await asset(userId);
    const conversation = (await create(userId, initial)).snapshot;
    const accepted = await submitImageConversationTurn(fixture.db, userId, conversation.id, input(1, {
      attachments: [{ assetId: reference, purpose: "reference" }, { assetId: reference, purpose: "reference" }],
    }));
    const latest = await getImageConversation(fixture.db, userId, conversation.id);
    expect(latest.activeVersionId).toBe(conversation.activeVersionId);
    expect(latest.pendingTurn?.inputActiveVersionId).toBe(conversation.activeVersionId);
    const versions = await listImageConversationVersions(fixture.db, userId, conversation.id, {}, secret);
    expect(versions.items.map(version => [version.imageNo, version.versionNo, version.assetId])).toEqual([[1, 1, initial], [2, 1, reference]]);
    const events = await readConversationEvents(fixture.db, userId, conversation.id, conversation.latestEventSeq);
    expect(events.events.filter(event => event.type === "version.created")).toHaveLength(1);
    expect(events.events.at(-1)).toMatchObject({ type: "turn.accepted", turnId: accepted.result.turnId });
  });

  test("cancel fences unstarted planner, is idempotent and permits another turn without adopting attachments", async () => {
    const userId = await owner(), conversation = (await create(userId)).snapshot;
    const first = await submitImageConversationTurn(fixture.db, userId, conversation.id, input(0));
    const cancelled = await cancelImageConversationTurn(fixture.db, userId, conversation.id, first.result.turnId, { expectedStateRevision: 1 });
    expect(cancelled).toMatchObject({ state: "cancelled", stateRevision: 2, disposition: "cancelled_before_submission" });
    expect(await row("SELECT execution_epoch::int epoch,auto_activate FROM image_conversation_turns WHERE id=$1", [first.result.turnId])).toEqual({ epoch: 1, auto_activate: false });
    expect(await cancelImageConversationTurn(fixture.db, userId, conversation.id, first.result.turnId, { expectedStateRevision: 1 })).toMatchObject({ stateRevision: 2, disposition: "already_terminal" });
    expect((await getImageConversation(fixture.db, userId, conversation.id)).pendingTurn).toBeNull();
    const next = await submitImageConversationTurn(fixture.db, userId, conversation.id, input(2));
    expect(next.result.stateRevision).toBe(3);
    expect((await readConversationEvents(fixture.db, userId, conversation.id, 0)).events.filter(event => event.type === "turn.cancelled")).toHaveLength(1);
  });

  test("owner isolation covers snapshots, turns, lists, SSE history, cancellation and uploaded assets", async () => {
    const userId = await owner(), stranger = await owner(), conversation = (await create(userId)).snapshot;
    const request = input(0), first = await submitImageConversationTurn(fixture.db, userId, conversation.id, request);
    for (const operation of [
      () => getImageConversation(fixture.db, stranger, conversation.id),
      () => getImageConversationTurn(fixture.db, stranger, conversation.id, { turnId: first.result.turnId }),
      () => listImageConversationMessages(fixture.db, stranger, conversation.id, {}, secret),
      () => listImageConversationVersions(fixture.db, stranger, conversation.id, {}, secret),
      () => readConversationEvents(fixture.db, stranger, conversation.id, 0),
      () => cancelImageConversationTurn(fixture.db, stranger, conversation.id, first.result.turnId, { expectedStateRevision: 1 }),
      () => submitImageConversationTurn(fixture.db, stranger, conversation.id, input(1)),
    ]) expect(await expectedRejection(operation())).toMatchObject({ code: "NOT_FOUND" });
    expect((await listImageConversations(fixture.db, stranger, {}, secret)).items).toHaveLength(0);
    const other = (await create(userId)).snapshot;
    expect(await expectedRejection(submitImageConversationTurn(fixture.db, userId, other.id, request))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("pagination keeps stable created order and rejects cursor changes and cross-owner reuse", async () => {
    const userId = await owner();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await create(userId)).snapshot.id);
    const first = await listImageConversations(fixture.db, userId, { limit: 2 }, secret);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeString();
    const last = await listImageConversations(fixture.db, userId, { limit: 2, cursor: first.nextCursor! }, secret);
    expect(new Set([...first.items, ...last.items].map(item => item.id))).toEqual(new Set(ids));
    expect(last.nextCursor).toBeNull();
    expect(await expectedRejection(listImageConversations(fixture.db, await owner(), { cursor: first.nextCursor! }, secret))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await expectedRejection(listImageConversations(fixture.db, userId, { cursor: `${first.nextCursor!}invalid` }, secret))).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("events reject future and expired cursors without pretending a gap is complete", async () => {
    const userId = await owner(), conversation = (await create(userId, await asset(userId))).snapshot;
    expect(await expectedRejection(readConversationEvents(fixture.db, userId, conversation.id, 5))).toMatchObject({ code: "VALIDATION_ERROR" });
    await fixture.db.query("DELETE FROM image_conversation_events WHERE conversation_id=$1 AND seq=2", [conversation.id]);
    expect(await expectedRejection(readConversationEvents(fixture.db, userId, conversation.id, 0))).toMatchObject({ code: "EVENT_CURSOR_EXPIRED", status: 410 });
    expect((await readConversationEvents(fixture.db, userId, conversation.id, 2)).events.map(event => event.seq)).toEqual([3, 4]);
  });
});
