import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX, publicGenerationFailure } from "../../shared/generation-error";
import { deriveConversationRequestedState, resolveConversationVersion } from "../../shared/image-agent/conversation";
import type { PixelDimensions, SettingsSnapshot, TurnError, TurnState } from "../../shared/image-conversation-contracts";
import { contextManifestSchema, plannerPlanSchema, settingsSnapshotSchema, uuidSchema } from "../../shared/image-conversation-schemas";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import {
  activeTurnStates, appendConversationEvent, appendConversationMessage, canonicalPayloadHash, readConversation,
  safeCounter, turnSnapshot, versionSnapshot, type ConversationRow, type TurnRow, type VersionRow,
} from "./image-conversation-store";
import { hasImageTransparency } from "./image-result-processing";
import { readImageResultMetadata } from "./image-result-variants";
import { probeMediaBytes } from "./media-probe";
import type { ObjectStorage } from "./object-storage";
import { providerImageMimeType } from "./provider-image-result";
import { lockTaskAdmission } from "./tasks";

type ProjectionTask = {
  id: string; request_id: string; user_id: string; status: "waiting" | "processing" | "paused" | "failed" | "cancelled" | "success";
  result_urls: unknown; failure_reason: string | null; operation_type: string; model_config_id: string | null;
};
export type ConversationResultAsset = {
  id: string; owner_user_id: string; task_id: string | null; object_key: string; mime_type: string;
  byte_size: string | number; kind: string; status: string; deleted_at: Date | string | null;
  content_sha256: string | null; metadata: unknown;
};
export type ImageConversationProjectorOptions = {
  storage?: Pick<ObjectStorage, "get">;
  readAsset?: (asset: Readonly<ConversationResultAsset>) => Promise<Uint8Array>;
  wake?: (conversationId: string) => void;
  onError?: (error: unknown, taskId: string) => void;
};
export type ImageConversationProjection = {
  status: "ignored" | "pending" | "projected" | "already_projected" | "deferred";
  conversationId?: string; versionId?: string; activeChanged?: boolean;
};
type ProjectionIdentity = Pick<TurnRow, "id" | "owner_user_id" | "conversation_id">;
type LockedProjection = { conversation: ConversationRow; turn: TurnRow; task: ProjectionTask };
type VerifiedResult = { asset: ConversationResultAsset; sha256: string; dimensions: PixelDimensions; mimeType: "image/png" | "image/jpeg" | "image/webp" };
const taskColumns = "id,request_id,user_id,status,result_urls,failure_reason,operation_type,model_config_id";
const assetColumns = "id,owner_user_id,task_id,object_key,mime_type,byte_size,kind,status,deleted_at,content_sha256,metadata";
const archiveFailure: TurnError = { code: "RESULT_ARCHIVE_FAILED", message: "原任务已保留，图片保存或核对尚未完成；请查询原任务或联系管理员，不要重复生成。", retryable: false };

export function resolveConversationPrimaryAssetId(resultUrls: unknown): string {
  if (!Array.isArray(resultUrls) || resultUrls.length !== 1 || typeof resultUrls[0] !== "string") throw new Error("Conversation requires one primary image result");
  const match = /^\/api\/assets\/([^/]+)\/content$/.exec(resultUrls[0]);
  if (!match || !uuidSchema.safeParse(match[1]).success) throw new Error("Conversation primary result is not an owned asset URL");
  return match[1]!.toLowerCase();
}

function assertTaskBinding(turn: TurnRow, task: ProjectionTask) {
  if (turn.task_id !== task.id || turn.owner_user_id !== task.user_id || turn.task_request_id !== task.request_id
    || task.request_id !== `ic:${turn.id}:image:1` || !["image_generation", "inpaint"].includes(task.operation_type)) throw new Error("Conversation task identity mismatch");
}

function assertPrimaryAsset(asset: ConversationResultAsset | undefined, task: ProjectionTask): asserts asset is ConversationResultAsset {
  if (!asset || asset.id !== resolveConversationPrimaryAssetId(task.result_urls) || asset.owner_user_id !== task.user_id
    || asset.task_id !== task.id || asset.status !== "ready" || asset.deleted_at || asset.kind !== "image"
    || !["image/png", "image/jpeg", "image/webp"].includes(asset.mime_type)
    || !Number.isSafeInteger(Number(asset.byte_size)) || Number(asset.byte_size) < 1 || Number(asset.byte_size) > 50 * 1024 * 1024
    || !asset.object_key) throw new Error("Conversation primary image is not ready");
  const metadata = readImageResultMetadata(asset.metadata);
  if (metadata && (metadata.role !== "primary" || metadata.resultIndex !== 0)) throw new Error("Conversation result is not the primary image");
}

async function lockedProjection(client: PoolClient, identity: ProjectionIdentity, taskId: string): Promise<LockedProjection | null> {
  await lockTaskAdmission(client, identity.owner_user_id);
  const conversation = await readConversation(client, identity.owner_user_id, identity.conversation_id, true);
  const turn = (await client.query<TurnRow>("SELECT * FROM image_conversation_turns WHERE id=$1 AND conversation_id=$2 FOR UPDATE", [identity.id, conversation.id])).rows[0];
  if (!turn || turn.task_id !== taskId) return null;
  const task = (await client.query<ProjectionTask>(`SELECT ${taskColumns} FROM tasks WHERE id=$1 FOR UPDATE`, [taskId])).rows[0];
  if (!task) return null;
  assertTaskBinding(turn, task);
  return { conversation, turn, task };
}

async function readResultBytes(asset: ConversationResultAsset, options: ImageConversationProjectorOptions) {
  if (options.readAsset) return options.readAsset(Object.freeze({ ...asset }));
  if (!options.storage) throw new Error("Conversation result storage unavailable");
  const stored = await options.storage.get(asset.object_key, { abortSignal: AbortSignal.timeout(30_000) });
  if (!stored.Body || !stored.ETag || stored.ContentLength !== Number(asset.byte_size)
    || stored.ContentType?.split(";", 1)[0] !== asset.mime_type) throw new Error("Stored conversation result identity mismatch");
  return stored.Body.transformToByteArray();
}

async function verifyResult(db: Database, task: ProjectionTask, options: ImageConversationProjectorOptions): Promise<VerifiedResult> {
  const id = resolveConversationPrimaryAssetId(task.result_urls);
  const asset = (await db.query<ConversationResultAsset>(`SELECT ${assetColumns} FROM assets WHERE id=$1`, [id])).rows[0];
  assertPrimaryAsset(asset, task);
  const bytes = await readResultBytes(asset, options);
  if (bytes.byteLength !== Number(asset.byte_size)) throw new Error("Conversation result bytes do not match stored size");
  const mimeType = providerImageMimeType(bytes, "");
  if (mimeType !== asset.mime_type || mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") throw new Error("Conversation result content is not the declared image type");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (asset.content_sha256 && asset.content_sha256 !== sha256) throw new Error("Conversation result content hash changed");
  await hasImageTransparency({ bytes, mimeType });
  const actual = await probeMediaBytes(bytes, mimeType);
  if (!actual.width || !actual.height) throw new Error("Conversation result dimensions unavailable");
  return { asset, sha256, dimensions: { width: actual.width, height: actual.height }, mimeType };
}

async function updateTaskState(client: PoolClient, current: LockedProjection, error?: TurnError): Promise<boolean> {
  const { conversation, task, turn } = current;
  let state: TurnState = turn.state;
  let lastError: TurnError | null = error ?? null;
  if (!error) {
    if (task.status === "paused") lastError = task.failure_reason?.startsWith(IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX) ? archiveFailure
      : { code: "UPSTREAM_OUTCOME_UNKNOWN", message: publicGenerationFailure(task.failure_reason, "paused"), retryable: false };
    else if (task.status === "failed") lastError = { code: "UPSTREAM_FAILED", message: publicGenerationFailure(task.failure_reason, "failed"), retryable: false };
  }
  if (activeTurnStates.includes(turn.state)) state = error || task.status === "paused" ? "uncertain"
    : task.status === "waiting" ? "queued" : task.status === "processing" ? "generating"
      : task.status === "failed" ? "failed" : task.status === "cancelled" ? "cancelled" : turn.state;
  if (state === turn.state && canonicalPayloadHash(lastError) === canonicalPayloadHash(turn.last_error)) return false;
  const updated = (await client.query<TurnRow>(`UPDATE image_conversation_turns SET state=$2,last_error=$3,
    auto_activate=CASE WHEN $2 IN ('cancelled','failed') THEN false ELSE auto_activate END,updated_at=now() WHERE id=$1 RETURNING *`,
  [turn.id, state, lastError ? JSON.stringify(lastError) : null])).rows[0];
  const type = state === "detached" ? "turn.updated" : state === "failed" ? "turn.failed" : state === "cancelled" ? "turn.cancelled" : state === "uncertain" ? "turn.uncertain" : "turn.updated";
  if (lastError) await appendConversationMessage(client, conversation, { turnId: turn.id, role: "assistant", kind: "status", text: lastError.message, attachments: [] });
  await appendConversationEvent(client, conversation, turn.id, type, { stateRevision: safeCounter(conversation.state_revision), turn: turnSnapshot(updated) });
  if (state === "queued" || state === "generating" || state === "uncertain") await appendConversationEvent(client, conversation, turn.id, "task.progress", {
    stateRevision: safeCounter(conversation.state_revision), turnId: turn.id, taskId: task.id,
    phase: lastError?.code === "RESULT_ARCHIVE_FAILED" ? "saving" : state === "uncertain" ? "reconciling" : state === "queued" ? "queued" : "generating", progress: null,
  });
  return true;
}

function frozenProjectionState(turn: TurnRow, versions: VersionRow[]) {
  const plan = plannerPlanSchema.parse(turn.plan), manifest = contextManifestSchema.parse(turn.context_manifest);
  if (plan.action !== "edit" && plan.action !== "generate_new") throw new Error("Conversation result has no image plan");
  if (manifest.inputActiveVersionId !== turn.input_active_version_id || manifest.baseVersionId !== turn.base_version_id) throw new Error("Conversation frozen image identity mismatch");
  const snapshots = versions.map(versionSnapshot);
  const base = plan.action === "edit" ? resolveConversationVersion(snapshots, turn.input_active_version_id, plan.base) : null;
  if ((base?.id ?? null) !== turn.base_version_id) throw new Error("Conversation base changed after submission");
  const sourceId = plan.action === "edit" ? plan.stateSource === "active" ? turn.input_active_version_id : base!.id : null;
  if (manifest.sourceStateVersionId !== sourceId) throw new Error("Conversation source state does not match frozen manifest");
  const source = sourceId ? resolveConversationVersion(snapshots, turn.input_active_version_id, { kind: "version", versionId: sourceId }) : null;
  return { base, requestedState: deriveConversationRequestedState(plan, source?.requestedState ?? null, turn.id, turn.input_payload.text), plan };
}

async function completeProjection(client: PoolClient, current: LockedProjection, verified: VerifiedResult, observed: TurnRow): Promise<ImageConversationProjection> {
  const { conversation, turn, task } = current;
  if (turn.output_version_id) return { status: "already_projected", conversationId: conversation.id, versionId: turn.output_version_id };
  if (task.status !== "success") return { status: "pending", conversationId: conversation.id };
  for (const field of ["plan", "settings_snapshot", "context_manifest", "input_payload", "base_version_id", "input_active_version_id"] as const)
    if (canonicalPayloadHash(turn[field]) !== canonicalPayloadHash(observed[field])) throw new Error("Conversation frozen submission changed during projection");
  const asset = (await client.query<ConversationResultAsset>(`SELECT ${assetColumns} FROM assets WHERE id=$1 FOR UPDATE`, [verified.asset.id])).rows[0];
  assertPrimaryAsset(asset, task);
  for (const field of ["object_key", "mime_type", "metadata"] as const)
    if (canonicalPayloadHash(asset[field]) !== canonicalPayloadHash(verified.asset[field])) throw new Error("Conversation result identity changed during verification");
  if (Number(asset.byte_size) !== Number(verified.asset.byte_size) || asset.content_sha256 && asset.content_sha256 !== verified.sha256) throw new Error("Conversation result bytes changed during verification");
  if (!asset.content_sha256) await client.query("UPDATE assets SET content_sha256=$2,updated_at=now() WHERE id=$1 AND content_sha256 IS NULL", [asset.id, verified.sha256]);
  const versions = (await client.query<VersionRow>("SELECT * FROM image_conversation_versions WHERE conversation_id=$1 ORDER BY image_no", [conversation.id])).rows;
  const { base, requestedState, plan } = frozenProjectionState(turn, versions);
  if (turn.intent !== plan.action || task.operation_type !== (plan.action === "edit" ? "inpaint" : "image_generation")) throw new Error("Conversation result operation does not match frozen plan");
  const frozen = settingsSnapshotSchema.parse(turn.settings_snapshot);
  if (frozen.effective.modelConfigId !== task.model_config_id) throw new Error("Conversation result model binding changed");
  if (frozen.intent.sizeMode === "exact_pixels" && frozen.effective.size !== `${verified.dimensions.width}x${verified.dimensions.height}`) throw new Error("Conversation exact result dimensions mismatch");
  const settings: SettingsSnapshot = settingsSnapshotSchema.parse({ ...frozen, actual: {
    quality: null, dimensions: verified.dimensions, outputFormat: verified.mimeType.slice(6), mimeType: verified.mimeType, providerActualRmb: null, usage: null,
  } });
  let version = versions.find(item => item.turn_id === turn.id && item.output_index === 0);
  const created = !version;
  if (version && version.asset_id !== asset.id) throw new Error("Conversation turn already has a different output");
  if (!version) {
    const id = randomUUID(), root = base?.rootVersionId ?? id;
    const versionNo = base ? Math.max(...versions.filter(item => item.root_version_id === root).map(item => safeCounter(item.version_no))) + 1 : 1;
    const counter = (await client.query<{ image_no: string }>("UPDATE image_conversations SET last_image_no=last_image_no+1,updated_at=now() WHERE id=$1 RETURNING last_image_no AS image_no", [conversation.id])).rows[0];
    conversation.last_image_no = counter.image_no;
    version = (await client.query<VersionRow>(`INSERT INTO image_conversation_versions(id,conversation_id,root_version_id,parent_version_id,version_no,image_no,label,asset_id,source,turn_id,requested_state,parameters,actual_dimensions)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'generated',$9,$10,$11,$12) RETURNING *`,
    [id, conversation.id, root, base?.id ?? null, versionNo, counter.image_no, `图 ${counter.image_no} · V${versionNo}`, asset.id, turn.id,
      JSON.stringify(requestedState), JSON.stringify(settings), JSON.stringify(verified.dimensions)])).rows[0];
  }
  const activeChanged = turn.auto_activate && activeTurnStates.includes(turn.state)
    && conversation.active_version_id === turn.input_active_version_id && safeCounter(conversation.state_revision) === safeCounter(turn.accepted_revision);
  if (activeChanged) {
    const changed = (await client.query<{ state_revision: string }>("UPDATE image_conversations SET active_version_id=$2,state_revision=state_revision+1,updated_at=now() WHERE id=$1 RETURNING state_revision", [conversation.id, version.id])).rows[0];
    conversation.active_version_id = version.id;
    conversation.state_revision = changed.state_revision;
  }
  const updated = (await client.query<TurnRow>(`UPDATE image_conversation_turns SET output_version_id=$2,settings_snapshot=$3,last_error=NULL,
    state=CASE WHEN state IN ('detached','cancelled') THEN state ELSE 'completed' END,updated_at=now() WHERE id=$1 RETURNING *`,
  [turn.id, version.id, JSON.stringify(settings)])).rows[0];
  const stateRevision = safeCounter(conversation.state_revision);
  if (created) await appendConversationEvent(client, conversation, turn.id, "version.created", { stateRevision, version: versionSnapshot(version) });
  if (activeChanged) await appendConversationEvent(client, conversation, turn.id, "active.changed", { stateRevision, activeVersionId: version.id, reason: "generation_completed" });
  const message = await client.query("SELECT id FROM image_conversation_messages WHERE turn_id=$1 AND role='assistant' AND kind='image' AND attachments @> $2::jsonb", [turn.id, JSON.stringify([version.id])]);
  if (!message.rows.length) await appendConversationMessage(client, conversation, { turnId: turn.id, role: "assistant", kind: "image", text: plan.assistantText, attachments: [version.id] });
  await appendConversationEvent(client, conversation, turn.id, updated.state === "completed" ? "turn.completed" : "turn.updated", { stateRevision, turn: turnSnapshot(updated) });
  return { status: "projected", conversationId: conversation.id, versionId: version.id, activeChanged };
}

export async function projectImageConversationTask(db: Database, taskId: string, options: ImageConversationProjectorOptions = {}): Promise<ImageConversationProjection> {
  const observed = (await db.query<TurnRow>("SELECT * FROM image_conversation_turns WHERE task_id=$1", [taskId])).rows[0];
  if (!observed) return { status: "ignored" };
  if (observed.output_version_id) return { status: "already_projected", conversationId: observed.conversation_id, versionId: observed.output_version_id };
  const task = (await db.query<ProjectionTask>(`SELECT ${taskColumns} FROM tasks WHERE id=$1`, [taskId])).rows[0];
  if (!task) return { status: "ignored" };
  assertTaskBinding(observed, task);
  try {
    const verified = task.status === "success" ? await verifyResult(db, task, options) : null;
    const projected = await withTransaction(db, async client => {
      const current = await lockedProjection(client, observed, taskId);
      if (!current) return { status: "ignored" } satisfies ImageConversationProjection;
      if (current.turn.output_version_id) return { status: "already_projected", conversationId: current.conversation.id, versionId: current.turn.output_version_id } satisfies ImageConversationProjection;
      if (verified) return completeProjection(client, current, verified, observed);
      await updateTaskState(client, current);
      return { status: "pending", conversationId: current.conversation.id } satisfies ImageConversationProjection;
    });
    if (projected.conversationId) options.wake?.(projected.conversationId);
    return projected;
  } catch (error) {
    options.onError?.(error, taskId);
    const result = await withTransaction(db, async client => {
      const current = await lockedProjection(client, observed, taskId);
      if (!current) return { status: "ignored" } satisfies ImageConversationProjection;
      if (current.turn.output_version_id) return { status: "already_projected", conversationId: current.conversation.id, versionId: current.turn.output_version_id } satisfies ImageConversationProjection;
      await updateTaskState(client, current, current.task.status === "success" ? archiveFailure : undefined);
      await client.query("UPDATE image_conversation_turns SET updated_at=now() WHERE id=$1", [current.turn.id]);
      return { status: "deferred", conversationId: current.conversation.id } satisfies ImageConversationProjection;
    });
    if (result.conversationId) options.wake?.(result.conversationId);
    return result;
  }
}

export async function projectPendingImageConversationTasks(db: Database, options: ImageConversationProjectorOptions = {}, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid conversation projection batch size");
  const candidates = await db.query<{ task_id: string }>(`SELECT t.task_id FROM image_conversation_turns t JOIN tasks task ON task.id=t.task_id
    WHERE t.output_version_id IS NULL AND (task.status='success'
      OR t.state IN ('queued','generating','uncertain') AND (
        task.status='waiting' AND t.state<>'queued' OR task.status='processing' AND t.state<>'generating'
        OR task.status='paused' AND t.state<>'uncertain' OR task.status IN ('failed','cancelled'))
      OR t.state IN ('queued','generating','uncertain','detached') AND (
        task.status='paused' AND COALESCE(t.last_error->>'code','') NOT IN ('UPSTREAM_OUTCOME_UNKNOWN','RESULT_ARCHIVE_FAILED')
        OR task.status='failed' AND COALESCE(t.last_error->>'code','')<>'UPSTREAM_FAILED'))
    ORDER BY t.updated_at,t.id LIMIT $1`, [Math.min(1000, limit)]);
  const results: ImageConversationProjection[] = [];
  for (const candidate of candidates.rows) {
    try { results.push(await projectImageConversationTask(db, candidate.task_id, options)); }
    catch (error) {
      options.onError?.(error, candidate.task_id);
      await db.query("UPDATE image_conversation_turns SET updated_at=now() WHERE task_id=$1 AND output_version_id IS NULL", [candidate.task_id]);
      results.push({ status: "deferred" });
    }
  }
  return results;
}
