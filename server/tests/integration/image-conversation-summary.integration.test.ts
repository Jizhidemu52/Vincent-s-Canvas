import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db";
import { createImageConversation, submitImageConversationTurn, cancelImageConversationTurn } from "../../src/image-conversation-service";
import { refreshImageConversationSummary } from "../../src/image-conversation-summary";
import type { ConversationExecution } from "../../src/image-conversation-worker";
import { conversationEventSchema, imageObservationSchema, requestedStateSchema } from "../../../shared/image-conversation-schemas";
import { createConversationPostgres, conversationDatabaseMode } from "../helpers/conversation-postgres";
import { expectedRejection } from "../helpers/expected-rejection";

const integration = conversationDatabaseMode() ? describe : describe.skip;
integration("bounded attributed conversation summaries with real transaction fences", () => {
  let fixture: Awaited<ReturnType<typeof createConversationPostgres>>;
  beforeAll(async () => { fixture = await createConversationPostgres({ planner: true }); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
  async function execution(conversationId: string): Promise<ConversationExecution> {
    return { conversation: await row("SELECT * FROM image_conversations WHERE id=$1", [conversationId]),
      turn: await row("SELECT * FROM image_conversation_turns WHERE conversation_id=$1 AND state='planning'", [conversationId]) };
  }
  async function nextTurn(ownerId: string, conversationId: string) {
    const conversation = await row("SELECT * FROM image_conversations WHERE id=$1", [conversationId]);
    const accepted = await submitImageConversationTurn(fixture.db, ownerId, conversationId, { clientRequestId: randomUUID(), expectedStateRevision: Number(conversation.state_revision), text: "本轮新要求不应出现在更早摘要中" });
    await fixture.db.query("UPDATE image_conversation_turns SET state='planning',execution_epoch=1,planner_lease_token=$2,planner_lease_expires_at=now()+interval '1 minute' WHERE id=$1", [accepted.result.turnId, randomUUID()]);
    return execution(conversationId);
  }
  async function context(count: number) {
    const ownerId = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Summary fixture')", [ownerId, `summary-${ownerId}`]);
    const created = (await createImageConversation(fixture.db, ownerId, { clientRequestId: randomUUID(), entrypoint: "standalone" })).snapshot;
    for (let seq = 1; seq <= count; seq++) {
      const turnId = randomUUID();
      await fixture.db.query("INSERT INTO image_conversation_turns(id,conversation_id,owner_user_id,client_request_id,payload_hash,input_payload,accepted_revision,state,planner_status) VALUES($1,$2,$3,$4,$5,'{}',1,'completed','succeeded')", [turnId, created.id, ownerId, randomUUID(), "a".repeat(64)]);
      await fixture.db.query("INSERT INTO image_conversation_messages(id,conversation_id,turn_id,seq,role,kind,text) VALUES($1,$2,$3,$4,$5,'text',$6)", [randomUUID(), created.id, turnId, seq, seq % 2 ? "user" : "assistant", `${seq % 2 ? "用户原话" : "助手未采纳建议"}-${seq} ${"完整原文".repeat(seq === 1 ? 3000 : 1)}`]);
    }
    await fixture.db.query("UPDATE image_conversations SET last_message_seq=$2 WHERE id=$1", [created.id, count]);
    return { ownerId, conversationId: created.id, execution: await nextTurn(ownerId, created.id) };
  }
  const messages = (id: string) => fixture.db.query("SELECT row_to_json(m) value FROM image_conversation_messages m WHERE conversation_id=$1 ORDER BY seq", [id]);
  const summaryEvents = (id: string) => fixture.db.query("SELECT * FROM image_conversation_events WHERE conversation_id=$1 AND event_type='context_summary.updated' ORDER BY seq", [id]);

  test("only older messages are summarized with source attribution, while raw messages and revision stay unchanged", async () => {
    const current = await context(25), before = await messages(current.conversationId);
    const result = await refreshImageConversationSummary(fixture.db, current.execution);
    expect(result.updated).toBe(true); expect(result.throughSeq).toBe(6);
    const excerpts = JSON.parse(result.summary.text).excerpts;
    expect(excerpts.map((item: any) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(excerpts.map((item: any) => item.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    for (const item of excerpts) expect(item.sourceTurnId).toBe(before.rows[item.seq - 1]!.value.turn_id);
    expect(excerpts[0].omittedCharacters).toBeGreaterThan(0);
    expect(result.summary.text).not.toContain("本轮新要求");
    expect((await messages(current.conversationId)).rows).toEqual(before.rows);
    const after = await row("SELECT * FROM image_conversations WHERE id=$1", [current.conversationId]);
    expect(after.state_revision).toBe(current.execution.conversation.state_revision);
    expect(after.active_version_id).toBe(current.execution.conversation.active_version_id);
    const events = await summaryEvents(current.conversationId);
    expect(events.rows).toHaveLength(1);
    const event = events.rows[0];
    expect(conversationEventSchema.safeParse({ conversationId: current.conversationId, seq: Number(event.seq), turnId: current.execution.turn.id,
      type: event.event_type, payload: event.payload, createdAt: new Date(event.created_at).toISOString() }).success).toBe(true);
  });

  test.each([0, 19])("short %s-message histories are true no-ops after a live fence check", async count => {
    const current = await context(count), before = await row("SELECT row_to_json(c) value FROM image_conversations c WHERE id=$1", [current.conversationId]);
    expect(await refreshImageConversationSummary(fixture.db, current.execution)).toMatchObject({ updated: false, throughSeq: 0 });
    expect(await row("SELECT row_to_json(c) value FROM image_conversations c WHERE id=$1", [current.conversationId])).toEqual(before);
    expect((await summaryEvents(current.conversationId)).rows).toEqual([]);
    await fixture.db.query("UPDATE image_conversation_turns SET planner_lease_expires_at=now()-interval '1 second' WHERE id=$1", [current.execution.turn.id]);
    expect(await expectedRejection(refreshImageConversationSummary(fixture.db, current.execution))).toMatchObject({ code: "CONVERSATION_SUMMARY_STALE" });
  });

  test("one turn advances at most forty sources and concurrent replays cannot consume another increment", async () => {
    const current = await context(100);
    const results = await Promise.all([refreshImageConversationSummary(fixture.db, current.execution), refreshImageConversationSummary(fixture.db, current.execution)]);
    expect(results.map(result => result.updated).sort()).toEqual([false, true]);
    expect(results.map(result => result.throughSeq)).toEqual([40, 40]);
    expect(JSON.parse(results[0]!.summary.text).hasUnprocessedHistory).toBe(true);
    expect((await summaryEvents(current.conversationId)).rows).toHaveLength(1);
    await fixture.db.query("UPDATE image_conversation_turns SET state='completed',planner_lease_token=NULL,planner_lease_expires_at=NULL WHERE id=$1", [current.execution.turn.id]);
    const next = await nextTurn(current.ownerId, current.conversationId);
    const advanced = await refreshImageConversationSummary(fixture.db, next);
    expect(advanced.throughSeq).toBe(80);
    expect(JSON.parse(advanced.summary.text).hasUnprocessedHistory).toBe(true);
    expect(JSON.stringify(advanced.summary).length).toBeLessThanOrEqual(8000);
    expect((await summaryEvents(current.conversationId)).rows).toHaveLength(2);
  });

  (conversationDatabaseMode() === "postgres" ? test : test.skip)("independent PostgreSQL sessions serialize one summary increment without duplicate events", async () => {
    const current = await context(100);
    const first = await fixture.db.connect(), second = await fixture.db.connect();
    const databases = [first, second].map(client => ({ query: fixture.db.query.bind(fixture.db), connect: async () => ({
      query: client.query.bind(client), release: () => undefined,
    }) }) as unknown as Database);
    try {
      const sessions = await Promise.all([first.query("SELECT pg_backend_pid() AS pid"), second.query("SELECT pg_backend_pid() AS pid")]);
      expect(sessions[0]!.rows[0].pid).not.toBe(sessions[1]!.rows[0].pid);
      const results = await Promise.all(databases.map(db => refreshImageConversationSummary(db, current.execution)));
      expect(results.map(result => result.updated).sort()).toEqual([false, true]);
      expect(results.map(result => result.throughSeq)).toEqual([40, 40]);
      expect(results[0]!.summary).toEqual(results[1]!.summary);
      expect((await summaryEvents(current.conversationId)).rows).toHaveLength(1);
    } finally { first.release(); second.release(); }
  });

  test("summary compaction cannot rewrite active image requirements, observations or acceptance", async () => {
    const current = await context(25), assetId = randomUUID(), versionId = randomUUID();
    await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'source.png','image/png',1,'image','ready')", [assetId, current.ownerId, `summary/${assetId}`]);
    const requestedState = requestedStateSchema.parse({ schemaVersion: 1, goals: ["保留原针织衫"], constraints: [{ key: "buttons", text: "  保留七颗纽扣，不采纳助手的拉链提议。  ", source: "user", sourceTurnId: current.execution.turn.id }] });
    const observation = imageObservationSchema.parse({ source: "user", checkedAt: new Date().toISOString(), notes: ["尚未核验纽扣数量"] });
    await fixture.db.query("INSERT INTO image_conversation_versions(id,conversation_id,root_version_id,version_no,image_no,label,asset_id,source,requested_state,observation,acceptance) VALUES($1,$2,$1,1,1,'图 1',$3,'upload',$4,$5,'unreviewed')", [versionId, current.conversationId, assetId, JSON.stringify(requestedState), JSON.stringify(observation)]);
    await fixture.db.query("UPDATE image_conversations SET active_version_id=$2,last_image_no=1 WHERE id=$1", [current.conversationId, versionId]);
    await fixture.db.query("UPDATE image_conversation_turns SET input_active_version_id=$2 WHERE id=$1", [current.execution.turn.id, versionId]);
    current.execution = await execution(current.conversationId);
    const before = await row("SELECT row_to_json(v) value FROM image_conversation_versions v WHERE id=$1", [versionId]);
    const result = await refreshImageConversationSummary(fixture.db, current.execution);
    expect(result.updated).toBe(true);
    expect(await row("SELECT row_to_json(v) value FROM image_conversation_versions v WHERE id=$1", [versionId])).toEqual(before);
    expect(await row("SELECT active_version_id,state_revision FROM image_conversations WHERE id=$1", [current.conversationId])).toEqual({ active_version_id: versionId, state_revision: current.execution.conversation.state_revision });
  });

  test.each(["cancelled", "epoch", "token", "expired", "owner", "conversation"])("%s execution cannot persist a stale summary", async defect => {
    const current = await context(22);
    if (defect === "cancelled") await cancelImageConversationTurn(fixture.db, current.ownerId, current.conversationId, current.execution.turn.id, { expectedStateRevision: Number(current.execution.conversation.state_revision) });
    if (defect === "epoch") await fixture.db.query("UPDATE image_conversation_turns SET execution_epoch=execution_epoch+1 WHERE id=$1", [current.execution.turn.id]);
    if (defect === "token") await fixture.db.query("UPDATE image_conversation_turns SET planner_lease_token=$2 WHERE id=$1", [current.execution.turn.id, randomUUID()]);
    if (defect === "expired") await fixture.db.query("UPDATE image_conversation_turns SET planner_lease_expires_at=now()-interval '1 second' WHERE id=$1", [current.execution.turn.id]);
    if (defect === "owner") current.execution.turn.owner_user_id = randomUUID();
    if (defect === "conversation") current.execution.turn.conversation_id = randomUUID();
    expect(await expectedRejection(refreshImageConversationSummary(fixture.db, current.execution))).toMatchObject({ code: "CONVERSATION_SUMMARY_STALE" });
    expect((await summaryEvents(current.conversationId)).rows).toEqual([]);
    expect(await row("SELECT context_summary_through_seq::int seq FROM image_conversations WHERE id=$1", [current.conversationId])).toEqual({ seq: 0 });
  });

  test("event persistence failure rolls the summary position and content back together", async () => {
    const current = await context(22);
    const wrapped = { query: fixture.db.query.bind(fixture.db), connect: async () => {
      const client = await fixture.db.connect();
      return { query: (sql: string, values?: unknown[]) => {
        if (sql.startsWith("INSERT INTO image_conversation_events") && values?.[3] === "context_summary.updated") throw new Error("fixture summary event failed");
        return client.query(sql, values);
      }, release: () => client.release() };
    } } as unknown as Database;
    expect(await expectedRejection(refreshImageConversationSummary(wrapped, current.execution))).toMatchObject({ message: "fixture summary event failed" });
    expect(await row("SELECT context_summary,context_summary_through_seq::int seq FROM image_conversations WHERE id=$1", [current.conversationId])).toEqual({ context_summary: { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] }, seq: 0 });
    expect((await summaryEvents(current.conversationId)).rows).toEqual([]);
    expect((await refreshImageConversationSummary(fixture.db, current.execution)).updated).toBe(true);
  });

  (conversationDatabaseMode() === "postgres" ? test : test.skip)("lease expiry after event insertion rolls back both the summary and event using wall-clock time", async () => {
    const current = await context(22);
    const before = await row("SELECT row_to_json(c) value FROM image_conversations c WHERE id=$1", [current.conversationId]);
    let insertedEvent = false;
    await fixture.db.query("UPDATE image_conversation_turns SET planner_lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [current.execution.turn.id]);
    const wrapped = { query: fixture.db.query.bind(fixture.db), connect: async () => {
      const client = await fixture.db.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql.startsWith("INSERT INTO image_conversation_events") && values?.[3] === "context_summary.updated") {
          insertedEvent = true;
          await client.query("SELECT pg_sleep(1.1)");
        }
        return result;
      }, release: () => client.release() };
    } } as unknown as Database;
    expect(await expectedRejection(refreshImageConversationSummary(wrapped, current.execution))).toMatchObject({ code: "CONVERSATION_SUMMARY_STALE" });
    expect(insertedEvent).toBe(true);
    expect(await row("SELECT row_to_json(c) value FROM image_conversations c WHERE id=$1", [current.conversationId])).toEqual(before);
    expect((await summaryEvents(current.conversationId)).rows).toEqual([]);
  });
});
