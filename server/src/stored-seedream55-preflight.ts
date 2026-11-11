import type { Database } from "./db";
import { ObjectStorage } from "./object-storage";
import { loadConfig } from "./config";
import { readSourceAssetObject } from "./asset-object-error";
import { readBoundedImage, validateSeedream55Reference } from "./seedream55-reference";
import { layerStudioTaskOptions, LAYER_STUDIO_MAX_REFERENCE_BYTES } from "../../shared/layer-studio-options";
import { ToolConfigurationError } from "./tool-configuration";
import { hashAssetContent } from "./asset-content-hash";

type Input = { userId: string; prompt: string; parameters?: Record<string, unknown>; sourceUrls: string[] };
export type LayerSourceSnapshot = { id: string; objectKey: string; mimeType: string; byteSize: number; sha256: string | null };
async function snapshots(db: Pick<Database, "query">, input: Input) {
  const result: LayerSourceSnapshot[] = [];
  for (const url of input.sourceUrls) {
    const id = /^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i.exec(url)?.[1];
    const source = id ? (await db.query<LayerSourceSnapshot>(`SELECT id,object_key AS "objectKey",mime_type AS "mimeType",byte_size::int AS "byteSize",content_sha256 AS sha256
      FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND deleted_at IS NULL`, [id, input.userId])).rows[0] : null;
    if (!source) throw new ToolConfigurationError("INVALID_SOURCE", "参考图片不存在或无权访问");
    if (!Number.isSafeInteger(source.byteSize) || source.byteSize < 1 || source.byteSize > LAYER_STUDIO_MAX_REFERENCE_BYTES) throw new ToolConfigurationError("INVALID_SOURCE", "参考图必须非空且不超过 30 MiB");
    result.push(source);
  }
  return result;
}
export async function preflightStoredSeedream55Task(db: Pick<Database, "query">, input: Input, runtime: {
  readSource?: (source: LayerSourceSnapshot) => Promise<Uint8Array>; validate?: typeof validateSeedream55Reference;
} = {}) {
  layerStudioTaskOptions(input.parameters ?? {}, input.prompt, input.sourceUrls.length);
  const sources = await snapshots(db, input);
  for (const source of sources) {
    const bytes = runtime.readSource ? await runtime.readSource(source) : await (async () => {
      const object = await readSourceAssetObject(new ObjectStorage(loadConfig()), source.objectKey);
      return readBoundedImage(object.Body!.transformToWebStream(), LAYER_STUDIO_MAX_REFERENCE_BYTES, source.byteSize);
    })();
    if (bytes.length !== source.byteSize) throw new ToolConfigurationError("INVALID_SOURCE", "参考图实际大小与存储记录不一致");
    if (source.sha256 && hashAssetContent(bytes) !== source.sha256) throw new ToolConfigurationError("INVALID_SOURCE", "参考图原件 hash 与存储记录不一致");
    try { await (runtime.validate ?? validateSeedream55Reference)({ bytes, mimeType: source.mimeType }); }
    catch (error) { throw new ToolConfigurationError("INVALID_SOURCE", error instanceof Error ? error.message : "参考图无法安全读取"); }
  }
  return sources;
}
export async function validateStoredSeedream55Snapshot(db: Pick<Database, "query">, input: Input, snapshot: LayerSourceSnapshot[]) {
  if (JSON.stringify(await snapshots(db, input)) !== JSON.stringify(snapshot)) throw new ToolConfigurationError("SOURCE_CHANGED", "参考图已变化，请重新提交；尚未扣费");
}
