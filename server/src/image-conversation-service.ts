import { randomUUID } from "node:crypto";
import { conversationImageLimitError } from "../../shared/image-agent/focus";
import { turnResultUnconfirmed } from "../../shared/image-conversation-turn-state";
import { unavailablePlannerMessage } from "../../shared/image-conversation-planner-policy";
import { resolveConversationPlannerBinding, readPlannerModel } from "./image-conversation-planner-model";
import { PromptOptimizationError } from "./prompt-safety";
import { ToolConfigurationError } from "./tool-configuration";
import { ModuleDisabledError } from "./module-flags";
import type { PoolClient } from "pg";
import type {
  AcceptedTurnInput, CancellationResult, ConversationPage, ConversationSnapshot, MessagePage, PaginationQuery, TurnDetails, TurnPage,
  TurnSubmissionResult, VersionListQuery, VersionPage,
} from "../../shared/image-conversation-contracts";
import { cancelTurnRequestSchema, createConversationRequestSchema, requestKeySchema, submitTurnRequestSchema } from "../../shared/image-conversation-schemas";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { visibleHistory } from "./account-history-visibility";
import {
  activeTurnStates, appendConversationEvent, appendConversationMessage, canonicalPayloadHash,
  conversationSummary, ImageConversationError, isoTimestamp, messageSnapshot, readConversation,
  readVersion, registerUploadedVersion, safeCounter, turnSnapshot, versionSnapshot,
  type ConversationRow, type MessageRow, type TurnRow, type VersionRow,
} from "./image-conversation-store";
import { decryptSecret, encryptSecret } from "./security";
import { cancelTaskInTransaction, lockTaskAdmission } from "./tasks";

const conflict = () => new ImageConversationError(409, "IDEMPOTENCY_CONFLICT", "相同请求键已用于不同内容，请保留原请求并查询其结果");
async function assertBinding(client: PoolClient, ownerId: string, input: { projectUuid?: string; canvasExternalId?: string }) {
  if (input.canvasExternalId) {
    const canvas = await client.query("SELECT external_id FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2 AND deleted=false FOR SHARE", [ownerId, input.canvasExternalId]);
    if (!canvas.rows.length) throw new ImageConversationError(404, "NOT_FOUND", "画布不存在");
  }
  if (input.projectUuid) {
    const project = await client.query<{ external_id: string }>("SELECT external_id FROM projects WHERE id=$1 AND owner_user_id=$2 AND status='active' FOR SHARE", [input.projectUuid, ownerId]);
    if (!project.rows[0] || input.canvasExternalId && project.rows[0].external_id !== input.canvasExternalId) throw new ImageConversationError(404, "NOT_FOUND", "项目与当前画布不匹配");
  }
}
export async function readConversationSnapshot(client: Pick<PoolClient, "query">, conversation: ConversationRow): Promise<ConversationSnapshot> {
  const active = conversation.active_version_id ? await readVersion(client, conversation.id, conversation.active_version_id) : null;
  const pending = await client.query<TurnRow>("SELECT * FROM image_conversation_turns WHERE conversation_id=$1 AND state=ANY($2::text[]) LIMIT 1", [conversation.id, activeTurnStates]);
  return { ...conversationSummary(conversation), activeVersion: active ? versionSnapshot(active) : null,
    pendingTurn: pending.rows[0] ? turnSnapshot(pending.rows[0]) : null, latestEventSeq: safeCounter(conversation.last_event_seq),
    contextSummary: conversation.context_summary, contextSummaryThroughSeq: safeCounter(conversation.context_summary_through_seq) };
}
async function assertListedConversation(client: Pick<PoolClient,"query">, ownerId:string, conversationId:string) {
  const listed = await client.query(`SELECT 1 FROM image_conversations c WHERE c.owner_user_id=$1 AND c.id=$2 AND ${visibleHistory("conversation","c")}`,[ownerId,conversationId]);
  if(!listed.rows.length) throw new ImageConversationError(410,"NOT_FOUND","这段会话已从你的历史移除");
}
export async function getImageConversation(db: Database, ownerId: string, conversationId: string) {
  return withTransaction(db, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const conversation = await readConversation(client, ownerId, conversationId);
    await assertListedConversation(client,ownerId,conversationId);
    return readConversationSnapshot(client, conversation);
  });
}
export async function getImageConversationByRequest(db: Database, ownerId: string, clientRequestId: string) {
  const key = requestKeySchema.parse(clientRequestId);
  return withTransaction(db, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = (await client.query<ConversationRow>("SELECT * FROM image_conversations WHERE owner_user_id=$1 AND create_request_id=$2", [ownerId, key])).rows[0];
    if (!row) throw new ImageConversationError(404, "NOT_FOUND", "尚未查到此编号的会话创建记录");
    return readConversationSnapshot(client, row);
  });
}
export async function createImageConversation(db: Database, ownerId: string, request: unknown): Promise<{ replayed: boolean; snapshot: ConversationSnapshot }> {
  const input = createConversationRequestSchema.parse(request);
  const { clientRequestId, ...semantic } = input;
  const hash = canonicalPayloadHash(semantic);
  return withTransaction(db, async client => {
    await lockTaskAdmission(client, ownerId);
    const previous = await client.query<ConversationRow>("SELECT * FROM image_conversations WHERE owner_user_id=$1 AND create_request_id=$2 FOR UPDATE", [ownerId, clientRequestId]);
    if (previous.rows[0]) {
      if (previous.rows[0].create_request_hash !== hash) throw conflict();
      return { replayed: true, snapshot: await readConversationSnapshot(client, previous.rows[0]) };
    }
    await assertBinding(client, ownerId, input);
    const id = randomUUID();
    const result = await client.query<ConversationRow>(`INSERT INTO image_conversations(id,owner_user_id,project_uuid,canvas_external_id,entrypoint,title,create_request_id,create_request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, ownerId, input.projectUuid ?? null, input.canvasExternalId ?? null, input.entrypoint, input.title ?? null, clientRequestId, hash]);
    const conversation = result.rows[0];
    const initial = input.initialAssetId ? await registerUploadedVersion(client, conversation, input.initialAssetId) : null;
    if (initial) {
      await client.query("UPDATE image_conversations SET active_version_id=$2,state_revision=state_revision+1,updated_at=now() WHERE id=$1", [id, initial.id]);
      conversation.active_version_id = initial.id;
      conversation.state_revision = 1;
    }
    await appendConversationEvent(client, conversation, null, "conversation.created", { stateRevision: safeCounter(conversation.state_revision), conversation: conversationSummary(conversation) });
    if (initial) {
      await appendConversationEvent(client, conversation, null, "version.created", { stateRevision: safeCounter(conversation.state_revision), version: versionSnapshot(initial) });
      await appendConversationEvent(client, conversation, null, "active.changed", { stateRevision: safeCounter(conversation.state_revision), activeVersionId: initial.id, reason: "initial_upload" });
      await appendConversationMessage(client, conversation, { turnId: null, role: "assistant", kind: "image", text: "原图已保存，可以开始讨论或改图。", attachments: [initial.id] });
    }
    return { replayed: false, snapshot: await readConversationSnapshot(client, await readConversation(client, ownerId, id)) };
  });
}
export function normalizeAcceptedTurn(request: unknown): AcceptedTurnInput {
  const input = submitTurnRequestSchema.parse(request);
  return { ...input, schemaVersion: 1, attachments: (input.attachments ?? []).map(item => ({ assetId: item.assetId, purpose: item.purpose ?? "auto" })),
    replyToTurnId: input.replyToTurnId ?? null, outputPreferences: input.outputPreferences ?? { mode: "auto" } };
}
function submission(turn: TurnRow, conversation: ConversationRow): TurnSubmissionResult {
  return { turnId: turn.id, stateRevision: safeCounter(conversation.state_revision), state: turn.state, assistant: turnSnapshot(turn).assistant };
}
export async function submitImageConversationTurn(db: Database, ownerId: string, conversationId: string, request: unknown): Promise<{ replayed: boolean; result: TurnSubmissionResult }> {
  const input = normalizeAcceptedTurn(request);
  const { clientRequestId, ...semantic } = input;
  const hash = canonicalPayloadHash({ conversationId, input: semantic });
  return withTransaction(db, async client => {
    await lockTaskAdmission(client, ownerId);
    const conversation = await readConversation(client, ownerId, conversationId, true);
    const previous = await client.query<TurnRow>("SELECT * FROM image_conversation_turns WHERE owner_user_id=$1 AND client_request_id=$2", [ownerId, clientRequestId]);
    if (previous.rows[0]) {
      if (previous.rows[0].payload_hash !== hash || previous.rows[0].conversation_id !== conversationId) throw conflict();
      return { replayed: true, result: submission(previous.rows[0], conversation) };
    }
    await assertListedConversation(client,ownerId,conversationId);
    if (safeCounter(conversation.state_revision) !== input.expectedStateRevision) throw new ImageConversationError(409, "CONVERSATION_REVISION_CONFLICT", "当前图片或会话状态已变化，请先刷新", { currentStateRevision: safeCounter(conversation.state_revision) });
    const pending = await client.query<{ id: string }>("SELECT id FROM image_conversation_turns WHERE conversation_id=$1 AND state=ANY($2::text[])", [conversationId, activeTurnStates]);
    if (pending.rows[0]) throw new ImageConversationError(409, "TURN_IN_PROGRESS", "本会话还有一轮正在处理", { currentStateRevision: safeCounter(conversation.state_revision), pendingTurnId: pending.rows[0].id });
    if (input.replyToTurnId) {
      const reply = await client.query("SELECT id FROM image_conversation_turns WHERE conversation_id=$1 AND id=$2", [conversationId, input.replyToTurnId]);
      if (!reply.rows.length) throw new ImageConversationError(404, "NOT_FOUND", "回复的轮次不属于当前会话");
    }
    let inputActiveVersionId = conversation.active_version_id;
    if (input.reuseInputFromTurnId) {
      const source = (await client.query<TurnRow>("SELECT * FROM image_conversation_turns WHERE conversation_id=$1 AND id=$2", [conversationId, input.reuseInputFromTurnId])).rows[0];
      if (!source) throw new ImageConversationError(404, "NOT_FOUND", "原轮次不属于当前会话");
      const latest = (await client.query<TurnRow>("SELECT state,output_version_id FROM image_conversation_turns WHERE conversation_id=$1 ORDER BY accepted_revision DESC LIMIT 1", [conversationId])).rows[0];
      if (turnResultUnconfirmed(source.state, source.output_version_id) || (latest && turnResultUnconfirmed(latest.state, latest.output_version_id)))
        throw new ImageConversationError(409, "TURN_IN_PROGRESS", "原任务结果尚未确认，请查询原任务，不要重新生成");
      if (input.replyToTurnId ? input.replyToTurnId !== source.id :
          canonicalPayloadHash(reusableContent(input)) !== canonicalPayloadHash(reusableContent(source.input_payload)))
        throw new ImageConversationError(400, "VALIDATION_ERROR", "编辑原消息请使用编辑后发送，不能变更重新生成的原始输入");
      inputActiveVersionId = source.input_active_version_id;
    }
    const limitError = conversationImageLimitError(input.attachments.length, Boolean(inputActiveVersionId));
    if (limitError) throw new ImageConversationError(400, "TURN_ATTACHMENT_LIMIT", limitError);
    try {
      const binding = await resolveConversationPlannerBinding(client, conversation.entrypoint);
      const model = await readPlannerModel(client, binding.modelConfigId);
      if (!model.encrypted_credentials) throw new ImageConversationError(503, "PLANNER_BINDING_UNAVAILABLE", unavailablePlannerMessage);
    } catch (error) {
      if (error instanceof ModuleDisabledError) throw new ImageConversationError(403, "SERVICE_UNAVAILABLE", error.message);
      if (error instanceof ToolConfigurationError || error instanceof PromptOptimizationError)
        throw new ImageConversationError(503, "PLANNER_BINDING_UNAVAILABLE", unavailablePlannerMessage);
      throw error;
    }
    const previousImageNo = safeCounter(conversation.last_image_no);
    const versions: VersionRow[] = [];
    for (const attachment of input.attachments) versions.push(await registerUploadedVersion(client, conversation, attachment.assetId));
    const revision = await client.query<{ state_revision: string }>("UPDATE image_conversations SET state_revision=state_revision+1,updated_at=now() WHERE id=$1 RETURNING state_revision", [conversationId]);
    conversation.state_revision = revision.rows[0].state_revision;
    const turnId = randomUUID();
    const inserted = await client.query<TurnRow>(`INSERT INTO image_conversation_turns(id,conversation_id,owner_user_id,client_request_id,payload_hash,input_payload,accepted_revision,input_active_version_id,reply_to_turn_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [turnId, conversationId, ownerId, clientRequestId, hash, JSON.stringify(input), conversation.state_revision, inputActiveVersionId, input.replyToTurnId]);
    for (const version of new Map(versions.filter(item => safeCounter(item.image_no) > previousImageNo).map(item => [item.id, item])).values()) {
      await appendConversationEvent(client, conversation, turnId, "version.created", { stateRevision: safeCounter(conversation.state_revision), version: versionSnapshot(version) });
    }
    await appendConversationMessage(client, conversation, { turnId, role: "user", kind: "text", text: input.text, attachments: versions.map(version => version.id) });
    await appendConversationEvent(client, conversation, turnId, "turn.accepted", { stateRevision: safeCounter(conversation.state_revision), turn: turnSnapshot(inserted.rows[0]) });
    return { replayed: false, result: submission(inserted.rows[0], conversation) };
  });
}
function reusableContent({ text, attachments, outputPreferences, imageModelConfigId }: AcceptedTurnInput) {
  return { text, attachments, outputPreferences, ...(imageModelConfigId ? { imageModelConfigId } : {}) };
}

export async function getReusableTurnInput(db: Database, ownerId: string, conversationId: string, turnId: string) {
  const source = (await db.query<Pick<TurnRow, "input_payload" | "input_active_version_id">>(
    "SELECT input_payload,input_active_version_id FROM image_conversation_turns WHERE owner_user_id=$1 AND conversation_id=$2 AND id=$3", [ownerId, conversationId, turnId])).rows[0];
  if (!source) throw new ImageConversationError(404, "NOT_FOUND", "原轮次不存在");
  return { conversationId, turnId, inputActiveVersionId: source.input_active_version_id, ...reusableContent(source.input_payload) };
}

export async function getImageConversationTurn(db: Database, ownerId: string, conversationId: string, query: { turnId: string } | { clientRequestId: string }): Promise<TurnDetails> {
  return withTransaction(db, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const conversation = await readConversation(client, ownerId, conversationId);
    const result = await client.query<TurnRow>(`SELECT * FROM image_conversation_turns WHERE conversation_id=$1 AND ${"turnId" in query ? "id" : "client_request_id"}=$2`, [conversationId, "turnId" in query ? query.turnId : query.clientRequestId]);
    if (!result.rows[0]) throw new ImageConversationError(404, "NOT_FOUND", "轮次不存在");
    return { turn: turnSnapshot(result.rows[0]), stateRevision: safeCounter(conversation.state_revision) };
  });
}
export async function cancelImageConversationTurn(db: Database, ownerId: string, conversationId: string, turnId: string, request: unknown): Promise<CancellationResult> {
  const input = cancelTurnRequestSchema.parse(request);
  return withTransaction(db, async client => {
    await lockTaskAdmission(client, ownerId);
    const conversation = await readConversation(client, ownerId, conversationId, true);
    const result = await client.query<TurnRow>("SELECT * FROM image_conversation_turns WHERE conversation_id=$1 AND id=$2 FOR UPDATE", [conversationId, turnId]);
    const turn = result.rows[0];
    if (!turn) throw new ImageConversationError(404, "NOT_FOUND", "轮次不存在");
    if (!activeTurnStates.includes(turn.state)) return { ...submission(turn, conversation), disposition: "already_terminal" };
    if (input.expectedStateRevision !== safeCounter(conversation.state_revision)) throw new ImageConversationError(409, "CONVERSATION_REVISION_CONFLICT", "会话状态已变化，请刷新后停止", { currentStateRevision: safeCounter(conversation.state_revision) });
    const cancelled = turn.task_id ? await cancelTaskInTransaction(db, client, turn.task_id, ownerId) : true;
    const state = cancelled ? "cancelled" : "detached";
    const revision = await client.query<{ state_revision: string }>("UPDATE image_conversations SET state_revision=state_revision+1,updated_at=now() WHERE id=$1 RETURNING state_revision", [conversationId]);
    conversation.state_revision = revision.rows[0].state_revision;
    const updated = await client.query<TurnRow>(`UPDATE image_conversation_turns SET state=$2,auto_activate=false,execution_epoch=execution_epoch+1,
      planner_lease_token=NULL,planner_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [turnId, state]);
    const snapshot = turnSnapshot(updated.rows[0]);
    await appendConversationEvent(client, conversation, turnId, state === "cancelled" ? "turn.cancelled" : "turn.detached", { stateRevision: safeCounter(conversation.state_revision), turn: snapshot });
    return { ...submission(updated.rows[0], conversation), disposition: cancelled ? "cancelled_before_submission" : "detached_task_continues" };
  });
}
function readCursor(cursor: string | undefined, secret: string, scope: string): { value: string; id: string } | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 4096) throw new Error("Cursor size");
    const decoded: unknown = JSON.parse(decryptSecret(cursor, secret));
    if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== "image-conversations-v1" || decoded[1] !== scope
      || typeof decoded[2] !== "string" || typeof decoded[3] !== "string") throw new Error("Cursor scope");
    return { value: decoded[2], id: decoded[3] };
  } catch { throw new ImageConversationError(400, "VALIDATION_ERROR", "分页游标无效或不属于当前查询"); }
}
function nextCursor(secret: string, scope: string, value: string, id: string) {
  return encryptSecret(JSON.stringify(["image-conversations-v1", scope, value, id]), secret);
}
export async function listImageConversations(db: Database, ownerId: string, query: PaginationQuery, secret: string): Promise<ConversationPage> {
  const scope = `${ownerId}:conversations:created-desc`;
  const cursor = readCursor(query.cursor, secret, scope);
  const limit = query.limit ?? 30;
  const result = await db.query<ConversationRow & { cursor_time: string }>(`SELECT *,created_at::text AS cursor_time FROM image_conversations
    WHERE owner_user_id=$1 AND ${visibleHistory("conversation","image_conversations")} ${cursor ? "AND (created_at,id)<($3::timestamptz,$4::uuid)" : ""} ORDER BY created_at DESC,id DESC LIMIT $2`,
  [ownerId, limit + 1, ...(cursor ? [cursor.value, cursor.id] : [])]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(conversationSummary), nextCursor: result.rows.length > limit && last ? nextCursor(secret, scope, last.cursor_time, last.id) : null };
}

export async function listDesignExecutionHistory(db: Database, ownerId: string, query: PaginationQuery & { canvasExternalId: string }, secret: string) {
  const scope = JSON.stringify([ownerId, "design-executions", query.canvasExternalId, "created-desc"]);
  const cursor = readCursor(query.cursor, secret, scope), limit = query.limit ?? 30;
  const result = await db.query<{ id: string; create_request_id: string; title: string | null; created_at: Date; cursor_time: string;
    initial_asset_id: string | null; turn_row: TurnRow | null; version_row: VersionRow | null }>(`
    SELECT c.id,c.create_request_id,c.title,c.created_at,c.created_at::text AS cursor_time,
      base.asset_id AS initial_asset_id,row_to_json(t) AS turn_row,row_to_json(v) AS version_row
    FROM image_conversations c
    JOIN canvas_documents d ON d.owner_user_id=c.owner_user_id AND d.external_id=c.canvas_external_id AND d.deleted=false
    LEFT JOIN image_conversation_turns t ON t.conversation_id=c.id AND t.owner_user_id=c.owner_user_id
      AND t.client_request_id=regexp_replace(c.create_request_id, ':create$', ':turn')
    LEFT JOIN image_conversation_versions v ON v.id=t.output_version_id AND v.conversation_id=c.id AND v.turn_id=t.id AND v.source='generated'
    LEFT JOIN image_conversation_versions base ON base.conversation_id=c.id
      AND base.id=COALESCE(t.input_active_version_id,CASE WHEN t.id IS NULL THEN c.active_version_id END)
    WHERE c.owner_user_id=$1 AND c.canvas_external_id=$2 AND c.entrypoint='canvas' AND ${visibleHistory("conversation","c")}
      AND c.create_request_id ~ '^design-image-[a-f0-9]{64}:create$'
      ${cursor ? "AND (c.created_at,c.id)<($4::timestamptz,$5::uuid)" : ""}
    ORDER BY c.created_at DESC,c.id DESC LIMIT $3`, [ownerId, query.canvasExternalId, limit + 1, ...(cursor ? [cursor.value, cursor.id] : [])]);
  const rows = result.rows.slice(0, limit), last = rows.at(-1);
  return { items: rows.map(row => {
    const input = row.turn_row?.input_payload;
    return { id: row.create_request_id.slice(0, -7), conversationId: row.id, canvasExternalId: query.canvasExternalId,
      title: row.title, createdAt: isoTimestamp(row.created_at), initialAssetId: row.initial_asset_id,
      turnRequest: input ? submitTurnRequestSchema.parse({ clientRequestId: input.clientRequestId, expectedStateRevision: input.expectedStateRevision,
        ...reusableContent(input), ...(input.replyToTurnId ? { replyToTurnId: input.replyToTurnId } : {}) }) : null,
      turn: row.turn_row ? turnSnapshot(row.turn_row) : null, outputVersion: row.version_row ? versionSnapshot(row.version_row) : null };
  }), nextCursor: result.rows.length > limit && last ? nextCursor(secret, scope, last.cursor_time, last.id) : null };
}
export async function listImageConversationMessages(db: Database, ownerId: string, conversationId: string, query: PaginationQuery, secret: string): Promise<MessagePage> {
  await readConversation(db, ownerId, conversationId);
  const scope = `${ownerId}:${conversationId}:messages:seq-asc`;
  const cursor = readCursor(query.cursor, secret, scope);
  const limit = query.limit ?? 30;
  const result = await db.query<MessageRow>("SELECT * FROM image_conversation_messages WHERE conversation_id=$1 AND seq>$2::bigint ORDER BY seq ASC LIMIT $3", [conversationId, cursor?.value ?? "0", limit + 1]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(messageSnapshot), nextCursor: result.rows.length > limit && last ? nextCursor(secret, scope, String(last.seq), last.id) : null };
}
export async function listImageConversationTurns(db: Database, ownerId: string, conversationId: string, query: PaginationQuery, secret: string): Promise<TurnPage> {
  await readConversation(db, ownerId, conversationId);
  const scope = `${ownerId}:${conversationId}:turns:created-asc`;
  const cursor = readCursor(query.cursor, secret, scope);
  const limit = query.limit ?? 30;
  const result = await db.query<TurnRow & { cursor_time: string }>(`SELECT *,created_at::text AS cursor_time FROM image_conversation_turns
    WHERE conversation_id=$1 ${cursor ? "AND (created_at,id)>($3::timestamptz,$4::uuid)" : ""} ORDER BY created_at ASC,id ASC LIMIT $2`,
  [conversationId, limit + 1, ...(cursor ? [cursor.value, cursor.id] : [])]);
  const rows = result.rows.slice(0, limit), last = rows.at(-1);
  return { items: rows.map(turnSnapshot), nextCursor: result.rows.length > limit && last ? nextCursor(secret, scope, last.cursor_time, last.id) : null };
}
export async function listImageConversationVersions(db: Database, ownerId: string, conversationId: string, query: VersionListQuery, secret: string): Promise<VersionPage> {
  await readConversation(db, ownerId, conversationId);
  if (query.rootVersionId) {
    const root = await readVersion(db, conversationId, query.rootVersionId);
    if (root.parent_version_id !== null || root.root_version_id !== root.id || safeCounter(root.version_no) !== 1) throw new ImageConversationError(400, "VALIDATION_ERROR", "只能按真实根版本筛选");
  }
  const scope = `${ownerId}:${conversationId}:versions:${query.rootVersionId ?? "all"}:image-asc`;
  const cursor = readCursor(query.cursor, secret, scope);
  const limit = query.limit ?? 30;
  const result = await db.query<VersionRow>(`SELECT * FROM image_conversation_versions WHERE conversation_id=$1 AND image_no>$2::bigint
    ${query.rootVersionId ? "AND root_version_id=$4::uuid" : ""} ORDER BY image_no ASC LIMIT $3`, [conversationId, cursor?.value ?? "0", limit + 1, ...(query.rootVersionId ? [query.rootVersionId] : [])]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return { items: rows.map(versionSnapshot), nextCursor: result.rows.length > limit && last ? nextCursor(secret, scope, String(last.image_no), last.id) : null };
}

export { isoTimestamp };
