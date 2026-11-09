import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { isPublicHttpUrl, validateApiMartGenerationImage } from "./apimart-upload";
import { normalizeAssetMime, validateAssetUpload } from "./asset-delivery";
import type { Cache, Database } from "./db";
import type { ObjectStorage } from "./object-storage";

export const PROVIDER_IMAGE_PATH = "/api/provider-images";
const ttlSeconds = 1800;
const tokenPattern = /^[a-f0-9]{64}$/;
const cacheKey = (token: string) => `provider-image:${token}`;
const grantSchema = z.object({
  version: z.literal(1), taskId: z.string().uuid(), userId: z.string().uuid(), assetId: z.string().uuid(),
  objectKey: z.string().min(1), mimeType: z.string().min(1), filename: z.string().min(1),
  etag: z.string().min(1), length: z.number().int().positive().max(20 * 1024 * 1024),
  expiresAt: z.number().int().positive(),
});
type Grant = z.infer<typeof grantSchema>;
type Binding = { taskId: string; userId: string; assetId: string; objectKey: string };
type BoundAsset = { object_key: string; mime_type: string; filename: string; byte_size: string | number };

export class ProviderImageAccessError extends Error {
  readonly code: string;
  constructor(readonly status: 404 | 503) {
    super(status === 404 ? "参考图直链不存在或已失效" : "参考图直链暂时不可用");
    this.name = "ProviderImageAccessError";
    this.code = status === 404 ? "PROVIDER_IMAGE_NOT_FOUND" : "PROVIDER_IMAGE_UNAVAILABLE";
  }
}

/** This is a public origin, not an object-storage URL and not a signing endpoint. */
export function normalizeProviderImageOrigin(raw?: string): string {
  const value = raw?.trim() || "";
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!isPublicHttpUrl(value) || url.username || url.password || url.pathname !== "/"
      || value.includes("?") || value.includes("#")) throw new Error();
    return url.origin;
  } catch { throw new Error("PROVIDER_IMAGE_PUBLIC_ORIGIN 必须为公开 HTTP(S) 域名，不含路径、账号、查询或片段"); }
}

export class ProviderImageAccess {
  private readonly origin: string;
  constructor(private db: Pick<Database, "query">, private cache: Pick<Cache, "get" | "set">,
    private storage: ObjectStorage, origin: string) {
    this.origin = normalizeProviderImageOrigin(origin);
  }

  private async boundAsset(binding: Binding, executionToken?: string): Promise<BoundAsset> {
    // A provider may fetch after the worker yielded its polling lease. Only
    // issuance requires that lease; every read still requires a live task and
    // exactly the same employee, source membership and ready original object.
    const result = await this.db.query<BoundAsset>(
      `SELECT a.object_key,a.mime_type,a.filename,a.byte_size FROM assets a JOIN tasks t ON t.id=$1
       JOIN users u ON u.id=t.user_id
       WHERE a.id=$3 AND a.owner_user_id=$2 AND a.object_key=$4
         AND a.status='ready' AND a.deleted_at IS NULL AND a.kind='image'
         AND t.user_id=$2 AND t.status='processing'
         AND u.status='active' AND u.deleted_at IS NULL
         AND t.source_urls @> $5::jsonb
         ${executionToken === undefined ? "" : "AND t.execution_token=$6 AND t.lease_expires_at>now()"}`,
      [binding.taskId, binding.userId, binding.assetId, binding.objectKey,
        JSON.stringify([`/api/assets/${binding.assetId}/content`]), ...(executionToken === undefined ? [] : [executionToken])],
    ).catch(() => { throw new ProviderImageAccessError(503); });
    if (!result.rows[0]) throw new ProviderImageAccessError(404);
    return result.rows[0];
  }

  async issue(input: { taskId: string; userId: string; executionToken: string; source: {
    assetId: string; objectKey: string; bytes: Uint8Array; mimeType: string; filename?: string; etag?: string;
  } }): Promise<string> {
    if (!this.origin || !input.executionToken) throw new ProviderImageAccessError(503);
    const { source } = input;
    validateApiMartGenerationImage(source);
    const mimeType = await validateAssetUpload(source.bytes, source.mimeType);
    if (mimeType !== normalizeAssetMime(source.mimeType)) throw new ProviderImageAccessError(404);
    const binding: Binding = { taskId: input.taskId, userId: input.userId, assetId: source.assetId, objectKey: source.objectKey };
    const asset = await this.boundAsset(binding, input.executionToken);
    if (normalizeAssetMime(asset.mime_type) !== mimeType || Number(asset.byte_size) !== source.bytes.byteLength) throw new ProviderImageAccessError(404);
    const head = await this.storage.head(source.objectKey, { abortSignal: AbortSignal.timeout(30_000) })
      .catch(() => { throw new ProviderImageAccessError(503); });
    if (!head.ETag || head.ContentLength !== source.bytes.byteLength || source.etag && source.etag !== head.ETag) throw new ProviderImageAccessError(404);
    // Worker sources carry the ETag returned together with their original
    // bytes. A caller without that provenance must prove the bytes separately.
    if (!source.etag) {
      let body: Readable | undefined;
      try {
        const object = await this.storage.get(source.objectKey, { ifMatch: head.ETag, abortSignal: AbortSignal.timeout(30_000) });
        body = object.Body as Readable | undefined;
        if (!body || object.ETag !== head.ETag || object.ContentLength !== source.bytes.byteLength) throw new ProviderImageAccessError(404);
        const digest = createHash("sha256");
        let length = 0;
        for await (const part of body) {
          length += part.length;
          if (length > source.bytes.byteLength) throw new ProviderImageAccessError(404);
          digest.update(part);
        }
        if (length !== source.bytes.byteLength || digest.digest("hex") !== createHash("sha256").update(source.bytes).digest("hex")) throw new ProviderImageAccessError(404);
      } catch (error) { throw error instanceof ProviderImageAccessError ? error : new ProviderImageAccessError(503); }
      finally { body?.destroy(); }
    }
    await this.boundAsset(binding, input.executionToken);
    const token = randomBytes(32).toString("hex");
    const grant = grantSchema.parse({ version: 1, ...binding, mimeType, filename: asset.filename,
      etag: head.ETag, length: source.bytes.byteLength, expiresAt: Date.now() + ttlSeconds * 1000 });
    await this.cache.set(cacheKey(token), JSON.stringify(grant), { EX: ttlSeconds })
      .catch(() => { throw new ProviderImageAccessError(503); });
    return `${this.origin}${PROVIDER_IMAGE_PATH}/${token}/image`;
  }

  async resolve(token: string) {
    if (!this.origin || !tokenPattern.test(token)) throw new ProviderImageAccessError(404);
    const cached = await this.cache.get(cacheKey(token)).catch(() => { throw new ProviderImageAccessError(503); });
    let grant: Grant;
    try { grant = grantSchema.parse(JSON.parse(cached || "null")); }
    catch { throw new ProviderImageAccessError(404); }
    if (grant.expiresAt <= Date.now()) throw new ProviderImageAccessError(404);
    const asset = await this.boundAsset(grant);
    if (Number(asset.byte_size) !== grant.length || normalizeAssetMime(asset.mime_type) !== grant.mimeType) throw new ProviderImageAccessError(404);
    return { asset: { object_key: grant.objectKey, mime_type: grant.mimeType, filename: grant.filename },
      expectedObject: { etag: grant.etag, length: grant.length } };
  }
}
