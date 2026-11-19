import { z } from "zod";
import type { ContextSummary } from "../../shared/image-conversation-contracts";
import { safeIntegerSchema, uuidSchema } from "../../shared/image-conversation-schemas";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { appendConversationEvent, readConversation, safeCounter, type ConversationRow, type MessageRow } from "./image-conversation-store";
import type { ConversationExecution } from "./image-conversation-worker";
import { lockTaskAdmission } from "./tasks";

export type ConversationSummaryMessage = Pick<MessageRow, "seq" | "turn_id" | "role" | "kind" | "text"> & { original_characters: number | string };
const summaryPolicy = "bounded-original-excerpts-v1";
const summaryNotice = "以下仅为带来源的历史原文摘录，不是完整记忆；助手建议或状态不代表用户采纳，也不代表图片验收。省略内容仍保存在原始消息中；当前有效设计要求独立保留在 requestedState。";
const excerptSchema = z.strictObject({
  seq: safeIntegerSchema.min(1), sourceTurnId: uuidSchema.nullable(), role: z.enum(["user", "assistant"]),
  kind: z.enum(["text", "image", "status"]), text: z.string().nullable(), omittedCharacters: safeIntegerSchema,
});
const summaryDocumentSchema = z.strictObject({
  policyVersion: z.literal(summaryPolicy), notice: z.string(), throughSeq: safeIntegerSchema,
  omittedMessages: safeIntegerSchema, priorSummaryOmitted: z.boolean(), hasUnprocessedHistory: z.boolean(),
  excerpts: z.array(excerptSchema).max(40),
});

export function compactConversationSummary(previous: ContextSummary, previousThroughSeq: number, messages: readonly ConversationSummaryMessage[], hasMore: boolean) {
  let throughSeq = safeCounter(previousThroughSeq);
  if (messages.length > 40) throw new Error("Conversation summary increment exceeds its bounded read");
  if (!messages.length) return { summary: previous, throughSeq };
  let prior: z.infer<typeof summaryDocumentSchema> | null = null;
  if (previous.text.length <= 8_000) {
    try {
      const parsed = summaryDocumentSchema.parse(JSON.parse(previous.text));
      if (parsed.throughSeq === previousThroughSeq && parsed.excerpts.every((entry, index) => entry.seq <= previousThroughSeq
        && (!index || entry.seq > parsed.excerpts[index - 1]!.seq))) prior = parsed;
    } catch { prior = null; }
  }
  const excerpts = [...(prior?.excerpts ?? [])];
  for (const message of messages) {
    const seq = safeCounter(message.seq), originalCharacters = safeCounter(message.original_characters);
    if (seq <= throughSeq) throw new Error("Conversation summary source order is invalid");
    const characters = message.text === null ? [] : Array.from(message.text);
    if (characters.length > originalCharacters) throw new Error("Conversation summary source length is invalid");
    const text = message.text === null ? null : characters.slice(0, 600).join("");
    excerpts.push(excerptSchema.parse({ seq, sourceTurnId: message.turn_id, role: message.role, kind: message.kind, text,
      omittedCharacters: originalCharacters - Math.min(characters.length, 600) }));
    throughSeq = seq;
  }
  const document = { policyVersion: summaryPolicy, notice: summaryNotice, throughSeq,
    omittedMessages: prior?.omittedMessages ?? 0,
    priorSummaryOmitted: prior?.priorSummaryOmitted ?? Boolean(previousThroughSeq || previous.text),
    hasUnprocessedHistory: hasMore, excerpts };
  const serialize = (): ContextSummary => ({ schemaVersion: 1, text: JSON.stringify(document), goals: [], unresolvedQuestions: [] });
  while (excerpts.length > 40 || JSON.stringify(serialize()).length > 8_000) {
    if (!excerpts.length) throw new Error("Conversation summary metadata exceeds its budget");
    excerpts.shift(); document.omittedMessages++;
  }
  return { summary: serialize(), throughSeq };
}

export class ImageConversationSummaryFenceError extends Error {
  readonly code = "CONVERSATION_SUMMARY_STALE";
  constructor() { super("本轮已取消、执行身份已变化或租约已失效，未更新会话摘要。"); this.name = "ImageConversationSummaryFenceError"; }
}

export async function refreshImageConversationSummary(db: Database, execution: ConversationExecution) {
  const { conversation: expectedConversation, turn } = execution;
  if (turn.owner_user_id !== expectedConversation.owner_user_id || turn.conversation_id !== expectedConversation.id
    || turn.state !== "planning" || !turn.planner_lease_token) throw new ImageConversationSummaryFenceError();
  return withTransaction(db, async client => {
    await lockTaskAdmission(client, expectedConversation.owner_user_id);
    const conversation = await readConversation(client, expectedConversation.owner_user_id, expectedConversation.id, true);
    const fenceValues = [turn.id, conversation.id, conversation.owner_user_id, safeCounter(turn.execution_epoch), turn.planner_lease_token];
    const assertFence = async () => {
      const current = await client.query(`SELECT id FROM image_conversation_turns WHERE id=$1 AND conversation_id=$2 AND owner_user_id=$3
        AND state='planning' AND execution_epoch=$4 AND planner_lease_token=$5 AND planner_lease_expires_at>clock_timestamp() FOR UPDATE`, fenceValues);
      if (!current.rows.length) throw new ImageConversationSummaryFenceError();
    };
    await assertFence();
    const previousThroughSeq = safeCounter(conversation.context_summary_through_seq);
    const unchanged = { updated: false, summary: conversation.context_summary, throughSeq: previousThroughSeq };
    const alreadyUpdated = await client.query("SELECT seq FROM image_conversation_events WHERE conversation_id=$1 AND turn_id=$2 AND event_type='context_summary.updated' LIMIT 1", [conversation.id, turn.id]);
    if (alreadyUpdated.rows.length) return unchanged;
    const currentMessage = await client.query<{ seq: string }>("SELECT seq FROM image_conversation_messages WHERE conversation_id=$1 AND turn_id=$2 AND role='user'", [conversation.id, turn.id]);
    const currentSeq = currentMessage.rows[0] ? safeCounter(currentMessage.rows[0].seq) : 0;
    if (!currentSeq || previousThroughSeq >= currentSeq) throw new ImageConversationSummaryFenceError();
    const boundary = await client.query<{ seq: string }>(`SELECT seq FROM image_conversation_messages WHERE conversation_id=$1 AND seq<$2
      AND role IN ('user','assistant') ORDER BY seq DESC OFFSET 19 LIMIT 1`, [conversation.id, currentSeq]);
    if (!boundary.rows.length || safeCounter(boundary.rows[0].seq) <= previousThroughSeq) return unchanged;
    const rows = await client.query<ConversationSummaryMessage>(`SELECT seq,turn_id,role,kind,left(text,600) AS text,coalesce(char_length(text),0) AS original_characters
      FROM image_conversation_messages WHERE conversation_id=$1 AND seq>$2 AND seq<=$3 AND role IN ('user','assistant')
      ORDER BY seq LIMIT 41`, [conversation.id, previousThroughSeq, boundary.rows[0].seq]);
    if (!rows.rows.length) return unchanged;
    const next = compactConversationSummary(conversation.context_summary, previousThroughSeq, rows.rows.slice(0, 40), rows.rows.length > 40);
    const updated = await client.query<ConversationRow>(`UPDATE image_conversations SET context_summary=$2,context_summary_through_seq=$3
      WHERE id=$1 AND context_summary_through_seq=$4 RETURNING *`, [conversation.id, JSON.stringify(next.summary), next.throughSeq, previousThroughSeq]);
    if (!updated.rows[0]) throw new ImageConversationSummaryFenceError();
    await appendConversationEvent(client, updated.rows[0], turn.id, "context_summary.updated", {
      stateRevision: safeCounter(conversation.state_revision), contextSummary: next.summary, contextSummaryThroughSeq: next.throughSeq,
    });
    await assertFence();
    return { updated: true, ...next };
  });
}
