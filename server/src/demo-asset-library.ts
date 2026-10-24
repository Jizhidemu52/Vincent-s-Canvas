import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { assetResponseHeaders, matchesAssetEtag } from "./asset-delivery";
import { assetPage, lightAssetMetadata, parseAssetListQuery } from "./asset-query";
import { createAssetThumbnailBytes } from "./asset-thumbnails";
import { demoAssetByteLength, demoAssetFields } from "./demo-state-store";

export const demoAssetPurgeAfter = (deletedAt: string) => new Date(Date.parse(deletedAt) + 30 * 86_400_000).toISOString();
export const canRestoreDemoAsset = (asset: { id: string; deletedAt?: string; bytes: Uint8Array }, now = Date.now()) => Boolean(asset.deletedAt && demoAssetByteLength(asset) && Date.parse(asset.deletedAt) + 30 * 86_400_000 > now);
type ListedAsset = { id: string; createdAt: string; deletedAt?: string | null; kind: string; filename: string; projectId?: string | null; prompt?: string | null; metadata: Record<string, unknown> };
export function demoAssetPage<T extends ListedAsset>(assets: T[], query: Record<string, unknown>, trash = false) {
  const input = parseAssetListQuery(query);
  const search = input.q?.toLocaleLowerCase();
  const time = (asset: T) => trash ? asset.deletedAt! : asset.createdAt;
  const compare = (a: { time: string; id: string }, b: { time: string; id: string }) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id);
  const direction = input.sort === 'oldest' ? 1 : -1;
  const rows = assets.filter(asset => (!input.kind || asset.kind === input.kind) && (!input.projectId || asset.projectId === input.projectId)
    && (!input.tag || Array.isArray(asset.metadata.tags) && asset.metadata.tags.includes(input.tag))
    && (!input.createdFrom || Date.parse(asset.createdAt) >= Date.parse(input.createdFrom))
    && (!input.createdBefore || Date.parse(asset.createdAt) < Date.parse(input.createdBefore))
    && (!search || [asset.filename, asset.prompt || "", asset.metadata.title, asset.metadata.tags, asset.metadata.source, asset.metadata.content].join(" ").toLocaleLowerCase().includes(search))
    && (!input.cursor || direction * compare({ time: time(asset), id: asset.id }, input.cursor) > 0))
    .sort((a, b) => direction * compare({ time: time(a), id: a.id }, { time: time(b), id: b.id }));
  const page = assetPage(rows.slice(0, input.limit + 1), input.limit, time);
  return { ...page, assets: page.assets.map(asset => ({ ...asset,
    canRecreate: [asset.prompt, asset.metadata.prompt, asset.metadata.recreatePath, asset.metadata.content].some(value => typeof value === 'string' && Boolean(value.trim())),
    prompt: null, metadata: lightAssetMetadata(asset.metadata) })) };
}

type MediaAsset = { id: string; bytes: Uint8Array; mimeType: string; filename: string };
const representations = new WeakMap<MediaAsset, { etag: string; mime: string }>();
export async function demoAssetContentResponse(asset: MediaAsset, request?: Request) {
  let representation = representations.get(asset);
  let bytes: Uint8Array | undefined;
  if (!representation) {
    bytes = asset.bytes;
    const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
    representation = { etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      mime: detected?.mime || (["text/plain", "application/json"].includes(asset.mimeType) ? asset.mimeType : "application/octet-stream") };
    representations.set(asset, representation);
  }
  const { etag, mime } = representation;
  const headers = { ...assetResponseHeaders(mime, asset.filename, request ? new URL(request.url).searchParams.get("download") === "1" : false), etag, vary: "Cookie" };
  if (matchesAssetEtag(request?.headers.get("if-none-match") || undefined, etag)) return new Response(null, { status: 304, headers });
  const body = bytes ?? asset.bytes;
  const view = body.buffer instanceof ArrayBuffer
    ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : Uint8Array.from(body); // SharedArrayBuffer must be detached from a fetch body.
  return new Response(view, { headers });
}

const sourceTokens = new WeakMap<MediaAsset, object>();
function sourceToken(asset: MediaAsset) {
  let token = sourceTokens.get(asset);
  if (!token) { token = {}; sourceTokens.set(asset, token); }
  return token;
}
const cache = new Map<string, { token: object; thumbnails: Record<256 | 1024, Buffer> }>();
const pending = new Set<string>();
const jobs: Array<() => Promise<void>> = [];
let running = 0;
function drain() {
  while (running < 2 && jobs.length) { running++; void jobs.shift()!().finally(() => { running--; drain(); }); }
}
export function scheduleDemoAssetThumbnails(asset: MediaAsset) {
  const token = sourceToken(asset);
  if (!asset.mimeType.startsWith("image/") || !demoAssetByteLength(asset) || pending.has(asset.id) || cache.get(asset.id)?.token === token) return;
  pending.add(asset.id);
  jobs.push(async () => {
    try {
      const thumbnails = await createAssetThumbnailBytes(asset.bytes);
      cache.set(asset.id, { token, thumbnails });
      while (cache.size > 128) cache.delete(cache.keys().next().value!);
    } catch (error) { console.warn("Demo asset thumbnail unavailable", asset.id, error instanceof Error ? error.message : "unknown"); }
    finally { pending.delete(asset.id); }
  });
  drain();
}
export function demoAssetThumbnail(asset: MediaAsset, width: 256 | 1024): MediaAsset {
  const cached = cache.get(asset.id);
  if (cached?.token === sourceToken(asset)) return { ...demoAssetFields(asset), bytes: cached.thumbnails[width], mimeType: "image/webp", filename: `${asset.filename}.thumb-${width}.webp` };
  scheduleDemoAssetThumbnails(asset);
  return asset;
}
