import type { Database } from "./db";
import { ToolConfigurationError } from "./tool-configuration";
import { ObjectStorage } from "./object-storage";
import { loadConfig } from "./config";
import { readSourceAssetObject } from "./asset-object-error";
import { validateQuickImageSource, type ProcessedResultImage } from "./image-result-processing";
import { providerImageMimeType } from "./provider-image-result";
import { preflightApiMartImageRequest } from "./apimart-image";
import { QUICK_IMAGE_SNAPSHOT, type QuickImageInput } from "./quick-image-tools";

type SourceSnapshot = { id: string; objectKey: string; mimeType: string; byteSize: number };
type Input = QuickImageInput & { userId: string };
export type QuickImagePreflightRuntime = { readSource?: (key: string) => Promise<Uint8Array>; validateSource?: typeof validateQuickImageSource };

async function sourceSnapshot(db: Pick<Database, "query">, input: Input) {
  const id = input.sourceUrls.length === 1 ? input.sourceUrls[0]?.match(/^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i)?.[1] : null;
  const source = id ? (await db.query<SourceSnapshot>(`SELECT id,object_key AS "objectKey",mime_type AS "mimeType",byte_size AS "byteSize"
    FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND deleted_at IS NULL`, [id, input.userId])).rows[0] : null;
  if (!source) throw new ToolConfigurationError("INVALID_SOURCE", "参考图片不存在或无权访问");
  const byteSize = Number(source.byteSize);
  if (!["image/png", "image/jpeg", "image/webp"].includes(source.mimeType) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 50 * 1024 * 1024) {
    throw new ToolConfigurationError("QUICK_IMAGE_SOURCE_INVALID", "一键图片工具仅支持不超过 50 MiB 的 PNG、JPEG 或 WebP");
  }
  return { ...source, byteSize };
}

async function readSource(key: string) {
  const object = await readSourceAssetObject(new ObjectStorage(loadConfig()), key);
  const reader = object.Body!.transformToWebStream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > 50 * 1024 * 1024) throw new ToolConfigurationError("QUICK_IMAGE_SOURCE_INVALID", "参考图片超过 50 MiB");
      chunks.push(value.value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function preflightStoredQuickImageTask(db: Pick<Database, "query">, input: Input, runtime: QuickImagePreflightRuntime = {}) {
  const configuration = input[QUICK_IMAGE_SNAPSHOT];
  if (!configuration) throw new ToolConfigurationError("QUICK_IMAGE_CONFIGURATION_REQUIRED", "一键工具缺少服务端配置快照");
  const snapshot = await sourceSnapshot(db, input);
  const bytes = await (runtime.readSource ?? readSource)(snapshot.objectKey);
  if (bytes.byteLength !== snapshot.byteSize || providerImageMimeType(bytes, "") !== snapshot.mimeType) throw new ToolConfigurationError("QUICK_IMAGE_SOURCE_INVALID", "参考图片实际格式或大小与存储记录不一致，请重新上传");
  const source: ProcessedResultImage = { bytes, mimeType: snapshot.mimeType };
  try {
    // Identical adapter path to the worker, before uploads, queue admission or credits.
    preflightApiMartImageRequest({ modelId: configuration.modelId, prompt: input.prompt!, parameters: input.parameters ?? {}, sourceImages: [source] });
    await (runtime.validateSource ?? validateQuickImageSource)(source, input.parameters ?? {});
  } catch (error) { throw new ToolConfigurationError("QUICK_IMAGE_SOURCE_INVALID", error instanceof Error ? error.message : "参考图片或参数无效"); }
  return snapshot;
}

export async function validateStoredQuickImageSnapshot(db: Pick<Database, "query">, input: Input, snapshot: SourceSnapshot) {
  if (JSON.stringify(await sourceSnapshot(db, input)) !== JSON.stringify(snapshot)) throw new ToolConfigurationError("QUICK_IMAGE_SOURCE_CHANGED", "参考图片已变化，请重新提交；尚未扣费");
}
