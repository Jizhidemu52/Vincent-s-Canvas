import { isPublicHttpsUrl } from "./apimart-upload";
import { createDemoPublicAssetUrl } from "./demo-public-assets";
import { videoSourceMetadata, type ProviderVideoSource } from "./video-models";

type DemoVideoAsset = { id: string; ownerUserId: string; mimeType: string; bytes: Uint8Array; upstreamUrl?: string; metadata?: Record<string, unknown> };
type AccessGrant = { assetId: string; expiresAt: number };

export function resolveOwnedDemoVideoSources<T extends DemoVideoAsset>(sourceUrls: string[], ownerUserId: string, assets: ReadonlyMap<string, T>): T[] {
  if (!Array.isArray(sourceUrls) || sourceUrls.length > 50) throw new Error("视频素材数量不能超过 50 个");
  return sourceUrls.map((sourceUrl) => {
    const id = typeof sourceUrl === "string" ? sourceUrl.match(/^\/api\/assets\/([0-9a-f-]+)\/content$/i)?.[1] : undefined;
    const source = id ? assets.get(id) : undefined;
    if (!source || source.ownerUserId !== ownerUserId || !source.bytes.byteLength) throw new Error("参考素材不存在或无权访问");
    return source;
  });
}

export function createDemoProviderVideoSources(sources: DemoVideoAsset[], publicOrigin: string, grants: Map<string, AccessGrant>) {
  const accessTokens: string[] = [];
  const providerSources: ProviderVideoSource[] = sources.map((source) => {
    // Only these numeric metadata fields may cross the trust boundary. In particular,
    // metadata.upstreamUrl/publicUrl never overrides a URL set by the server.
    const material = { mimeType: source.mimeType, bytes: source.bytes, ...videoSourceMetadata(source.metadata) };
    if (source.mimeType.startsWith("image/")) return { ...material, publicUrl: "asset://pending-image-upload" };
    if (source.upstreamUrl && isPublicHttpsUrl(source.upstreamUrl)) return { ...material, publicUrl: source.upstreamUrl };
    if (!isPublicHttpsUrl(publicOrigin)) return material;
    const accessToken = crypto.randomUUID();
    accessTokens.push(accessToken);
    grants.set(accessToken, { assetId: source.id, expiresAt: Date.now() + 30 * 60_000 });
    return { ...material, publicUrl: createDemoPublicAssetUrl(publicOrigin, source.id, accessToken) };
  });
  return { sources: providerSources, accessTokens };
}
