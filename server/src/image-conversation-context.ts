import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  buildImageAgentContext, imageAgentHistoryMessages, IMAGE_AGENT_HISTORY_CHARACTERS,
  IMAGE_AGENT_HISTORY_MESSAGES, IMAGE_AGENT_PREVIEW_BYTES, type ImageAgentContextMessage,
} from "../../shared/image-agent/context";
import { IMAGE_AGENT_MAX_IMAGES, selectImageAgentWorkingSet } from "../../shared/image-agent/focus";
import type { ContextImageEntry, ContextManifest, RequestedState } from "../../shared/image-conversation-contracts";
import {
  acceptedTurnInputSchema, contextManifestSchema, contextSummarySchema, conversationMessageSchema, requestedStateSchema, uuidSchema,
} from "../../shared/image-conversation-schemas";
import { createAssetThumbnailDetails } from "./asset-thumbnails";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import {
  IMAGE_CONVERSATION_PLANNER_CONTEXT_LIMIT, imageConversationPlannerContextSchema, type ImageConversationPlannerContext,
} from "./image-conversation-planner";
import {
  canonicalPayloadHash, messageSnapshot, readConversation, safeCounter, type ConversationRow, type MessageRow, type TurnRow,
} from "./image-conversation-store";
import type { ConversationExecution } from "./image-conversation-worker";
import type { ObjectStorage } from "./object-storage";
import { providerImageMimeType } from "./provider-image-result";
import type { ResponseInput } from "./routes/chat";

export type ConversationContextAsset = {
  id: string; owner_user_id: string; object_key: string; mime_type: string; byte_size: string | number;
  content_sha256: string | null;
};
export type ImageConversationContextOptions = {
  storage?: Pick<ObjectStorage, "get">;
  readAsset?: (asset: Readonly<ConversationContextAsset>) => Promise<Uint8Array>;
  lookup?: { versionIds: string[]; imageNos: number[] };
};
export type PreparedImageConversationContext = {
  input: ResponseInput[]; context: ImageConversationPlannerContext; manifest: ContextManifest; validate: () => Promise<void>;
};
export class ImageConversationContextError extends Error {
  readonly status = 422;
  constructor(readonly code: "PLANNER_CONTEXT_INVALID" | "ASSET_NOT_READY", message: string) { super(message); this.name = "ImageConversationContextError"; }
}

type ContextVersion = {
  id: string; conversation_id: string; root_version_id: string; parent_version_id: string | null;
  version_no: string | number; image_no: string | number; label: string; asset_id: string; source: "upload" | "generated";
  requested_state: RequestedState; asset: ConversationContextAsset;
};
type ContextSnapshot = {
  conversation: ConversationRow; turn: TurnRow; currentMessage: MessageRow; history: MessageRow[];
  historyCount: number; versions: ContextVersion[]; attachments: ContextManifest["attachments"];
};
const versionSelect = `v.id,v.conversation_id,v.root_version_id,v.parent_version_id,v.version_no,v.image_no,v.label,v.asset_id,v.source,v.requested_state,
  jsonb_build_object('id',a.id,'owner_user_id',a.owner_user_id,'object_key',a.object_key,'mime_type',a.mime_type,'byte_size',a.byte_size,'content_sha256',a.content_sha256) AS asset`;
const versionFrom = `FROM image_conversation_versions v JOIN assets a ON a.id=v.asset_id
  WHERE v.conversation_id=$1 AND a.owner_user_id=$2 AND a.status='ready' AND a.deleted_at IS NULL AND a.kind='image'
  AND a.mime_type IN ('image/png','image/jpeg','image/webp','image/gif')`;
const maxOriginalBytes = 200 * 1024 * 1024;
const maxPreviewBytes = 4 * 1024 * 1024;
const policyVersion = "image-conversation-context-v1";
const emptyState: RequestedState = { schemaVersion: 1, goals: [], constraints: [] };
function contextFailure(message: string): never { throw new ImageConversationContextError("PLANNER_CONTEXT_INVALID", message); }
function assetFailure(): never { throw new ImageConversationContextError("ASSET_NOT_READY", "本轮图片已不可读取或归属发生变化，未发送模型请求；请检查原图片后重试。"); }
const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))];

function executionIdentity(turn: TurnRow) {
  return { id: turn.id, conversationId: turn.conversation_id, ownerId: turn.owner_user_id, payloadHash: turn.payload_hash,
    input: turn.input_payload, inputActiveVersionId: turn.input_active_version_id, acceptedRevision: safeCounter(turn.accepted_revision), epoch: safeCounter(turn.execution_epoch) };
}

async function readExecution(client: Pick<PoolClient, "query">, execution: ConversationExecution) {
  if (execution.turn.conversation_id !== execution.conversation.id || execution.turn.owner_user_id !== execution.conversation.owner_user_id) contextFailure("本轮会话归属不一致，未发送模型请求。");
  const conversation = await readConversation(client, execution.conversation.owner_user_id, execution.conversation.id);
  const turn = (await client.query<TurnRow>(`SELECT * FROM image_conversation_turns WHERE id=$1 AND conversation_id=$2 AND owner_user_id=$3
    AND (state='accepted' OR (state='planning' AND planner_lease_token=$4 AND planner_lease_expires_at>now()))`,
  [execution.turn.id, conversation.id, conversation.owner_user_id, execution.turn.planner_lease_token])).rows[0];
  if (!turn || !["accepted", "planning"].includes(turn.state) || turn.task_id
    || canonicalPayloadHash(executionIdentity(turn)) !== canonicalPayloadHash(executionIdentity(execution.turn))) contextFailure("本轮请求已变化或停止，未发送模型请求。");
  const parsed = acceptedTurnInputSchema.safeParse(turn.input_payload);
  if (!parsed.success) contextFailure("已受理的本轮输入无效，未发送模型请求。");
  const currentMessage = (await client.query<MessageRow>("SELECT * FROM image_conversation_messages WHERE conversation_id=$1 AND turn_id=$2 AND role='user'", [conversation.id, turn.id])).rows[0];
  if (!currentMessage || !conversationMessageSchema.safeParse(messageSnapshot(currentMessage)).success
    || currentMessage.text !== parsed.data.text || currentMessage.attachments.length !== parsed.data.attachments.length) contextFailure("本轮原文或附件登记不一致，未发送模型请求。");
  return { conversation, turn, currentMessage };
}

async function readVersions(client: Pick<PoolClient, "query">, conversation: ConversationRow, ids: readonly string[]) {
  if (!ids.length) return [];
  return (await client.query<ContextVersion>(`SELECT ${versionSelect} ${versionFrom} AND v.id=ANY($3::uuid[])`, [conversation.id, conversation.owner_user_id, ids])).rows;
}

async function readContextSnapshot(db: Database, execution: ConversationExecution, options: ImageConversationContextOptions): Promise<ContextSnapshot> {
  return withTransaction(db, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const current = await readExecution(client, execution);
    const { conversation, turn, currentMessage } = current;
    const lookup = options.lookup;
    if (lookup && (lookup.versionIds.length + lookup.imageNos.length > IMAGE_AGENT_MAX_IMAGES
      || lookup.versionIds.some(id => !uuidSchema.safeParse(id).success)
      || lookup.imageNos.some(number => !Number.isSafeInteger(number) || number < 1))) contextFailure("历史图片查阅参数无效，未发送模型请求。");
    const lookedUp = lookup ? (await client.query<ContextVersion>(`SELECT ${versionSelect} ${versionFrom}
      AND (v.id=ANY($3::uuid[]) OR v.image_no=ANY($4::bigint[]))`, [conversation.id, conversation.owner_user_id, lookup.versionIds, lookup.imageNos])).rows : [];
    if (lookup && (lookup.versionIds.some(id => !lookedUp.some(version => version.id === id))
      || lookup.imageNos.some(number => !lookedUp.some(version => safeCounter(version.image_no) === number)))) assetFailure();
    const mandatoryIds = unique([turn.input_active_version_id, ...currentMessage.attachments, ...lookedUp.map(version => version.id)]);
    if (mandatoryIds.length > IMAGE_AGENT_MAX_IMAGES) contextFailure("当前图和本轮附件合计最多五张；未省略明确参考图，也未发送模型请求。");
    const mandatory = await readVersions(client, conversation, mandatoryIds);
    if (mandatory.length !== mandatoryIds.length) assetFailure();
    const byId = new Map(mandatory.map(version => [version.id, version]));
    const attachments = turn.input_payload.attachments.map((attachment, index) => {
      const version = byId.get(currentMessage.attachments[index]!);
      if (!version || version.asset_id !== attachment.assetId) contextFailure("本轮附件与已登记图片版本不一致，未发送模型请求。");
      return { assetId: attachment.assetId, versionId: version.id, purpose: attachment.purpose };
    });
    const active = turn.input_active_version_id ? byId.get(turn.input_active_version_id)! : null;
    const relatives = await readVersions(client, conversation, unique([active?.root_version_id, active?.parent_version_id]).filter(id => !byId.has(id)));
    const recent = (await client.query<ContextVersion>(`SELECT ${versionSelect} ${versionFrom} ORDER BY v.image_no DESC LIMIT 40`, [conversation.id, conversation.owner_user_id])).rows;
    const versions = [...new Map([...mandatory, ...relatives, ...recent].map(version => [version.id, version])).values()].slice(0, 40)
      .sort((left, right) => safeCounter(left.image_no) - safeCounter(right.image_no));
    const summaryThrough = safeCounter(conversation.context_summary_through_seq), currentSeq = safeCounter(currentMessage.seq);
    if (summaryThrough >= currentSeq || !contextSummarySchema.safeParse(conversation.context_summary).success) contextFailure("会话摘要范围无效，未发送模型请求。");
    const history = (await client.query<MessageRow>(`SELECT * FROM image_conversation_messages WHERE conversation_id=$1 AND seq>$2 AND seq<$3
      AND role IN ('user','assistant') ORDER BY seq DESC LIMIT $4`, [conversation.id, summaryThrough, currentSeq, IMAGE_AGENT_HISTORY_MESSAGES])).rows;
    const count = (await client.query<{ count: string }>("SELECT count(*) AS count FROM image_conversation_messages WHERE conversation_id=$1 AND seq<$2", [conversation.id, currentSeq])).rows[0];
    for (const version of versions) if (!requestedStateSchema.safeParse(version.requested_state).success) contextFailure("历史版本设计要求无效，未截断或替换有效状态。");
    for (const message of history) if (!conversationMessageSchema.safeParse(messageSnapshot(message)).success) contextFailure("历史消息格式无效，未发送模型请求。");
    return { ...current, versions, attachments, history, historyCount: safeCounter(count.count) };
  });
}

function versionIdentity(version: ContextVersion) {
  return { id: version.id, conversationId: version.conversation_id, root: version.root_version_id, parent: version.parent_version_id,
    versionNo: safeCounter(version.version_no), imageNo: safeCounter(version.image_no), label: version.label,
    assetId: version.asset_id, source: version.source, requestedState: version.requested_state };
}

function sameAsset(original: ConversationContextAsset, current: ConversationContextAsset, hash?: string) {
  return original.id === current.id && original.owner_user_id === current.owner_user_id && original.object_key === current.object_key
    && original.mime_type === current.mime_type && Number(original.byte_size) === Number(current.byte_size)
    && (!original.content_sha256 || original.content_sha256 === current.content_sha256)
    && (!hash || !current.content_sha256 || hash === current.content_sha256);
}

async function assetBytes(asset: ConversationContextAsset, options: ImageConversationContextOptions) {
  const expected = Number(asset.byte_size);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > maxOriginalBytes || !asset.object_key) assetFailure();
  if (options.readAsset) return options.readAsset(Object.freeze({ ...asset }));
  if (!options.storage) assetFailure();
  const object = await options.storage.get(asset.object_key, { abortSignal: AbortSignal.timeout(30_000) });
  if (!object.Body || !object.ETag || object.ContentLength !== expected || object.ContentType?.split(";", 1)[0] !== asset.mime_type) assetFailure();
  return object.Body.transformToByteArray();
}

function responseMessage(message: ImageAgentContextMessage): ResponseInput {
  if (message.role !== "user" && message.role !== "assistant") contextFailure("会话资料不得包含系统或开发者消息。");
  return { role: message.role, content: typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text"
    ? { type: "input_text" as const, text: part.text } : { type: "input_image" as const, image_url: part.image_url.url }) };
}

function inputText(message: ResponseInput) {
  if (!("role" in message)) contextFailure("会话资料仅允许用户和助手原文。");
  return typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "input_text").map(part => part.text).join("\n");
}

export async function buildImageConversationContext(db: Database, execution: ConversationExecution, options: ImageConversationContextOptions = {}): Promise<PreparedImageConversationContext> {
  const snapshot = await readContextSnapshot(db, execution, options);
  const { conversation, turn, currentMessage, versions } = snapshot;
  const byId = new Map(versions.map(version => [version.id, version]));
  const active = turn.input_active_version_id ? byId.get(turn.input_active_version_id)! : null;
  const roleFor = (version: ContextVersion): ContextImageEntry["role"] => version.id === active?.id ? "current"
    : snapshot.attachments.some(item => item.versionId === version.id) ? "reference"
      : version.id === active?.root_version_id ? "original" : version.id === active?.parent_version_id ? "previous" : "reference";
  const images = versions.map(version => ({ id: version.id,
    label: `${version.label}（version_id=${version.id}，asset_id=${version.asset_id}，role=${roleFor(version)}）`,
    kind: version.source, parentId: version.parent_version_id ?? undefined, workId: version.root_version_id, versionNo: safeCounter(version.version_no) }));
  const lookupIds = versions.filter(version => options.lookup?.versionIds.includes(version.id) || options.lookup?.imageNos.includes(safeCounter(version.image_no))).map(version => version.id);
  const explicitIds = unique([active?.id, ...snapshot.attachments.map(item => item.versionId), ...lookupIds, active?.root_version_id, active?.parent_version_id])
    .filter(id => byId.has(id)).slice(0, IMAGE_AGENT_MAX_IMAGES);
  const selection = { focusId: active?.id, explicitIds, newCreation: !active };
  const workingSet = selectImageAgentWorkingSet(images, selection);
  const previewIds = new Set(workingSet.map(image => image.id));
  const manifest: ContextManifest = {
    schemaVersion: 1, summaryThroughSeq: safeCounter(conversation.context_summary_through_seq), messageSeqs: [safeCounter(currentMessage.seq)],
    inputActiveVersionId: turn.input_active_version_id, baseVersionId: null, sourceStateVersionId: null,
    images: versions.map(version => ({ versionId: version.id, assetId: version.asset_id, role: roleFor(version), previewed: previewIds.has(version.id) })),
    attachments: snapshot.attachments, omittedHistory: snapshot.historyCount > 0, policyVersion,
  };
  const context: ImageConversationPlannerContext = {
    conversationId: conversation.id, currentUserText: turn.input_payload.text, inputActiveVersionId: turn.input_active_version_id,
    requestedState: active?.requested_state ?? emptyState, contextSummary: conversation.context_summary, manifest,
    versions: versions.map(version => ({ id: version.id, label: version.label, rootVersionId: version.root_version_id, parentVersionId: version.parent_version_id,
      versionNo: safeCounter(version.version_no), imageNo: safeCounter(version.image_no), requestedState: version.requested_state, previewed: previewIds.has(version.id) })),
  };
  const checkBudget = (inputCharacters: number) => JSON.stringify(context).length + inputCharacters + 512 <= IMAGE_CONVERSATION_PLANNER_CONTEXT_LIMIT;
  const plannedLabels = workingSet.reduce((total, image) => total + image.label.length + image.id.length + 30, 0);
  if (!checkBudget(context.currentUserText.length + plannedLabels) || !imageConversationPlannerContextSchema.safeParse(context).success)
    contextFailure("规划上下文超过安全预算或版本资料无效；未截断有效设计要求，未发送模型请求。");
  const hashes = new Map<string, string>();
  let previewBytes = 0;
  const built = await buildImageAgentContext({ images, history: [], currentText: context.currentUserText, ...selection,
    readImage: async image => {
      const version = byId.get(image.id)!;
      const current = (await readVersions(db, conversation, [version.id]))[0];
      if (!current || canonicalPayloadHash(versionIdentity(current)) !== canonicalPayloadHash(versionIdentity(version)) || !sameAsset(version.asset, current.asset)) assetFailure();
      try {
        const bytes = await assetBytes(current.asset, options);
        if (bytes.byteLength !== Number(current.asset.byte_size) || providerImageMimeType(bytes, "") !== current.asset.mime_type) assetFailure();
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (current.asset.content_sha256 && current.asset.content_sha256 !== hash) assetFailure();
        const details = await createAssetThumbnailDetails(bytes, [1024]);
        const preview = details.thumbnails[1024];
        if (!preview?.byteLength || preview.byteLength > maxPreviewBytes || previewBytes + preview.byteLength > IMAGE_AGENT_PREVIEW_BYTES) contextFailure("本轮图片预览超过安全预算，未发送模型请求。");
        previewBytes += preview.byteLength;
        hashes.set(version.asset_id, hash);
        return `data:image/webp;base64,${preview.toString("base64")}`;
      } catch (error) {
        if (error instanceof ImageConversationContextError) throw error;
        return assetFailure();
      }
    },
  });
  const baseInput = built.messages.map(responseMessage);
  const fixedCharacters = baseInput.reduce((total, message) => total + inputText(message).length, 0);
  if (!checkBudget(fixedCharacters)) contextFailure("本轮原文和完整设计要求超过规划预算，未发送模型请求。");
  const historyInput: ResponseInput[] = [];
  const included: MessageRow[] = [];
  let historyCharacters = 0, clippedHistory = false;
  for (const message of snapshot.history) {
    if (included.length >= IMAGE_AGENT_HISTORY_MESSAGES - 1) break;
    const rendered = imageAgentHistoryMessages([{ id: message.id, role: message.role, text: message.text ?? "",
      ...(message.role === "user" ? { inputImageIds: message.attachments } : { generatedImageIds: message.attachments }) }], images).map(responseMessage);
    if (!rendered.length) continue;
    const length = rendered.reduce((total, item) => total + inputText(item).length, 0);
    manifest.messageSeqs = [...included.map(item => safeCounter(item.seq)), safeCounter(message.seq), safeCounter(currentMessage.seq)].sort((left, right) => left - right);
    if (historyCharacters + length > IMAGE_AGENT_HISTORY_CHARACTERS || !checkBudget(fixedCharacters + historyCharacters + length)) {
      manifest.messageSeqs = [...included.map(item => safeCounter(item.seq)), safeCounter(currentMessage.seq)].sort((left, right) => left - right);
      break;
    }
    included.unshift(message);
    historyInput.unshift(...rendered);
    historyCharacters += length;
    clippedHistory ||= (message.text?.length ?? 0) > 12_000;
  }
  manifest.omittedHistory = clippedHistory || snapshot.historyCount > included.length;
  const parsedContext = imageConversationPlannerContextSchema.safeParse(context), parsedManifest = contextManifestSchema.safeParse(manifest);
  if (!parsedContext.success || !parsedManifest.success || !checkBudget(fixedCharacters + historyCharacters)) contextFailure("规划上下文校验未通过，未发送模型请求。");
  const validate = async () => withTransaction(db, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const current = await readExecution(client, { conversation, turn });
    if (canonicalPayloadHash(messageSnapshot(current.currentMessage)) !== canonicalPayloadHash(messageSnapshot(currentMessage))
      || canonicalPayloadHash(current.conversation.context_summary) !== canonicalPayloadHash(conversation.context_summary)
      || safeCounter(current.conversation.context_summary_through_seq) !== manifest.summaryThroughSeq) contextFailure("本轮原文或历史摘要已变化，未发送模型请求。");
    const available = await readVersions(client, current.conversation, versions.map(version => version.id));
    if (available.length !== versions.length) assetFailure();
    for (const version of available) {
      const original = byId.get(version.id)!;
      if (canonicalPayloadHash(versionIdentity(version)) !== canonicalPayloadHash(versionIdentity(original))
        || !sameAsset(original.asset, version.asset, hashes.get(version.asset_id))) assetFailure();
    }
    if (included.length) {
      const messages = (await client.query<MessageRow>("SELECT * FROM image_conversation_messages WHERE conversation_id=$1 AND id=ANY($2::uuid[]) ORDER BY seq", [conversation.id, included.map(message => message.id)])).rows;
      if (canonicalPayloadHash(messages.map(messageSnapshot)) !== canonicalPayloadHash(included.map(messageSnapshot))) contextFailure("本轮历史资料已变化，未发送模型请求。");
    }
  });
  await validate();
  return { input: [...historyInput, ...baseInput], context: parsedContext.data, manifest: parsedManifest.data, validate };
}
