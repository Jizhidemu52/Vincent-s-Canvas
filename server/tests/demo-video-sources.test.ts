import { describe, expect, test } from "bun:test";
import { createDemoProviderVideoSources, resolveOwnedDemoVideoSources } from "../src/demo-video-sources";
import { preflightVideoSources } from "../src/video-source-preparation";

const video = { id: "10000000-0000-4000-8000-000000000001", ownerUserId: "owner", mimeType: "video/mp4", bytes: new Uint8Array([1]), metadata: { durationMs: 5000, width: 1280, height: 720 } };
const assetPath = `/api/assets/${video.id}/content`;
describe("owned demo video source URLs", () => {
  test("reuses only a server-generated owned result URL without making local media public", () => {
    const asset = { ...video, upstreamUrl: "https://provider-cdn.example/result.mp4" };
    const owned = resolveOwnedDemoVideoSources([assetPath], "owner", new Map([[asset.id, asset]]));
    const grants = new Map();
    const result = createDemoProviderVideoSources(owned, "", grants);
    expect(result.sources[0]).toMatchObject({ publicUrl: "https://provider-cdn.example/result.mp4", durationMs: 5000, width: 1280, height: 720 });
    expect(result.accessTokens).toEqual([]);
    expect(grants.size).toBe(0);
    expect(preflightVideoSources("wan2.7", "continue", { videoMode: "extend", seconds: 6 }, result.sources).normalized.videoMode).toBe("extend");
  });

  test("client metadata cannot fabricate a reusable public URL or obtain another user's generated result", () => {
    const asset = { ...video, metadata: { ...video.metadata, upstreamUrl: "https://attacker.example/fake.mp4", publicUrl: "https://attacker.example/fake.mp4" } };
    const result = createDemoProviderVideoSources([asset], "", new Map());
    expect(result.sources[0]).not.toHaveProperty("publicUrl");
    expect(() => preflightVideoSources("wan2.7", "continue", { videoMode: "extend", seconds: 6 }, result.sources)).toThrow("公开 HTTPS");
    expect(() => resolveOwnedDemoVideoSources([assetPath], "other-user", new Map([[asset.id, { ...asset, upstreamUrl: "https://provider-cdn.example/result.mp4" }]]))).toThrow("无权访问");
    expect(() => resolveOwnedDemoVideoSources(["https://attacker.example/fake.mp4"], "owner", new Map())).toThrow();
  });

  test("only selected audio/video assets receive expiring grants; images remain on the official upload path", () => {
    const image = { ...video, id: "20000000-0000-4000-8000-000000000002", mimeType: "image/png" };
    const grants = new Map();
    const before = Date.now();
    const result = createDemoProviderVideoSources([image, video], "https://canvas.example", grants);
    expect(result.sources[0]?.publicUrl).toBe("asset://pending-image-upload");
    expect(result.accessTokens).toHaveLength(1);
    const publicUrl = new URL(result.sources[1]!.publicUrl!);
    expect(publicUrl.origin).toBe("https://canvas.example");
    expect(publicUrl.pathname).toBe(assetPath);
    expect(publicUrl.searchParams.get("video_access")).toBe(result.accessTokens[0]!);
    expect(grants.get(result.accessTokens[0])).toMatchObject({ assetId: video.id });
    expect(grants.get(result.accessTokens[0]).expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(grants.size).toBe(1);
  });
});
