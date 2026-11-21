import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  ApiErrorCode, AssistantStatus, ContextSummary, ConversationMessage, ConversationSummary,
  ConversationEvent, ErrorDetails, ImageTurn, ImageVersion, TurnState,
} from "../../shared/image-conversation-contracts";
import { conversationEventSchema } from "../../shared/image-conversation-schemas";
import { activeTurnStates } from "../../shared/image-conversation-turn-state";
export { activeTurnStates };

export class ImageConversationError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string, readonly details: ErrorDetails | null = null) {
    super(message);
  }
}

type Timestamp = Date | string;
export type ConversationRow = {
  id: string; owner_user_id: string; title: string | null; entrypoint: "standalone" | "canvas";
  project_uuid: string | null; canvas_external_id: string | null; active_version_id: string | null;
  state_revision: string | number; last_message_seq: string | number; last_event_seq: string | number;
  last_image_no: string | number; context_summary: ContextSummary; context_summary_through_seq: string | number;
  create_request_id: string; create_request_hash: string; created_at: Timestamp; updated_at: Timestamp;
};
export type TurnRow = {
  id: string; conversation_id: string; owner_user_id: string; client_request_id: string; payload_hash: string;
  input_payload: import("../../shared/image-conversation-contracts").AcceptedTurnInput;
  accepted_revision: string | number; input_active_version_id: string | null; base_version_id: string | null;
  output_version_id: string | null; reply_to_turn_id: string | null; intent: ImageTurn["intent"];
  state: TurnState; planner_status: ImageTurn["plannerStatus"]; task_id: string | null; task_request_id: string | null;
  auto_activate: boolean; settings_snapshot: ImageTurn["settingsSnapshot"]; last_error: ImageTurn["lastError"];
  plan: import("../../shared/image-conversation-contracts").PlannerPlan | null;
  context_manifest: import("../../shared/image-conversation-contracts").ContextManifest | null;
  planner_request_id: string | null; planner_dispatch_started_at: Timestamp | null;
  planner_lease_token: string | null; planner_lease_expires_at: Timestamp | null; execution_epoch: string | number;
  created_at: Timestamp; updated_at: Timestamp;
};
export type VersionRow = {
  id: string; conversation_id: string; root_version_id: string; parent_version_id: string | null;
  version_no: string | number; image_no: string | number; label: string; asset_id: string;
  source: ImageVersion["source"]; turn_id: string | null; output_index: 0;
  requested_state: ImageVersion["requestedState"]; observation: ImageVersion["observation"];
  acceptance: ImageVersion["acceptance"]; parameters: ImageVersion["parameters"];
  actual_dimensions: ImageVersion["actualDimensions"]; created_at: Timestamp;
};
export type MessageRow = {
  id: string; conversation_id: string; turn_id: string | null; seq: string | number;
  role: ConversationMessage["role"]; kind: ConversationMessage["kind"]; text: string | null;
  attachments: string[]; created_at: Timestamp;
};
export const isoTimestamp = (value: Timestamp) => new Date(value).toISOString();
export function safeCounter(value: string | number) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 9_000_000_000_000_000) throw new Error("Invalid conversation sequence");
  return result;
}
export function conversationSummary(row: ConversationRow): ConversationSummary {
  return { id: row.id, title: row.title, entrypoint: row.entrypoint, projectUuid: row.project_uuid,
    canvasExternalId: row.canvas_external_id, activeVersionId: row.active_version_id,
    stateRevision: safeCounter(row.state_revision), createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at) };
}
export function versionSnapshot(row: VersionRow): ImageVersion {
  return { id: row.id, conversationId: row.conversation_id, rootVersionId: row.root_version_id,
    parentVersionId: row.parent_version_id, versionNo: safeCounter(row.version_no), imageNo: safeCounter(row.image_no),
    label: row.label, assetId: row.asset_id, source: row.source, turnId: row.turn_id, outputIndex: row.output_index,
    requestedState: row.requested_state, observation: row.observation, acceptance: row.acceptance,
    parameters: row.parameters, actualDimensions: row.actual_dimensions, createdAt: isoTimestamp(row.created_at) };
}
export function turnAssistant(row: TurnRow): AssistantStatus {
  if (row.last_error && row.state !== "detached") return { kind: "status", text: row.last_error.message, canCancel: row.state === "uncertain" };
  if (row.state === "completed" && row.plan) return {
    kind: row.plan.action === "clarify" ? "question" : "reply",
    text: row.plan.action === "clarify" ? row.plan.question : row.plan.assistantText, canCancel: false,
  };
  const labels: Record<TurnState, string> = { accepted: "已受理，等待理解需求", planning: "正在理解需求", queued: "图片任务已创建",
    generating: "正在生成并保存图片", uncertain: "原任务结果正在核查，请勿重复提交", completed: "本轮已完成", failed: "本轮未完成",
    cancelled: "已停止本轮", detached: "已停止采用结果，原任务仍会按实际结果结算" };
  return { kind: "status", text: labels[row.state], canCancel: activeTurnStates.includes(row.state) };
}
export function turnSnapshot(row: TurnRow): ImageTurn {
  return { id: row.id, conversationId: row.conversation_id, clientRequestId: row.client_request_id,
    acceptedRevision: safeCounter(row.accepted_revision), inputActiveVersionId: row.input_active_version_id,
    baseVersionId: row.base_version_id, outputVersionId: row.output_version_id, replyToTurnId: row.reply_to_turn_id,
    intent: row.intent, state: row.state, plannerStatus: row.planner_status, taskId: row.task_id,
    autoActivate: row.auto_activate, settingsSnapshot: row.settings_snapshot, assistant: turnAssistant(row), lastError: row.last_error,
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at) };
}
export function messageSnapshot(row: MessageRow): ConversationMessage {
  return { id: row.id, conversationId: row.conversation_id, turnId: row.turn_id, seq: safeCounter(row.seq),
    role: row.role, kind: row.kind, text: row.text, attachments: row.attachments, createdAt: isoTimestamp(row.created_at) };
}
export function canonicalPayloadHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export async function readConversation(client: Pick<PoolClient, "query">, ownerId: string, id: string, lock = false) {
  const result = await client.query<ConversationRow>(`SELECT * FROM image_conversations WHERE id=$1 AND owner_user_id=$2${lock ? " FOR UPDATE" : ""}`, [id, ownerId]);
  if (!result.rows[0]) throw new ImageConversationError(404, "NOT_FOUND", "会话不存在");
  return result.rows[0];
}
export async function readVersion(client: Pick<PoolClient, "query">, conversationId: string, id: string) {
  const result = await client.query<VersionRow>("SELECT * FROM image_conversation_versions WHERE conversation_id=$1 AND id=$2", [conversationId, id]);
  if (!result.rows[0]) throw new ImageConversationError(404, "NOT_FOUND", "图片版本不存在");
  return result.rows[0];
}
export async function assertOwnedImage(client: Pick<PoolClient, "query">, ownerId: string, assetId: string, taskId?: string) {
  const result = await client.query<{ id: string; task_id: string | null }>(
    "SELECT id,task_id FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL FOR SHARE", [assetId, ownerId]);
  const asset = result.rows[0];
  if (!asset || taskId !== undefined && asset.task_id !== taskId) throw new ImageConversationError(422, "ASSET_NOT_READY", "图片未就绪或不属于本次任务");
  return asset;
}
type EventPayloads = { [Event in ConversationEvent as Event["type"]]: Event["payload"] };
export async function appendConversationEvent<T extends ConversationEvent["type"]>(
  client: PoolClient, conversation: ConversationRow, turnId: string | null, type: T,
  payload: EventPayloads[T],
) {
  const counter = await client.query<{ seq: string }>("UPDATE image_conversations SET last_event_seq=last_event_seq+1,updated_at=now() WHERE id=$1 RETURNING last_event_seq AS seq", [conversation.id]);
  conversation.last_event_seq = counter.rows[0].seq;
  const result = await client.query<{ created_at: Timestamp }>(
    "INSERT INTO image_conversation_events(conversation_id,seq,turn_id,event_type,payload) VALUES($1,$2,$3,$4,$5) RETURNING created_at",
    [conversation.id, conversation.last_event_seq, turnId, type, JSON.stringify(payload)]);
  return conversationEventSchema.parse({ conversationId: conversation.id, seq: safeCounter(conversation.last_event_seq), turnId, type, payload, createdAt: isoTimestamp(result.rows[0].created_at) });
}
export async function appendConversationMessage(client: PoolClient, conversation: ConversationRow, input: {
  turnId: string | null; role: ConversationMessage["role"]; kind: ConversationMessage["kind"]; text: string | null; attachments: string[];
}) {
  if (input.attachments.length) {
    const found = await client.query<{ id: string }>("SELECT id FROM image_conversation_versions WHERE conversation_id=$1 AND id=ANY($2::uuid[])", [conversation.id, input.attachments]);
    if (new Set(found.rows.map(row => row.id)).size !== new Set(input.attachments).size) throw new ImageConversationError(404, "NOT_FOUND", "消息中的版本不属于当前会话");
  }
  const counter = await client.query<{ seq: string }>("UPDATE image_conversations SET last_message_seq=last_message_seq+1,updated_at=now() WHERE id=$1 RETURNING last_message_seq AS seq", [conversation.id]);
  conversation.last_message_seq = counter.rows[0].seq;
  const result = await client.query<MessageRow>(`INSERT INTO image_conversation_messages(id,conversation_id,turn_id,seq,role,kind,text,attachments)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [randomUUID(), conversation.id, input.turnId, conversation.last_message_seq, input.role, input.kind, input.text, JSON.stringify(input.attachments)]);
  const message = messageSnapshot(result.rows[0]);
  await appendConversationEvent(client, conversation, input.turnId, "message.created", { stateRevision: safeCounter(conversation.state_revision), message });
  return message;
}
export async function registerUploadedVersion(client: PoolClient, conversation: ConversationRow, assetId: string) {
  await assertOwnedImage(client, conversation.owner_user_id, assetId);
  const existing = await client.query<VersionRow>("SELECT * FROM image_conversation_versions WHERE conversation_id=$1 AND asset_id=$2 ORDER BY image_no LIMIT 1", [conversation.id, assetId]);
  if (existing.rows[0]) return existing.rows[0];
  const counter = await client.query<{ image_no: string }>("UPDATE image_conversations SET last_image_no=last_image_no+1,updated_at=now() WHERE id=$1 RETURNING last_image_no AS image_no", [conversation.id]);
  conversation.last_image_no = counter.rows[0].image_no;
  const id = randomUUID();
  const inserted = await client.query<VersionRow>(`INSERT INTO image_conversation_versions(id,conversation_id,root_version_id,version_no,image_no,label,asset_id,source)
    VALUES($1,$2,$1,1,$3,$4,$5,'upload') RETURNING *`, [id, conversation.id, conversation.last_image_no, `图 ${conversation.last_image_no} · V1`, assetId]);
  return inserted.rows[0];
}
