import type { ObjectStorage } from "./object-storage";

export const missingAssetObjectMessage = "参考素材的原始文件缺失，请重新上传原图后再生成。";
export const unavailableAssetObjectMessage = "暂时无法读取参考素材，请稍后重试或联系管理员检查对象存储。";

/** Only a definitive object-level 404 permits byte-for-byte repair. */
export function isMissingAssetObject(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  const status = value?.$metadata?.httpStatusCode;
  if (status !== undefined) return status === 404;
  return value?.name === "NoSuchKey" || value?.name === "NotFound";
}

export class AssetObjectError extends Error {
  readonly status: 404 | 503;
  readonly code: "ASSET_OBJECT_MISSING" | "ASSET_STORAGE_UNAVAILABLE";
  constructor(missing: boolean) {
    super(missing ? missingAssetObjectMessage : unavailableAssetObjectMessage);
    this.name = "AssetObjectError";
    this.status = missing ? 404 : 503;
    this.code = missing ? "ASSET_OBJECT_MISSING" : "ASSET_STORAGE_UNAVAILABLE";
  }
}

export async function readSourceAssetObject(storage: ObjectStorage, key: string) {
  try {
    const object = await storage.get(key, { abortSignal: AbortSignal.timeout(30_000) });
    if (!object.Body) throw new AssetObjectError(false);
    return object;
  } catch (error) {
    if (error instanceof AssetObjectError) throw error;
    throw new AssetObjectError(isMissingAssetObject(error));
  }
}
