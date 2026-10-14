import { z } from "zod";

const referenceSchema = z.object({
  assetId: z.string().uuid(),
  mimeType: z.string().min(1).max(120),
  filename: z.string().min(1).max(255),
});
const metadataSchema = z.object({
  version: z.literal(1),
  role: z.enum(["primary", "provider-original", "export"]),
  resultIndex: z.number().int().nonnegative(),
  original: referenceSchema,
  export: referenceSchema.optional(),
  maskComposited: z.boolean(),
  requestedOutputFormat: z.string().max(30).optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  warning: z.string().max(2000).optional(),
  operations: z.array(z.string().max(100)).max(20).optional(),
});

export type ImageResultMetadata = z.infer<typeof metadataSchema>;
export type ImageResultAsset = {
  id: string;
  ownerUserId: string;
  taskId?: string | null;
  mimeType: string;
  filename: string;
  status?: string;
  deletedAt?: unknown;
  metadata?: unknown;
};
export type ImageResultVariant = z.infer<typeof referenceSchema> & { url: string };
export type ImageResultVariants = {
  primary: ImageResultVariant;
  original: ImageResultVariant;
  export?: ImageResultVariant;
  maskComposited: boolean;
  warning?: string;
};

export class ImageResultVariantsError extends Error {
  readonly code = "IMAGE_RESULT_VARIANTS_INVALID";
  readonly status = 409;
  constructor() { super("图片版本关联无效或原件不可用，未提供错误的下载文件"); }
}

export function readImageResultMetadata(metadata: unknown): ImageResultMetadata | null {
  if (!metadata || typeof metadata !== "object" || !("imageResult" in metadata)) return null;
  const result = metadataSchema.safeParse(metadata.imageResult);
  if (!result.success) throw new ImageResultVariantsError();
  return result.data;
}

export function isAuxiliaryImageResult(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || !("imageResult" in metadata)) return false;
  const result = metadata.imageResult;
  return Boolean(result && typeof result === "object" && "version" in result && result.version === 1 && "role" in result
    && (result.role === "provider-original" || result.role === "export"));
}

export function imageResultVariantIds(asset: ImageResultAsset): string[] {
  const result = readImageResultMetadata(asset.metadata);
  return result ? [...new Set([result.original.assetId, result.export?.assetId].filter((id): id is string => Boolean(id) && id !== asset.id))] : [];
}

export function resolveImageResultVariants(primary: ImageResultAsset, related: readonly ImageResultAsset[]): ImageResultVariants {
  const result = readImageResultMetadata(primary.metadata);
  const available = (asset: ImageResultAsset) => (!asset.status || asset.status === "ready") && !asset.deletedAt;
  if (!available(primary)) throw new ImageResultVariantsError();
  const describe = (asset: ImageResultAsset): ImageResultVariant => ({ assetId: asset.id, url: `/api/assets/${asset.id}/content`, mimeType: asset.mimeType, filename: asset.filename });
  const find = (id: string) => {
    if (id === primary.id) return describe(primary);
    const asset = related.find(candidate => candidate.id === id);
    if (!asset || !available(asset) || !primary.taskId || asset.ownerUserId !== primary.ownerUserId || asset.taskId !== primary.taskId) throw new ImageResultVariantsError();
    return describe(asset);
  };
  return {
    primary: describe(primary),
    original: result ? find(result.original.assetId) : describe(primary),
    ...(result?.export ? { export: find(result.export.assetId) } : {}),
    maskComposited: result?.maskComposited ?? false,
    ...(result?.warning ? { warning: result.warning } : {}),
  };
}
