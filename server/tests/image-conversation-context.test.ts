import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/db";
import { buildImageConversationContext } from "../src/image-conversation-context";
import { prepareImageConversationPlannerProfile } from "../src/image-conversation-planner";
import type { ConversationRow, MessageRow, TurnRow } from "../src/image-conversation-store";

function fixture(text = "  请先分析，不生成。\n保留这行原文。  ") {
  const ownerId = randomUUID(), conversationId = randomUUID(), turnId = randomUUID();
  const requestId = randomUUID(), createdAt = new Date();
  const conversation: ConversationRow = { id: conversationId, owner_user_id: ownerId, context_summary: { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] }, context_summary_through_seq: 0,
    title: null, entrypoint: "standalone", project_uuid: null, canvas_external_id: null, active_version_id: null,
    state_revision: 1, last_message_seq: 1, last_event_seq: 3, last_image_no: 0, create_request_id: randomUUID(), create_request_hash: "b".repeat(64), created_at: createdAt, updated_at: createdAt };
  const turn: TurnRow = { id: turnId, conversation_id: conversationId, owner_user_id: ownerId, input_active_version_id: null,
    accepted_revision: 1, execution_epoch: 0, task_id: null, state: "accepted", payload_hash: "a".repeat(64),
    input_payload: { schemaVersion: 1, clientRequestId: requestId, expectedStateRevision: 0, text, attachments: [], replyToTurnId: null, outputPreferences: { mode: "auto" } },
    client_request_id: requestId, base_version_id: null, output_version_id: null, reply_to_turn_id: null, intent: null,
    planner_status: "not_started", task_request_id: null, auto_activate: true, settings_snapshot: null, last_error: null,
    plan: null, context_manifest: null, planner_request_id: null, planner_dispatch_started_at: null, planner_lease_token: null,
    planner_lease_expires_at: null, created_at: createdAt, updated_at: createdAt };
  const message: MessageRow = { id: randomUUID(), conversation_id: conversationId, turn_id: turnId, seq: 1,
    role: "user", kind: "text", text, attachments: [], created_at: new Date() };
  const statements: string[] = [];
  const query = async (sql: string) => {
    statements.push(sql);
    const rows = sql.startsWith("SELECT * FROM image_conversations") ? [conversation]
      : sql.startsWith("SELECT * FROM image_conversation_turns") ? [turn]
        : sql.includes("role='user'") ? [message] : sql.includes("count(*) AS count") ? [{ count: "0" }] : [];
    return { rows, rowCount: rows.length };
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
  return { db, conversation, turn, message, statements };
}

describe("conversation context construction boundaries", () => {
  test("empty conversations preserve exact final user text and never promote user content into system instructions", async () => {
    const current = fixture();
    const result = await buildImageConversationContext(current.db, current);
    expect(result.input).toEqual([{ role: "user", content: current.turn.input_payload.text }]);
    expect(result.context.currentUserText).toBe(current.turn.input_payload.text);
    expect(result.context.requestedState).toEqual({ schemaVersion: 1, goals: [], constraints: [] });
    expect(result.manifest).toMatchObject({ messageSeqs: [1], images: [], attachments: [], baseVersionId: null, sourceStateVersionId: null, omittedHistory: false });
    const prepared = prepareImageConversationPlannerProfile(result.input, result.context);
    expect(prepared.input.input.at(-1)).toEqual({ role: "user", content: current.turn.input_payload.text });
    expect(current.statements.some(sql => /UPDATE|INSERT|DELETE/.test(sql))).toBe(false);
  });

  test("full mandatory context over budget fails before reading pixels instead of truncating source constraints", async () => {
    const current = fixture();
    current.conversation.context_summary.text = "完整摘要".repeat(15_000);
    let read = 0;
    await expect(buildImageConversationContext(current.db, current, { readAsset: async () => { read++; return new Uint8Array(); } })).rejects.toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
    expect(read).toBe(0);
    expect(current.conversation.context_summary.text).toHaveLength(60_000);
  });

  test("the revalidation hook detects stop fences and does not rerun any model", async () => {
    const current = fixture(), result = await buildImageConversationContext(current.db, current);
    current.turn.state = "cancelled";
    current.turn.execution_epoch = 1;
    await expect(result.validate()).rejects.toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
  });

  test("the persisted current user record must match accepted original text and role", async () => {
    const current = fixture();
    current.message.text = "silently changed";
    await expect(buildImageConversationContext(current.db, current)).rejects.toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
    current.message.text = current.turn.input_payload.text;
    current.message.role = "system" as MessageRow["role"];
    await expect(buildImageConversationContext(current.db, current)).rejects.toMatchObject({ code: "PLANNER_CONTEXT_INVALID" });
  });
});
