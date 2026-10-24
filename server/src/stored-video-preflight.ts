import type { Database } from "./db";
import { BillingError } from "./billing";
import { isPublicHttpsUrl } from "./apimart-upload";
import { isSupportedVideoModelId, videoSourceMetadata, type ProviderVideoSource } from "./video-models";
import { preflightVideoSources } from "./video-source-preparation";
import { probeMediaStream } from "./media-probe";
import type { MediaStream } from "./media-file";
import { ObjectStorage } from "./object-storage";
import { loadConfig } from "./config";

export type StoredVideoProbeRuntime = {
  readSource?: (key: string) => Promise<MediaStream>;
  probe?: typeof probeMediaStream;
};

type StoredVideoInput = { userId: string; modelConfigId?: string | null; prompt: string; parameters?: Record<string, unknown>; sourceUrls: string[] };
type StoredVideoAsset = { id: string; objectKey: string; mimeType: string; byteSize: number; metadata?: Record<string, unknown> };
export type StoredVideoSnapshot = { modelId: string; assets: Array<Pick<StoredVideoAsset, "id" | "objectKey" | "mimeType" | "byteSize">> };

async function readStoredSource(key: string) {
  const object = await new ObjectStorage(loadConfig()).get(key);
  if (!object.Body) throw new Error("参考素材内容为空或无法读取");
  return object.Body.transformToWebStream();
}

async function readStoredVideoSnapshot(db: Pick<Database, "query">, input: StoredVideoInput) {
  const result = await db.query<{ modelId: string }>(
    `SELECT m.model_id AS "modelId" FROM model_configs m JOIN providers p ON p.id=m.provider_id
     WHERE m.id=$1 AND m.enabled=true AND p.enabled=true AND p.protocol='apimart' AND p.encrypted_credentials IS NOT NULL AND 'video'=ANY(m.capabilities)`, [input.modelConfigId ?? null],
  );
  const model = result.rows[0];
  if (!model || !isSupportedVideoModelId(model.modelId)) throw new BillingError("MODEL_DISABLED", "所选视频模型未启用或尚不支持");
  if (input.sourceUrls.length > 50) throw new BillingError("INVALID_VIDEO_INPUT", "视频素材数量不能超过 50 个");
  const assets: StoredVideoAsset[] = [];
  for (const url of input.sourceUrls) {
    const id = url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1];
    const stored = id ? await db.query<StoredVideoAsset>(
      `SELECT id,object_key AS "objectKey",mime_type AS "mimeType",byte_size AS "byteSize",metadata FROM assets
       WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND deleted_at IS NULL`, [id, input.userId],
    ) : null;
    const asset = stored?.rows[0];
    if (!asset) throw new BillingError("INVALID_SOURCE", "参考素材不存在或无权访问");
    assets.push({ ...asset, byteSize: Number(asset.byteSize) });
  }
  return { modelId: model.modelId, assets };
}

function snapshotIdentity(snapshot: StoredVideoSnapshot) {
  return JSON.stringify({ modelId: snapshot.modelId, assets: snapshot.assets.map(({ id, objectKey, mimeType, byteSize }) => ({ id, objectKey, mimeType, byteSize })) });
}

/** Recheck cheap authoritative state after I/O, inside the admission transaction. */
export async function validateStoredVideoPreflightSnapshot(db: Pick<Database, "query">, input: StoredVideoInput, snapshot: StoredVideoSnapshot) {
  const current = await readStoredVideoSnapshot(db, input);
  if (snapshotIdentity(current) !== snapshotIdentity(snapshot)) throw new BillingError("INVALID_VIDEO_INPUT", "视频模型或参考素材已变化，请重新提交；尚未扣费");
}

export async function preflightStoredVideoTask(db: Pick<Database, "query">, input: StoredVideoInput, publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || "", runtime: StoredVideoProbeRuntime = {}) {
  const snapshot = await readStoredVideoSnapshot(db, input);
  const sources: ProviderVideoSource[] = [];
  for (const asset of snapshot.assets) {
    const image = asset.mimeType.startsWith("image/");
    if (!image && !isPublicHttpsUrl(publicEndpoint)) throw new BillingError("INVALID_VIDEO_INPUT", "视频/音频素材需配置公开 HTTPS 的 S3_PUBLIC_ENDPOINT；内部对象存储端口无需公开，尚未扣费");
    sources.push({ mimeType: asset.mimeType, bytes: new Uint8Array(), byteSize: Number(asset.byteSize), ...videoSourceMetadata(asset.metadata), publicUrl: image ? "asset://pending-image-upload" : "https://pending-owned-storage.example/reference" });
  }
  try {
    // Cheap size/count/mode checks happen before reading any stored bytes.
    preflightVideoSources(snapshot.modelId, input.prompt, input.parameters || {}, sources);
    const verified: ProviderVideoSource[] = [];
    for (const [index, source] of sources.entries()) {
      const key = snapshot.assets[index]!.objectKey;
      if (!key) throw new Error("参考素材缺少服务端存储位置，请重新上传");
      const stream = await (runtime.readSource || readStoredSource)(key);
      const metadata = await (runtime.probe || probeMediaStream)(stream, source.mimeType, source.byteSize);
      verified.push({ ...source, ...metadata });
    }
    return { ...preflightVideoSources(snapshot.modelId, input.prompt, input.parameters || {}, verified), snapshot };
  } catch (error) {
    throw new BillingError("INVALID_VIDEO_INPUT", error instanceof Error ? error.message : "视频参数不正确");
  }
}
