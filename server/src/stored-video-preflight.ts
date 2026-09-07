import type { Database } from "./db";
import { BillingError } from "./billing";
import { isPublicHttpsUrl } from "./apimart-upload";
import { isSupportedVideoModelId, videoSourceMetadata, type ProviderVideoSource } from "./video-models";
import { preflightVideoSources } from "./video-source-preparation";
import { probeMediaBytes } from "./media-probe";
import { ObjectStorage } from "./object-storage";
import { loadConfig } from "./config";

export type StoredVideoProbeRuntime = {
  readSource?: (key: string) => Promise<Uint8Array>;
  probe?: typeof probeMediaBytes;
};

async function readStoredSource(key: string) {
  const object = await new ObjectStorage(loadConfig()).get(key);
  const bytes = await object.Body?.transformToByteArray();
  if (!bytes?.byteLength) throw new Error("参考素材内容为空或无法读取");
  return bytes;
}

export async function preflightStoredVideoTask(db: Pick<Database, "query">, input: { userId: string; modelConfigId?: string | null; prompt: string; parameters?: Record<string, unknown>; sourceUrls: string[] }, publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || "", runtime: StoredVideoProbeRuntime = {}) {
  const result = await db.query<{ modelId: string }>(
    `SELECT m.model_id AS "modelId" FROM model_configs m JOIN providers p ON p.id=m.provider_id
     WHERE m.id=$1 AND m.enabled=true AND p.enabled=true AND p.protocol='apimart' AND p.encrypted_credentials IS NOT NULL AND 'video'=ANY(m.capabilities)`, [input.modelConfigId ?? null],
  );
  const model = result.rows[0];
  if (!model || !isSupportedVideoModelId(model.modelId)) throw new BillingError("MODEL_DISABLED", "所选视频模型未启用或尚不支持");
  if (input.sourceUrls.length > 50) throw new BillingError("INVALID_VIDEO_INPUT", "视频素材数量不能超过 50 个");
  const sources: ProviderVideoSource[] = [];
  const keys: string[] = [];
  for (const url of input.sourceUrls) {
    const id = url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1];
    const stored = id ? await db.query<{ id: string; objectKey: string; mimeType: string; byteSize: number; metadata?: Record<string, unknown> }>(
      `SELECT id,object_key AS "objectKey",mime_type AS "mimeType",byte_size AS "byteSize",metadata FROM assets
       WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND deleted_at IS NULL`, [id, input.userId],
    ) : null;
    const asset = stored?.rows[0];
    if (!asset) throw new BillingError("INVALID_SOURCE", "参考素材不存在或无权访问");
    const image = asset.mimeType.startsWith("image/");
    if (!image && !isPublicHttpsUrl(publicEndpoint)) throw new BillingError("INVALID_VIDEO_INPUT", "视频/音频素材需配置公开 HTTPS 的 S3_PUBLIC_ENDPOINT；内部对象存储端口无需公开，尚未扣费");
    sources.push({ mimeType: asset.mimeType, bytes: new Uint8Array(), byteSize: Number(asset.byteSize), ...videoSourceMetadata(asset.metadata), publicUrl: image ? "asset://pending-image-upload" : "https://pending-owned-storage.example/reference" });
    keys.push(asset.objectKey);
  }
  try {
    // Cheap size/count/mode checks happen before reading any stored bytes.
    preflightVideoSources(model.modelId, input.prompt, input.parameters || {}, sources);
    const verified: ProviderVideoSource[] = [];
    for (const [index, source] of sources.entries()) {
      if (!keys[index]) throw new Error("参考素材缺少服务端存储位置，请重新上传");
      const bytes = await (runtime.readSource || readStoredSource)(keys[index]!);
      if (bytes.byteLength !== source.byteSize) throw new Error("参考素材实际大小与存储记录不一致，请重新上传");
      const metadata = await (runtime.probe || probeMediaBytes)(bytes, source.mimeType);
      verified.push({ mimeType: source.mimeType, bytes, byteSize: bytes.byteLength, publicUrl: source.publicUrl, ...metadata });
    }
    return preflightVideoSources(model.modelId, input.prompt, input.parameters || {}, verified);
  } catch (error) {
    throw new BillingError("INVALID_VIDEO_INPUT", error instanceof Error ? error.message : "视频参数不正确");
  }
}
