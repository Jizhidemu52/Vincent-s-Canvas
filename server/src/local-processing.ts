import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { localProcessingBoards, localProcessingInputSchema, type LocalProcessingInput, type LocalProcessingPage, type LocalProcessingRecord } from "../../shared/local-processing-contracts";
import { requestedContentHash } from "./asset-content-hash";
import { AssetObjectError, isMissingAssetObject } from "./asset-object-error";
import { writeAudit } from "./audit";
import { makeCursorPage, parseCursorPage } from "./cursor-pagination";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { canonicalPayloadHash } from "./image-conversation-store";
import type { ObjectStorage } from "./object-storage";
import type { SessionUser } from "./types";

const uploadAction = "asset.local_processing_upload";
const archiveAction = "asset.local_processing_archived";
const uploadReference = (operationId: string) => `local-processing-upload:${operationId}`;
const archiveReference = (operationId: string) => `local-processing:${operationId}`;
const archivedProof = `EXISTS(SELECT 1 FROM audit_logs proof WHERE proof.target_type='asset' AND proof.target_id=a.id::text
  AND proof.actor_user_id=a.owner_user_id AND proof.action='${archiveAction}' AND proof.result='success')`;

export class LocalProcessingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type UploadInput = {
  filename: string; mimeType: string; byteSize: number; kind: string; metadata: Record<string, unknown>;
  localProcessingOperationId?: string; projectId?: string | null; clientReferenceId?: string; repairAssetId?: string;
};
type AssetRow = {
  id: string; owner_user_id: string; department_id: string | null; object_key: string; filename: string;
  mime_type: string; byte_size: number; kind: string; source: string; status: string; deleted_at: Date | null;
  task_id: string | null; content_sha256: string | null; client_reference_id: string | null;
  metadata: Record<string, unknown>; createdAt: string;
};
type ArchiveMetadata = { version: 1; input: LocalProcessingInput; payloadHash: string };
const assetFields = `a.*,to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

export function assertLocalProcessingUploadInput(input: UploadInput) {
  if (Object.hasOwn(input.metadata, "localProcessing") || Object.hasOwn(input.metadata, "localProcessingUpload")
    || input.clientReferenceId?.startsWith("local-processing")) {
    throw new LocalProcessingError(400, "RESERVED_ASSET_METADATA", "本地处理归档字段由服务器维护，不能随普通上传写入");
  }
  if (input.localProcessingOperationId && (input.kind !== "image" || !input.mimeType.startsWith("image/")
    || input.projectId || input.clientReferenceId || input.repairAssetId || !requestedContentHash(input.metadata))) {
    throw new LocalProcessingError(400, "INVALID_LOCAL_PROCESSING_UPLOAD", "最终处理图必须单独上传并提供原件 SHA256，不能复用项目、补传或客户端来源编号");
  }
}

async function lockOperation(client: PoolClient, ownerId: string, operationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`local-processing:${ownerId}:${operationId}`]);
}

export async function reserveLocalProcessingUpload(db: Database, actor: SessionUser, input: UploadInput & { localProcessingOperationId: string }) {
  assertLocalProcessingUploadInput(input);
  return withTransaction(db, async client => {
    await lockOperation(client, actor.id, input.localProcessingOperationId);
    const reference = uploadReference(input.localProcessingOperationId);
    const existing = (await client.query<AssetRow>(`SELECT ${assetFields} FROM assets a
      WHERE a.owner_user_id=$1 AND a.client_reference_id=$2 ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE`, [actor.id, reference])).rows[0];
    if (existing) {
      const proof = await client.query(`SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND target_type='asset' AND target_id=$2
        AND action=$3 AND result='success'`, [actor.id, existing.id, uploadAction]);
      if (!proof.rows.length || existing.filename !== input.filename || existing.mime_type !== input.mimeType
        || Number(existing.byte_size) !== input.byteSize || requestedContentHash(existing.metadata) !== requestedContentHash(input.metadata)) {
        throw new LocalProcessingError(409, "LOCAL_PROCESSING_IDEMPOTENCY_CONFLICT", "该处理编号已用于不同文件，不能覆盖原件");
      }
      if (existing.deleted_at || !["pending", "ready"].includes(existing.status))
        throw new LocalProcessingError(410, "LOCAL_PROCESSING_OUTPUT_UNAVAILABLE", "该处理成果已删除或不可用，请恢复原成果或创建新的操作");
      return { asset: existing, reused: true };
    }
    const archived = await client.query(`SELECT a.id FROM assets a WHERE a.owner_user_id=$1
      AND a.metadata->'localProcessing'->'input'->>'clientOperationId'=$2 AND ${archivedProof}`, [actor.id, input.localProcessingOperationId]);
    if (archived.rows.length) throw new LocalProcessingError(409, "LOCAL_PROCESSING_IDEMPOTENCY_CONFLICT", "该处理编号已有归档成果，不能再创建上传");
    const id = randomUUID();
    const metadata = { ...input.metadata, localProcessingUpload: { version: 1, clientOperationId: input.localProcessingOperationId } };
    const asset = (await client.query<AssetRow>(`INSERT INTO assets AS a(id,owner_user_id,department_id,object_key,filename,mime_type,byte_size,kind,client_reference_id,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,'image',$8,$9::jsonb) RETURNING ${assetFields}`,
    [id, actor.id, actor.departmentId, `users/${actor.id}/${id}/${input.filename.replace(/[^A-Za-z0-9._-]/g, "_")}`,
      input.filename, input.mimeType, input.byteSize, reference, JSON.stringify(metadata)])).rows[0]!;
    await writeAudit(client, { actor, action: uploadAction, targetType: "asset", targetId: id, departmentId: actor.departmentId,
      result: "success", detail: { clientOperationId: input.localProcessingOperationId } });
    return { asset, reused: false };
  });
}

function record(row: AssetRow): LocalProcessingRecord {
  const archive = row.metadata.localProcessing as ArchiveMetadata;
  const { assetId, ...input } = localProcessingInputSchema.parse(archive.input);
  return { ...input, version: 1, id: row.id, ownerUserId: row.owner_user_id, outputAssetId: row.id,
    sourceOutputAssetId: assetId, sourceTaskId: input.sourceTaskId ?? null, createdAt: row.createdAt,
    filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), contentSha256: row.content_sha256!,
    contentUrl: `/api/assets/${row.id}/content`, thumbnailUrl: `/api/assets/${row.id}/thumb?w=256`, previewUrl: `/api/assets/${row.id}/thumb?w=1024` };
}

async function verifyObject(storage: ObjectStorage, asset: AssetRow) {
  try {
    const object = await storage.head(asset.object_key, { abortSignal: AbortSignal.timeout(5000) });
    if (!object.ETag || Number(object.ContentLength) !== Number(asset.byte_size))
      throw new LocalProcessingError(409, "LOCAL_PROCESSING_OBJECT_CHANGED", "服务器图片与归档原件不一致，请重新核对上传结果");
    return object.ETag;
  } catch (error) {
    if (error instanceof LocalProcessingError) throw error;
    throw new AssetObjectError(isMissingAssetObject(error));
  }
}

async function validateSources(client: PoolClient, actor: SessionUser, input: LocalProcessingInput) {
  const ids = [...new Set([input.assetId, ...input.sourceAssetIds])].sort();
  const rows = (await client.query<AssetRow>(`SELECT ${assetFields} FROM assets a WHERE a.id=ANY($1::uuid[]) AND a.owner_user_id=$2
    AND a.kind='image' AND a.mime_type LIKE 'image/%' AND a.status='ready' AND a.deleted_at IS NULL ORDER BY a.id FOR SHARE`, [ids, actor.id])).rows;
  if (rows.length !== ids.length) throw new LocalProcessingError(404, "LOCAL_PROCESSING_SOURCE_NOT_FOUND", "最终图或来源图片不存在、未上传完成，或不属于当前员工");
  const output = rows.find(asset => asset.id === input.assetId)!;
  if (!output.content_sha256) throw new LocalProcessingError(409, "LOCAL_PROCESSING_UNVERIFIED_OUTPUT", "最终图缺少服务器验证的内容校验值，请先完成原件上传");
  if (input.sourceTaskId) {
    const tasks = await client.query(`SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND status='success'
      AND operation_type IN ('image_generation','inpaint') AND COALESCE(tool_key,parameters->>'tool')=$3 FOR SHARE`, [input.sourceTaskId, actor.id, input.board]);
    const selection = input.parameters.selection!;
    const raw = rows.some(asset => input.sourceAssetIds.includes(asset.id) && asset.id !== selection.sourceAssetId
      && asset.id !== selection.maskAssetId && asset.task_id === input.sourceTaskId && ["generation", "edit"].includes(asset.source));
    if (!tasks.rows.length || !raw) throw new LocalProcessingError(404, "LOCAL_PROCESSING_TASK_NOT_FOUND", "局部合成必须关联本人已成功的原始任务及其真实结果图片");
  }
  return { rows, output };
}

export async function archiveLocalProcessing(db: Database, storage: ObjectStorage, actor: SessionUser, value: unknown) {
  const input = localProcessingInputSchema.parse(value);
  if (!storage.configured) throw new LocalProcessingError(503, "STORAGE_NOT_CONFIGURED", "公司对象存储尚未配置");
  const payloadHash = canonicalPayloadHash(input);
  const client = await db.connect();
  let copiedKey: string | undefined;
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    await lockOperation(client, actor.id, input.clientOperationId);
    const existing = (await client.query<AssetRow>(`SELECT ${assetFields} FROM assets a WHERE a.owner_user_id=$1
      AND a.metadata->'localProcessing'->'input'->>'clientOperationId'=$2 AND ${archivedProof} LIMIT 1 FOR SHARE`, [actor.id, input.clientOperationId])).rows[0];
    if (existing) {
      if ((existing.metadata.localProcessing as ArchiveMetadata).payloadHash !== payloadHash)
        throw new LocalProcessingError(409, "LOCAL_PROCESSING_IDEMPOTENCY_CONFLICT", "同一处理编号的原图、提示词或参数发生变化，原归档未被修改");
      if (existing.deleted_at || existing.status !== "ready")
        throw new LocalProcessingError(410, "LOCAL_PROCESSING_OUTPUT_UNAVAILABLE", "该处理成果已删除或不可用，请先恢复原成果");
      await verifyObject(storage, existing);
      commitAttempted = true;
      await client.query("COMMIT");
      return { record: record(existing), reused: true };
    }
    const { rows, output } = await validateSources(client, actor, input);
    const intent = output.metadata.localProcessingUpload as { version?: number; clientOperationId?: string } | undefined;
    if (intent && intent.clientOperationId !== input.clientOperationId)
      throw new LocalProcessingError(409, "LOCAL_PROCESSING_IDEMPOTENCY_CONFLICT", "最终图属于另一处理编号，不能改写其归档");
    const proofs = await client.query(`SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND target_type='asset' AND target_id=$2
      AND action=$3 AND result='success'`, [actor.id, output.id, uploadAction]);
    const dedicated = intent?.version === 1 && intent.clientOperationId === input.clientOperationId
      && output.client_reference_id === uploadReference(input.clientOperationId) && output.source === "upload" && !output.task_id && proofs.rows.length > 0;
    const etags = await Promise.all(rows.map(asset => verifyObject(storage, asset)));
    const archive: ArchiveMetadata = { version: 1, input, payloadHash };
    let result: AssetRow;
    if (dedicated) {
      result = (await client.query<AssetRow>(`UPDATE assets AS a SET source='import',operation_type=$3,prompt=$4,
        metadata=(metadata-'localProcessingUpload') || jsonb_build_object('localProcessing',$5::jsonb),updated_at=now()
        WHERE a.id=$1 AND a.owner_user_id=$2 AND a.task_id IS NULL AND a.source='upload' RETURNING ${assetFields}`,
      [output.id, actor.id, `local_${input.operation.replaceAll("-", "_")}`, input.prompt, JSON.stringify(archive)])).rows[0]!;
    } else {
      const id = randomUUID();
      copiedKey = `users/${actor.id}/${id}/local-result`;
      try { await storage.copy(output.object_key, copiedKey, etags[rows.findIndex(asset => asset.id === output.id)]!); }
      catch { throw new AssetObjectError(false); }
      const metadata = Object.fromEntries(["width", "height", "naturalWidth", "naturalHeight"].flatMap(key =>
        typeof output.metadata[key] === "number" ? [[key, output.metadata[key]]] : []));
      result = (await client.query<AssetRow>(`INSERT INTO assets AS a(id,owner_user_id,department_id,object_key,filename,mime_type,byte_size,kind,
        source,operation_type,prompt,status,content_sha256,client_reference_id,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,'image','import',$8,$9,'ready',$10,$11,$12::jsonb) RETURNING ${assetFields}`,
      [id, actor.id, actor.departmentId, copiedKey, output.filename, output.mime_type, Number(output.byte_size),
        `local_${input.operation.replaceAll("-", "_")}`, input.prompt, output.content_sha256, archiveReference(input.clientOperationId),
        JSON.stringify({ ...metadata, contentSha256: output.content_sha256, localProcessing: archive })])).rows[0]!;
    }
    await writeAudit(client, { actor, action: archiveAction, targetType: "asset", targetId: result.id, departmentId: actor.departmentId,
      result: "success", detail: { clientOperationId: input.clientOperationId, payloadHash, board: input.board, operation: input.operation } });
    commitAttempted = true;
    await client.query("COMMIT");
    copiedKey = undefined;
    return { record: record(result), reused: false };
  } catch (error) {
    const rolledBack = await client.query("ROLLBACK").then(() => true, () => false);
    if (copiedKey && rolledBack && !commitAttempted) await storage.remove(copiedKey, { abortSignal: AbortSignal.timeout(5000) }).catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function listLocalProcessing(db: Database, actor: SessionUser, query: unknown): Promise<LocalProcessingPage> {
  const { board, clientOperationId } = z.object({ board: z.enum(localProcessingBoards), clientOperationId: z.string().uuid().transform(value => value.toLowerCase()).optional() }).parse(query);
  const { limit, cursor } = parseCursorPage(query, { defaultLimit: 30, maxLimit: 60 });
  if (cursor) z.string().uuid().parse(cursor.id);
  const values: unknown[] = [actor.id, board];
  let boundary = "";
  if (cursor) { values.push(cursor.createdAt, cursor.id); boundary = "AND (a.created_at,a.id)<($3::timestamptz,$4::uuid)"; }
  if (clientOperationId) { values.push(clientOperationId); boundary += ` AND a.metadata->'localProcessing'->'input'->>'clientOperationId'=$${values.length}`; }
  values.push(limit + 1);
  const rows = (await db.query<AssetRow>(`SELECT ${assetFields} FROM assets a WHERE a.owner_user_id=$1 AND a.status='ready'
    AND a.deleted_at IS NULL AND a.kind='image' AND a.source='import' AND a.metadata->'localProcessing'->>'version'='1'
    AND a.metadata->'localProcessing'->'input'->>'board'=$2 AND ${archivedProof} ${boundary}
    ORDER BY a.created_at DESC,a.id DESC LIMIT $${values.length}`, values)).rows;
  const page = makeCursorPage(rows, limit, row => ({ id: row.id, createdAt: row.createdAt }));
  return { records: page.items.map(record), hasMore: page.hasMore, nextCursor: page.nextCursor };
}
