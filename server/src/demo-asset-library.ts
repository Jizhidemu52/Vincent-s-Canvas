import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { assetResponseHeaders, matchesAssetEtag } from "./asset-delivery";
import { assetPage, lightAssetMetadata, parseAssetListQuery } from "./asset-query";
import { createAssetThumbnailBytes } from "./asset-thumbnails";

type ListedAsset = { id: string; createdAt: string; kind: string; filename: string; projectId?: string | null; prompt?: string | null; metadata: Record<string, unknown> };
export function demoAssetPage<T extends ListedAsset>(assets: T[], query: Record<string, unknown>) {
  const input = parseAssetListQuery(query);
  const search = input.q?.toLocaleLowerCase();
  const rows = assets.filter(asset => (!input.kind || asset.kind === input.kind) && (!input.projectId || asset.projectId === input.projectId)
    && (!search || [asset.filename, asset.prompt || "", asset.metadata.title, asset.metadata.tags, asset.metadata.source, asset.metadata.content].join(" ").toLocaleLowerCase().includes(search))
    && (!input.cursor || asset.createdAt < input.cursor.time || asset.createdAt === input.cursor.time && asset.id < input.cursor.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const page = assetPage(rows.slice(0, input.limit + 1), input.limit);
  return { ...page, assets: page.assets.map(asset => ({ ...asset,
    canRecreate: [asset.prompt, asset.metadata.prompt, asset.metadata.recreatePath, asset.metadata.content].some(value => typeof value === 'string' && Boolean(value.trim())),
    prompt: null, metadata: lightAssetMetadata(asset.metadata) })) };
}

type MediaAsset = { id: string; bytes: Uint8Array; mimeType: string; filename: string };
const etags = new WeakMap<Uint8Array, string>();
export async function demoAssetContentResponse(asset: MediaAsset, request?: Request) {
  let etag = etags.get(asset.bytes);
  if (!etag) { etag = `"${createHash("sha256").update(asset.bytes).digest("hex")}"`; etags.set(asset.bytes, etag); }
  const detected = await fileTypeFromBuffer(asset.bytes).catch(() => undefined);
  const mime = detected?.mime || (["text/plain", "application/json"].includes(asset.mimeType) ? asset.mimeType : "application/octet-stream");
  const headers = { ...assetResponseHeaders(mime, asset.filename, request ? new URL(request.url).searchParams.get("download") === "1" : false), etag, vary: "Cookie" };
  if (matchesAssetEtag(request?.headers.get("if-none-match") || undefined, etag)) return new Response(null, { status: 304, headers });
  return new Response(Uint8Array.from(asset.bytes).buffer, { headers });
}

const cache = new Map<string, { source: Uint8Array; thumbnails: Record<256 | 1024, Buffer> }>();
const pending = new Set<string>();
const jobs: Array<() => Promise<void>> = [];
let running = 0;
function drain() {
  while (running < 2 && jobs.length) { running++; void jobs.shift()!().finally(() => { running--; drain(); }); }
}
export function scheduleDemoAssetThumbnails(asset: MediaAsset) {
  if (!asset.mimeType.startsWith("image/") || !asset.bytes.length || pending.has(asset.id) || cache.get(asset.id)?.source === asset.bytes) return;
  pending.add(asset.id);
  jobs.push(async () => {
    try {
      const thumbnails = await createAssetThumbnailBytes(asset.bytes);
      cache.set(asset.id, { source: asset.bytes, thumbnails });
      while (cache.size > 128) cache.delete(cache.keys().next().value!);
    } catch (error) { console.warn("Demo asset thumbnail unavailable", asset.id, error instanceof Error ? error.message : "unknown"); }
    finally { pending.delete(asset.id); }
  });
  drain();
}
export function demoAssetThumbnail(asset: MediaAsset, width: 256 | 1024): MediaAsset {
  const cached = cache.get(asset.id);
  if (cached?.source === asset.bytes) return { ...asset, bytes: cached.thumbnails[width], mimeType: "image/webp", filename: `${asset.filename}.thumb-${width}.webp` };
  scheduleDemoAssetThumbnails(asset);
  return asset;
}
